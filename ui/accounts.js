const acct={view:'',overview:null,note:'',pending:null,invite:null,busy:false};
async function acctApi(path,body){
 const r=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',cache:'no-store',headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const j=await r.json();if(!r.ok){const c=j.error?.code;throw Error(c==='locked'?'尝试过多，请在 '+Math.ceil(j.error.retryAfter/60)+' 分钟后重试。':({invalid_credentials:'用户名、凭证或邀请码不正确，或账号已停用。',invalid_reset:'重置已过期，请重新输入恢复码。',no_session:'登录已过期，请刷新后重新登录。',forbidden:'此账号没有权限。',protected_admin:'不能对管理员执行此操作。',invalid:'请检查输入的格式。',accounts_unavailable:'账号服务暂不可用；仍可在本机记录。'})[c]||'请求失败，请稍后重试。');}return j;
}
function acctDbKeys(id,keys){
 return new Promise((resolve,reject)=>{const q=indexedDB.open('zwgcb-u-'+id,1);q.onupgradeneeded=()=>{q.result.createObjectStore('control');q.result.createObjectStore('docs');};q.onerror=()=>reject(q.error);q.onsuccess=()=>{const db=q.result,t=db.transaction('control','readwrite');t.objectStore('control').put(keys,'accountKeys');t.oncomplete=()=>{db.close();resolve();};t.onabort=()=>{db.close();reject(t.error);};};});
}
function acctReset(){acct.note='';acct.view='';acct.invite=null;acct.overview=null;acct.pending=null;}
function acctButton(a,label,attr=''){return '<button class="btn ghost sm" type="button" data-account="'+a+'" '+attr+'>'+label+'</button>';}
const acctField=(id,label,type='text',attrs='')=>'<label class="f">'+label+'<input id="ac-'+id+'" type="'+type+'" '+attrs+'></label>';
function accountCard(){
 if(!accountHost)return '';
 const v=acct.view,n=accountUser;
 let h=n?'<p>当前账号：<b>'+esc(n.username)+'</b> '+esc(n.nickname||'')+'</p>':'<p>用邀请码注册，也可以不登录，继续只存本机。</p>';
 if(!n)h+='<p class="fine">云端同步开放后，记录会在这台设备上加密，再存到 zwgcb.cn。管理员能看到用户名、注册时间、最近使用时间和占用空间，看不到记录内容。当前版本只提供账号，记录还未上传。</p>';
 if(!v)h+=n?acctButton('password','修改密码')+acctButton('logout','退出登录')+(n.role==='admin'?acctButton('manage','管理账号和邀请码'):''):acctButton('login','登录')+acctButton('register','用邀请码注册')+acctButton('recover','忘记密码')+(!AI_ON?'<details><summary>已有访问口令</summary>'+acctField('legacy','访问口令','password')+acctButton('legacy','验证并保存')+'</details>':'');
 else if(v==='receipt'){h+='<p>注册成功。请抄下恢复码，离开后不会再显示。如果密码和恢复码都丢了，云端记录无法解开。</p><code id="ac-receipt">'+esc(acct.pending.code)+'</code><label><input type="checkbox" id="ac-ack">我已抄下恢复码</label>'+acctButton('ack','继续登录','disabled');}
 else if(v==='logout')h+='<p>退出后，此账号的数据不会出现在其他账号中。</p>'+acctButton('keep','保留这台设备上的记录')+acctButton('clear','同时清除这台设备上的记录');
 else if(v==='manage'&&n?.role==='admin'&&acct.overview){
  const o=acct.overview,fmt=x=>new Date(x).toLocaleDateString('zh-CN');
  h+='<h3>数据库总量</h3><p class="'+(o.db_bytes>400e6?'warn':'fine')+'">'+(o.db_bytes/1e6).toFixed(2)+' / 500 MB</p><h3>邀请码</h3>'+acctButton('issue','生成邀请码');
  if(acct.invite)h+='<p>仅本次显示：<code>'+esc(acct.invite)+'</code> '+acctButton('copy','复制')+'</p>';
  for(const x of o.invites)h+='<p>'+fmt(x.expires_at)+' 到期 · '+(x.used_by?'已被 '+esc(x.used_by)+' 使用':x.revoked?'已撤销':x.expires_at<=Date.now()?'已过期':'未使用 '+acctButton('revoke','撤销','data-id="'+esc(x.id)+'"'))+'</p>';
  h+='<h3>用户</h3>';for(const u of o.users){const attr='data-id="'+esc(u.id)+'"';h+='<article class="card"><b>'+esc(u.username)+'</b> '+esc(u.nickname)+' · '+(u.disabled?'已停用':u.role==='admin'?'管理员':'已启用')+'<p class="fine">注册 '+fmt(u.created_at)+' · 最近使用 '+fmt(u.last_seen)+'<br>云端 '+u.doc_count+' 条 · '+u.used_bytes+' B，配额 '+(u.quota_bytes/1048576)+' MiB</p>'+acctButton('quota','改配额',attr)+(u.role==='admin'?'':acctButton(u.disabled?'enable':'disable',u.disabled?'启用':'停用',attr)+acctButton('delete','删除账号',attr))+'</article>';}
 }else{
  if(v==='register')h+='<p class="warn">同步用的密码和恢复码都丢失，云端记录就无法解开。请妥善保管恢复码。</p>'+acctField('invite','邀请码','password','autocomplete="off"');
  if(v!=='password')h+=acctField('user','用户名（3–20 位小写字母、数字或下划线）','text','autocomplete="username" maxlength="20" autocapitalize="none"');
  if(v==='register')h+=acctField('nick','昵称（可选，最多 12 字）');
  if(v==='recover')h+=acctField('code','恢复码','password','autocomplete="off"');
  if(v==='password')h+=acctField('old','当前密码','password','autocomplete="current-password"');
  h+=acctField('pass',v==='login'?'密码':'新密码（至少 8 位）','password',v==='login'?'autocomplete="current-password"':'autocomplete="new-password"');
  if(v!=='login')h+=acctField('confirm','再输入一次新密码','password','autocomplete="new-password"');
  h+=acctButton('submit',({login:'登录',register:'注册',password:'保存新密码',recover:'重置密码'})[v]);
 }
 if(v&&v!=='receipt')h+=acctButton('back','返回');
 return '<section class="card" id="account-card"><h2 class="stage">账号</h2>'+h+'<p class="fine" role="status" id="ac-note">'+esc(acct.note)+'</p></section>';
}
function acctPaint(){const el=$('#account-card');if(el)el.outerHTML=accountCard();if(acct.view==='receipt'){
 const panel=$('#account-card'),d=document.createElement('dialog');d.setAttribute('aria-label','抄下恢复码');d.append(...panel.childNodes);d.addEventListener('cancel',e=>e.preventDefault());panel.append(d);d.showModal();}}
