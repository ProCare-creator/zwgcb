// Local documents on zwgcb.cn. GitHub Pages continues to use its original store.
const PRIMARY_KEY='zwgcb-idb-primary';
const disk={db:null,backupUntil:0,persistent:'查询中',notice:''};
function blankCols(){return Object.fromEntries(COLS.map(c=>[c,Object.create(null)]));}
function openJournal(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(accountUser?'zwgcb-u-'+accountUser.id:'zwgcb',1);
    let blocked=false;
    req.onblocked=()=>{blocked=true;reject(Error('blocked'));};
    req.onupgradeneeded=()=>{req.result.createObjectStore('docs');req.result.createObjectStore('control');};
    req.onerror=()=>reject(req.error);
    req.onsuccess=()=>{if(blocked){req.result.close();return;}req.result.onversionchange=()=>req.result.close();resolve(req.result);};
  });
}
// The verified snapshot and its cutover marker commit together, even across tabs or refresh.
async function backupFingerprint(raw){
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw))),b=>b.toString(16).padStart(2,'0')).join('');
}
function readOrMigrate(db,wasPrimary,legacy,hash,skipMerge=false){
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(['control','docs'],'readwrite'),docs=tx.objectStore('docs'),ctl=tx.objectStore('control');
    let marker,source,raw,count=0,seen=0,error,mergedCount=null;let cols=blankCols();
    const abort=e=>{error=e;tx.abort();};
    tx.onabort=()=>reject(error||tx.error||Error('aborted'));
    tx.oncomplete=()=>resolve({cols,marker,mergedCount});
    const read=ctl.get('primary');
    read.onsuccess=()=>{try{
      marker=read.result;
      if(!marker){
        if(wasPrimary)throw Error('primary-missing');
        raw=legacy;source=raw===null?{}:JSON.parse(raw);
        if(!source||typeof source!=='object'||Array.isArray(source))throw Error('invalid-backup');
        for(const c of COLS){
          if(c in source&&(!source[c]||typeof source[c]!=='object'||Array.isArray(source[c])))throw Error('invalid-backup');
          for(const [id,value] of Object.entries(source[c]||{})){docs.put(value,[c,id]);count++;}
        }
      }
      const cur=docs.openCursor();cur.onsuccess=()=>{try{
        const row=cur.result;
        if(row){const [c,id]=row.key;if(!COLS.includes(c)||typeof id!=='string')throw Error('unknown-key');
          if(!marker&&JSON.stringify(source[c]?.[id])!==JSON.stringify(row.value))throw Error('verify');
          cols[c][id]=row.value;seen++;row.continue();return;}
        if(!marker){
          if(seen!==count||raw!==localStorage.getItem(LS_KEY))throw Error('verify');
          marker={until:raw===null?0:Date.now()+30*86400000,hash};ctl.put(marker,'primary');
        }else if(!skipMerge&&legacy!==null&&hash!==marker.hash){
          const old=JSON.parse(legacy);
          if(!old||typeof old!=='object'||Array.isArray(old)||COLS.some(c=>c in old&&(!old[c]||typeof old[c]!=='object'||Array.isArray(old[c]))))throw Error('invalid-backup');
          const del=readDel(),next=mergeSnap({cols,del},{cols:old,del}).cols;
          mergedCount=0;
          for(const c of COLS)for(const id of new Set([...Object.keys(cols[c]),...Object.keys(next[c])])){
            if(JSON.stringify(cols[c][id])===JSON.stringify(next[c][id]))continue;
            if(Object.hasOwn(next[c],id))docs.put(next[c][id],[c,id]);else docs.delete([c,id]);
            mergedCount++;
          }
          if(legacy!==localStorage.getItem(LS_KEY))throw Error('backup-changed');
          cols=next;marker={...marker,hash,until:marker.until||Date.now()+30*86400000};ctl.put(marker,'primary');
        }
      }catch(e){abort(e);}};
    }catch(e){abort(e);}};
  });
}
function writeRows(changes){
  return new Promise((resolve,reject)=>{
    const tx=disk.db.transaction(accountUser?['docs','control']:['docs'],'readwrite'),docs=tx.objectStore('docs');
    const markers=accountUser?tx.objectStore('control'):null,now=Date.now();
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error('aborted'));
    try{for(const [c,id,value] of changes){if(value===undefined){docs.delete([c,id]);markers?.put(now,['vaultDeleted',c,id]);}else{docs.put(value,[c,id]);markers?.delete(['vaultDeleted',c,id]);}}}
    catch(e){tx.abort();reject(e);}
  });
}
async function requestPersistence(){
  try{disk.persistent=navigator.storage?.persist?(await navigator.storage.persist()?'已获准':'未获准'):'浏览器不支持';}
  catch{disk.persistent='未获准';}
  const el=$('#disk-persist');if(el)el.textContent=disk.persistent;
}
async function startJournal(){
  let db,wasPrimary=false;
  try{
    wasPrimary=localStorage.getItem(PRIMARY_KEY)==='1';
    db=await openJournal();
    const legacy=localStorage.getItem(LS_KEY);
    const hash=legacy===null?null:await backupFingerprint(legacy);
    let result;
    try{result=await readOrMigrate(db,wasPrimary,legacy,hash);}
    catch(e){if(!wasPrimary)throw e;result=await readOrMigrate(db,true,legacy,hash,true);disk.notice='旧版页面的修改未合并，已保留旧存储，下次打开会重试。';}
    const {cols,marker,mergedCount}=result;
    if(mergedCount!==null)disk.notice='合并了旧版页面写入的 '+mergedCount+' 条修改。';
    S=cols;disk.db=db;mode='idb';
    try{localStorage.setItem(PRIMARY_KEY,'1');
      if(marker.until&&localStorage.getItem(LS_KEY)!==null){
        if(Date.now()<marker.until)disk.backupUntil=marker.until;
        else{
          const raw=localStorage.getItem(LS_KEY);
          if(raw===legacy&&hash===marker.hash)localStorage.removeItem(LS_KEY);
          else if(!disk.notice)disk.notice='旧格式备份有新改动，已保留，下次打开会重试。';
        }
      }
    }catch{/* IndexedDB remains authoritative even if localStorage is full. */}
  }catch(e){
    if(db)db.close();
    if(wasPrimary){disk.notice='本机数据库暂时打不开。请关闭其他标签页后重试；旧备份不会覆盖新记录。';render();return;}
    try{
      const raw=localStorage.getItem(LS_KEY);
      if(raw!==null){const s=JSON.parse(raw);if(!s||typeof s!=='object'||Array.isArray(s)||COLS.some(c=>c in s&&(!s[c]||typeof s[c]!=='object'||Array.isArray(s[c]))))throw Error();}
    }catch{disk.notice='旧格式记录无法读取。原数据已保留，暂未开放写入，请检查浏览器存储后重试。';render();return;}
    disk.notice='IndexedDB 不可用或迁移未通过核对，继续使用原来的 localStorage。';
    await useLocal();return;
  }
  await convertChatDrafts();ready=true;refresh();migrateHyps();
}
function storageSize(bytes){
  return bytes<1024?bytes+' B':bytes<1048576?(bytes/1024).toFixed(1)+' KiB':(bytes/1048576).toFixed(2)+' MiB';
}
function diskInfo(){
  if(!accountHost)return '';
  let count=0,bytes=0;const enc=new TextEncoder();
  for(const c of COLS)for(const v of Object.values(S[c])){count++;bytes+=enc.encode(JSON.stringify(v)).length;}
  const size=storageSize(bytes);
  return '<div id="disk-info"><p>本机存储：'+(mode==='idb'?'IndexedDB':'localStorage')+' · '+count+' 条记录 · '+size+'</p><p class="fine">大小按记录内容计算。持久存储：<span id="disk-persist">'+disk.persistent+'</span></p>'+(disk.backupUntil?'<p class="fine">旧格式备份保留到 '+md(ymd(new Date(disk.backupUntil)))+'，到期后首次打开时清理。</p>':'')+(disk.notice?'<p class="warn">'+disk.notice+'</p>':'')+'</div>';
}
