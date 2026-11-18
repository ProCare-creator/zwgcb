// Run from an isolated Chrome profile; serves both versions on one loopback origin.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),{chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const root=path.join(__dirname,'..'),out=process.env.QA_OUTPUT||require('node:os').tmpdir();
const old=execFileSync('git',['show','97d55e7:index.html'],{cwd:root,maxBuffer:2e6}),current=fs.readFileSync(path.join(root,'index.html'));
const server=http.createServer((req,res)=>{
 if(req.url==='/api/chat'){req.resume();res.writeHead(200,{'content-type':'text/event-stream'});const send=t=>res.write('data: '+JSON.stringify({type:'content_block_delta',delta:{type:'text_delta',text:t}})+'\n\n');
 send('正在生成的');const t=setTimeout(()=>send('虚构正文'),1200);res.on('close',()=>clearTimeout(t));return;}
 res.writeHead(200,{'content-type':'text/html;charset=utf-8','cache-control':'no-store'});res.end(req.url.startsWith('/old')?old:current);
});
const at='2026-11-17T10:00:00.000Z',key='zwgcb-drafts-v1',base='zwgcb-data-v1',large='abcdef'.repeat(36000);
const doc={id:'long',title:'虚构长对话',created:at,updated:at,cards:{},messages:[{role:'user',content:large,at},{role:'assistant',content:'原有回复',at}]};
const seed={days:{},hyps:{},weeks:{},events:{},archives:{},meta:{'chat:long':doc,counters:{hypSeq:12}}};
(async()=>{fs.mkdirSync(out,{recursive:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port,browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined});
 try{const c=await browser.newContext({viewport:{width:412,height:860},serviceWorkers:'block'}),legacy=await c.newPage(),p=await c.newPage();
 const errors=[];p.on('pageerror',e=>errors.push(e.message));await c.addInitScript(({seed,base})=>{if(!localStorage.getItem(base)){localStorage.setItem(base,JSON.stringify(seed));localStorage.setItem('zwgcb-ai',JSON.stringify({token:'fixture'}));}},{seed,base});
 await legacy.goto(url+'/old#chat?id=long');await legacy.locator('.chat-title').waitFor();await p.goto(url+'/#settings');await p.locator('#disk-info').waitFor();
 const act=(page,k)=>page.locator('[data-act="'+k+'"]').first();
 await act(legacy,'chatRename').click();await legacy.locator('#chat-name').fill('旧版修改的标题');await act(legacy,'chatRenameSave').click();await legacy.waitForFunction(()=>document.querySelector('.chat-title')?.textContent==='旧版修改的标题');
 await legacy.goto(url+'/old#settings');await legacy.locator('#importFile').setInputFiles({name:'synthetic.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({days:{},meta:{'chat:new':{...doc,id:'new',title:'旧版新增',messages:[]}}}))});
 await legacy.waitForFunction(k=>!!JSON.parse(localStorage.getItem(k)).meta['chat:new'],base);
 // Abort one merge write: neither the old source nor its fingerprint may be consumed.
 await p.addInitScript(()=>{const orig=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(v,k){if(!sessionStorage.failed&&this.name==='docs'&&k[1]==='chat:new'){sessionStorage.failed='1';throw Error('forced rollback');}return orig.apply(this,arguments);};});
 await p.reload();await p.getByText(/旧版页面的修改未合并/).waitFor();await p.reload();await p.getByText('合并了旧版页面写入的 2 条修改。').waitFor();
 await p.locator('#settings-data').screenshot({path:path.join(out,'6a-legacy-merge.png')});
 const exp=async()=>{const dl=p.waitForEvent('download');await act(p,'export').click();return JSON.parse(fs.readFileSync(await(await dl).path()));};
 const merged=await exp(),source=await p.evaluate(k=>JSON.parse(localStorage.getItem(k)),base);
 for(const col of ['days','hyps','weeks','events','archives','meta'])assert.deepEqual(merged[col],source[col]);
 assert.deepEqual(merged.meta.counters,seed.meta.counters);await p.reload();await p.locator('#disk-info').waitFor();assert.ok(!(await p.locator('#disk-info').innerText()).includes('条修改'));
 await p.goto(url+'/#chat?id=long');await p.locator('#chat-input').fill('虚构：再说一句');await act(p,'chatSend').click();
 await p.waitForFunction(k=>JSON.parse(localStorage.getItem(k)||'{}')['chat:long']?.reply?.content==='正在生成的虚构正文',key);await p.locator('#chat-input').fill('还没发送的新问题');
 const draft=await p.evaluate(k=>JSON.parse(localStorage.getItem(k))['chat:long'],key);const bytes=Buffer.byteLength(JSON.stringify(draft));assert.ok(bytes<10240&&!draft.doc);assert.equal(draft.index,3);
 await p.reload();await p.locator('[data-message="3"]').waitFor();assert.equal(await p.locator('[data-message="0"] .ai-prose').innerText(),large);assert.equal(await p.locator('[data-message="2"] .ai-prose').innerText(),'虚构：再说一句');assert.equal(await p.locator('[data-message="3"] .ai-prose').innerText(),'正在生成的虚构正文');assert.equal(await p.locator('#chat-input').inputValue(),'还没发送的新问题');
 await p.locator('[data-message="3"]').scrollIntoViewIfNeeded();await p.screenshot({path:path.join(out,'6a-recovered-chat.png')});
 await p.goto(url+'/?fixture#settings');await p.locator('#disk-info').waitFor();
 const legacyDraft={doc:{...doc,id:'legacy',messages:[...doc.messages,{role:'user',at,content:'旧问题'},{role:'assistant',at,content:'旧草稿回复',partial:true}]},input:'保留的输入',attachment:{date:'2026-11-17',materials:{review:'虚构附件'}}};
 await p.evaluate(({d,k})=>{const ds=JSON.parse(localStorage.getItem(k));ds['chat:legacy']=d;localStorage.setItem(k,JSON.stringify(ds));},{d:legacyDraft,k:key});await p.goto(url+'/?convert#settings');await p.locator('#disk-info').waitFor();
 const converted=await exp();assert.deepEqual(converted.meta['chat:legacy'].messages,legacyDraft.doc.messages);const compact=await p.evaluate(k=>JSON.parse(localStorage.getItem(k))['chat:legacy'],key);assert.deepEqual(compact,{input:legacyDraft.input,attachment:legacyDraft.attachment});assert.deepEqual(errors,[]);
 console.log(JSON.stringify({merged:2,rollbackRetry:true,otherRecordsUnchanged:true,historyBytes:Buffer.byteLength(JSON.stringify(doc)),streamDraftBytes:bytes,legacyBefore:Buffer.byteLength(JSON.stringify(legacyDraft)),legacyAfter:Buffer.byteLength(JSON.stringify(compact)),reloadPreserved:true}));
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(String(e.stack).slice(0,1200));process.exit(1);});