async function acctEnter(username,p){
 const j=await acctApi('auth/login',{username,authKey:p.authKey});
 try{const raw=await accountCrypto.unwrap(p.kek,j.wrapped_keys);try{await acctDbKeys(j.user.id,await accountCrypto.keys(raw));}finally{raw.fill(0);}}
 catch{await acctApi('auth/logout',{});throw Error('无法在这台设备上保存钥匙，未完成登录。');}
 nativeStore.setItem(activeKey,JSON.stringify(j.user));location.replace('#settings');location.reload();
}
async function acctAction(a,el){
 const val=k=>$('#ac-'+k)?.value||'',user=val('user').trim(),pass=val('pass'),v=acct.view,C=accountCrypto;
 if(['login','register','recover','password','logout','back'].includes(a)){acctReset();if(a!=='back')acct.view=a;acctPaint();return;}
 if(a==='manage'||['issue','revoke','quota','delete','disable','enable','copy'].includes(a)){
  if(accountUser?.role!=='admin')return;
  if(a==='copy'){await navigator.clipboard.writeText(acct.invite);return;}
  acct.invite=null;if(a==='issue')acct.invite=(await acctApi('admin/invite',{})).code;
  if(a==='revoke')await acctApi('admin/revoke',{id:el.dataset.id});
  if(['quota','delete','disable','enable'].includes(a)){const id=el.dataset.id,u=acct.overview.users.find(x=>x.id===id),args={action:a,id};
   if(a==='delete'){args.confirm=prompt('永久删除云端数据，无法恢复。请输入用户名 '+u.username+' 确认：');if(args.confirm!==u.username)return;}
   if(a==='quota'){const s=prompt('新配额（MiB）',String(u.quota_bytes/1048576));if(s===null)return;if(!/^[0-9]+$/.test(s))throw Error('配额须为非负整数。');args.bytes=Number(s)*1048576;}
   await acctApi('admin/user',args);}
  acct.overview=await acctApi('admin/overview');acct.view='manage';acctPaint();return;
 }
 if(a==='legacy'){const token=val('legacy').trim();const r=await fetch('/api/health',{headers:{Authorization:'Bearer '+token}});if(!r.ok)throw Error('访问口令未通过验证。');localStorage.setItem('zwgcb-ai',JSON.stringify({token}));location.reload();return;}
 if(a==='keep'||a==='clear'){
  async function clearDevice(){
   if(!ready||!disk.db||!navigator.locks||form?.dirty)throw Error('无法确认记录已保存，请选择保留记录退出。');
   const deny=()=>{throw Error('有未上传的记录或草稿，请先同步。当前可选择保留记录退出。');};
   if(COLS.some(c=>Object.keys(S[c]).length)||Object.keys(drafts).length||Object.keys(readDel()).length)deny();
   releaseLease();await leaseHeld;
   try{await navigator.locks.request(deviceLease,{ifAvailable:true},async lock=>{
    if(!lock)throw Error('请关闭此账号的其他标签页，再清除本机记录。');
    const count=await new Promise((ok,no)=>{const q=disk.db.transaction('docs').objectStore('docs').count();q.onsuccess=()=>ok(q.result);q.onerror=()=>no(q.error);});
    if(count||Object.keys(JSON.parse(localStorage.getItem(LS_DRAFT)||'{}')).length||Object.keys(readDel()).length)deny();
    await acctApi('auth/logout',{});disk.db.close();await new Promise((ok,no)=>{const q=indexedDB.deleteDatabase('zwgcb-u-'+accountUser.id);q.onsuccess=ok;q.onerror=no;});
    for(const k of Object.keys(nativeStore))if(k.endsWith(accountSuffix))nativeStore.removeItem(k);
    nativeStore.removeItem(activeKey);location.reload();
   });}catch(e){await shareDevice();throw e;}
  }
  if(a==='clear')return clearDevice();
  await acctApi('auth/logout',{});nativeStore.removeItem(activeKey);

  location.reload();return;
 }
 if(a==='ack'){if(!$('#ac-ack')?.checked)return;return acctEnter(acct.pending.username,acct.pending.p);}
 if(a!=='submit')return;
 if(v!=='password'&&!/^[a-z0-9_]{3,20}$/.test(user))throw Error('用户名格式不正确。');
 if(v!=='login'&&(pass.length<8||pass!==val('confirm')))throw Error('密码至少 8 位，两次输入必须一致。');
 const derive=async(u,pw)=>C.password(pw,(await acctApi('auth/salt?u='+encodeURIComponent(u))).kdf_salt);
 if(v==='login')return acctEnter(user,await derive(user,pass));
 const salt=C.salt(),p=await C.password(pass,salt);let raw;
 try{
 if(v==='register'){const code=await C.code(),rec=await C.recovery(code);raw=C.data();
 await acctApi('auth/register',{username:user,nickname:val('nick'),invite:val('invite'),kdf_salt:salt,authKey:p.authKey,wrapped_keys:await C.wrap(p.kek,raw),recovery_wrapped:await C.wrap(rec.kek,raw),recoveryAuth:rec.auth});
 acct.pending={code,username:user,p};acct.view='receipt';acctPaint();return;}
 if(v==='recover'){const rec=await C.recovery(val('code').trim());const j=await acctApi('auth/recover/start',{username:user,recoveryAuth:rec.auth});raw=await C.unwrap(rec.kek,j.recovery_wrapped);
 await acctApi('auth/recover/finish',{token:j.token,kdf_salt:salt,authKey:p.authKey,wrapped_keys:await C.wrap(p.kek,raw)});
 }else if(v==='password'){const current=await derive(accountUser.username,val('old'));const j=await acctApi('auth/keys', {currentAuth:current.authKey});raw=await C.unwrap(current.kek,j.wrapped_keys);
 await acctApi('auth/password',{currentAuth:current.authKey,authKey:p.authKey,kdf_salt:salt,wrapped_keys:await C.wrap(p.kek,raw)});}
 acctReset();acct.note='密码已更新，其他设备需要重新登录。';acctPaint();
 }finally{raw?.fill(0);}
}
document.addEventListener('change',e=>{if(e.target.id==='ac-ack')$('#account-card [data-account="ack"]').disabled=!e.target.checked;});
document.addEventListener('click',async e=>{const el=e.target.closest?.('[data-account]');if(!el||acct.busy)return;acct.busy=true;el.disabled=true;const n=$('#ac-note');if(n)n.textContent='处理中…';
 try{await acctAction(el.dataset.account,el);if(n?.isConnected)n.textContent='';}
 catch(err){if(n?.isConnected)n.textContent=err.name==='TypeError'?'连接失败，请检查网络后重试。':err.message;}
 finally{acct.busy=false;el.disabled=false;}});
