// Optional browser acceptance: PLAYWRIGHT_PATH, CHROME_PATH and QA_OUTPUT can override defaults.
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const {execFileSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),out=process.env.QA_OUTPUT||require('node:os').tmpdir();
const old=execFileSync('git',['show','97d55e7:index.html'],{cwd:root,maxBuffer:2e6}).toString();
const current=fs.readFileSync(path.join(root,'index.html'),'utf8');
let html=old;
const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html;charset=utf-8','cache-control':'no-store'});res.end(html);});
const day='2026-11-18',at=day+'T10:00:00Z';
function chat(id,text){return {id,title:'虚构聊天 '+id,created:at,updated:at,cards:{},messages:[{role:'user',at,content:text}]};}
const example={app:'自我观察本',days:{[day]:{date:day,caps:[],preds:[{id:'p1',text:'午前散步',at,src:'morning'}],skip:null,evening:null}},hyps:{h1:{id:'h1',no:1,text:'虚构：午前散步可能更容易开始写作',status:'test',created:day,ev:[],history:[]}},weeks:{'2026-11-16':{dir:'虚构周观察',said:[],did:[]}},events:{e1:{id:'e1',date:day,title:'虚构事件'}},archives:{a1:{id:'a1',date:day,title:'虚构存档',data:{}}},meta:{counters:{hypSeq:1},'chat:one':chat('one','虚构聊天正文')}};
const count=o=>['days','hyps','weeks','events','archives','meta'].reduce((n,k)=>n+Object.keys(o[k]).length,0);
(async()=>{
 fs.mkdirSync(out,{recursive:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined});
 try{
 const ctx=await browser.newContext({viewport:{width:412,height:860},locale:'zh-CN',timezoneId:'Asia/Shanghai',serviceWorkers:'block'}),p=await ctx.newPage(),errors=[];
 p.on('pageerror',e=>{errors.push(e.message);console.error('Page error:',e.message);});await p.clock.setFixedTime(new Date(at));
 const settings=async()=>{await p.goto(url+'/#settings');await p.locator('#settings-data').waitFor();};
 const imp=async o=>{await p.locator('#importFile').setInputFiles({name:'synthetic.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(o))});await p.waitForFunction(()=>document.querySelector('#toast').textContent.startsWith('导入了'));};
 const exp=async()=>{const dl=p.waitForEvent('download');await p.locator('[data-act=export]').click();const f=await dl;const o=JSON.parse(fs.readFileSync(await f.path()));delete o.exportedAt;return o;};
 const snap=async name=>{await p.locator('#settings-data').scrollIntoViewIfNeeded();await p.locator('#settings-data').screenshot({path:path.join(out,name+'.png')});};
 const views=async()=>{const v={};for(const r of ['review','pred','capture','more','week','hyps','ai','chat?id=one','settings']){
 await p.goto(url+'/#'+r);await p.waitForFunction(()=>document.querySelector('#view').dataset.view&&document.querySelector('#view').textContent.length>10);
 v[r]=await p.locator('#view').evaluate(n=>{const a=n.cloneNode(true);a.querySelector('#disk-info')?.remove();const chat=a.querySelector('#settings-chat p.fine');if(chat?.textContent.startsWith('全部记录约'))chat.remove();return a.textContent;});
 }return v;};
 await settings();await imp(example);const before=await exp();assert.equal(count(before),7);const oldViews=await views();const backup=await p.evaluate(()=>localStorage.getItem('zwgcb-data-v1'));
 // Interrupt an actual native verification cursor with a navigation while the transaction is active.
 await p.addInitScript(()=>{window.resumedMigration=sessionStorage.interrupted==='yes';const orig=IDBCursor.prototype.continue;IDBCursor.prototype.continue=function(...args){if(!sessionStorage.interrupted&&this.source.name==='docs'){sessionStorage.interrupted='yes';location.reload();}return orig.apply(this,args);};});
 html=current;await p.reload({waitUntil:'commit'});try{await p.waitForFunction(()=>window.resumedMigration&&document.querySelector('#disk-info')?.textContent.startsWith('本机存储：IndexedDB'),null,{timeout:10000});}catch(e){console.log(await p.evaluate(()=>[location.hash,window.resumedMigration,sessionStorage.interrupted,document.querySelector('#view').innerText.slice(0,400)]));throw e;}
 assert.deepEqual(await exp(),before);assert.equal(await p.evaluate(()=>localStorage.getItem('zwgcb-data-v1')),backup);
 assert.deepEqual(await views(),oldViews);await snap('6a-migrated');console.log('OK: 7 records, 6 collections, 9 views, identical exports, migration interrupted and resumed');
 const big={days:{},meta:{}};for(let i=0;i<24;i++)big.meta['chat:large'+i]=chat('large'+i,('虚构'+i+' ').repeat(36000));
 const bytes=Buffer.byteLength(JSON.stringify(big.meta));assert.ok(bytes>5*1024*1024);
 await p.evaluate(()=>document.querySelector('#toast').textContent='');let t=performance.now();await imp(big);const writeMs=Math.round(performance.now()-t);
 t=performance.now();await p.reload();await p.locator('#disk-info').waitFor();const readMs=Math.round(performance.now()-t);const after=await exp();assert.equal(count(after),31);
 for(const [id,v] of Object.entries(big.meta))assert.deepEqual(after.meta[id].messages,v.messages);
 assert.equal(await p.evaluate(()=>localStorage.getItem('zwgcb-data-v1')),backup);await snap('6a-large');
 console.log(JSON.stringify({bytes,writeMs,readMs,rows:count(after)}));
 await p.clock.setFixedTime(new Date(Date.parse(at)+31*86400000));await p.reload();await p.locator('#disk-info').waitFor();assert.equal(await p.evaluate(()=>localStorage.getItem('zwgcb-data-v1')),null);assert.deepEqual(await exp(),after);
 const fallback=await browser.newContext({viewport:{width:412,height:860},serviceWorkers:'block'});const f=await fallback.newPage();await f.addInitScript(({backup})=>{if(!sessionStorage.seed){localStorage.setItem('zwgcb-data-v1',backup);sessionStorage.seed='1';}Object.defineProperty(window,'indexedDB',{get(){throw new Error('disabled');}});},{backup});
 await f.goto(url+'/#settings');const info=f.locator('#disk-info');await info.waitFor();assert.match(await info.innerText(),/继续使用原来的 localStorage/);await f.locator('#settings-data').screenshot({path:path.join(out,'6a-fallback.png')});
 await f.locator('#importFile').setInputFiles({name:'fallback.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({days:{},meta:{'chat:extra':chat('extra','回退写入')}}))});await f.waitForFunction(()=>!!JSON.parse(localStorage.getItem('zwgcb-data-v1')).meta['chat:extra']);await f.reload();await info.waitFor();assert.match(await info.innerText(),/8 条记录/);
 await p.addInitScript(()=>{Object.defineProperty(window,'indexedDB',{get(){throw Error('disabled');}});});await p.reload();await p.getByText(/本机数据库暂时打不开/).waitFor();assert.equal(await p.locator('#importFile').count(),0);
 const failed=await browser.newContext({serviceWorkers:'block'}),g=await failed.newPage();
 await g.addInitScript(seed=>{localStorage.setItem('zwgcb-data-v1',seed);const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(v,k){return put.call(this,this.name==='docs'?{altered:true}:v,k);};},backup);
 await g.goto(url+'/#settings');await g.getByText(/迁移未通过核对/).waitFor();assert.equal(await g.evaluate(()=>localStorage.getItem('zwgcb-data-v1')),backup);
 assert.equal(await g.evaluate(()=>new Promise(resolve=>{const r=indexedDB.open('zwgcb');r.onsuccess=()=>{const n=r.result.transaction('docs').objectStore('docs').count();n.onsuccess=()=>resolve(n.result);};})),0);
 const pages=await browser.newContext({serviceWorkers:'block'}),pg=await pages.newPage();await pages.route('**/*',r=>r.fulfill({contentType:'text/html',body:current}));await pg.goto('https://example.github.io/#settings');await pg.locator('#settings-data').waitFor();
 assert.equal(await pg.locator('#disk-info').count(),0);assert.equal(await pg.evaluate(async()=>(await indexedDB.databases()).filter(d=>d.name==='zwgcb').length),0);
 assert.deepEqual(errors,[]);console.log('OK: expiry, unavailable IndexedDB, fallback write/reload, existing primary protected, mismatch rolled back, Pages unchanged');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(String(e.stack).slice(0,2000));process.exit(1);});
