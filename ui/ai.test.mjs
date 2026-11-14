import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('./ai.js',import.meta.url),'utf8');
const date='2026-11-13';
const ctx={selection:{review:true},materials:{review:'虚构记录：今天写了十分钟。',preds:[],caps:[],hyps:[]}};
function setup(fetcher=async()=>{throw Error('unexpected request');},wake){
 const document=new EventTarget();document.visibilityState='visible';
 const box={document,window:new EventTarget(),navigator:{onLine:true,wakeLock:wake},location:{origin:'http://localhost',hostname:'localhost'},localStorage:{getItem:()=>null},$:()=>({addEventListener(){}}),newId:()=> 'test-id',drafts:{},uiPrefs:{},saveDrafts:()=>true,clone:structuredClone,fetch:fetcher,AbortController,AbortSignal,TextEncoder,TextDecoder,performance,setTimeout,clearTimeout,requestAnimationFrame:fn=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,route:'ai',mode:'test',hm:()=> '12:00',S:{days:{[date]:{date}}},getDay:()=>box.S.days[date],put:async()=>{}};
 vm.createContext(box);vm.runInContext(source+`;aiRender=()=>{};aiPaint=()=>{};globalThis.api={ai,aiSession,aiRun,aiStreamEvent,aiNewDiagnostic,aiKeepAwake,aiSaveDraft,aiRunHyps,aiHypAdd,aiHypEdit,aiHypCards};`,box);
 box.api.ai.date=date;box.api.ai.token='mock-access';return box;
}
const event=(type,extra={})=>({type,...extra});
function stream(events){
 const bytes=new TextEncoder().encode(events.map(e=>'event: '+e.type+'\r\ndata: '+JSON.stringify(e)+'\r\n\r\n').join(''));
 return new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=7)c.enqueue(bytes.slice(i,i+7));c.close();}}),{headers:{'content-type':'text/event-stream','x-ai-effort':'applied'}});
}
const events=(text,reason='end_turn')=>[
 event('message_start',{message:{model:'mock-model',usage:{input_tokens:50}}}),
 event('content_block_start',{content_block:{type:'thinking',thinking:'仅内存'}}),
 event('content_block_delta',{delta:{type:'thinking_delta',thinking:'思考摘要'}}),
 event('content_block_start',{content_block:{type:'text',text:text.slice(0,2)}}),
 event('content_block_delta',{delta:{type:'text_delta',text:text.slice(2)}}),
 event('message_delta',{delta:{stop_reason:reason},usage:{output_tokens:8000}}),event('message_stop')
];
test('fragmented UTF-8 SSE separates thinking, text, stop reason and usage',async()=>{
 const box=setup(async()=>stream(events('这是正文'))),s=box.api.aiSession();
 await box.api.aiRun('summary',s,ctx);
 assert.equal(box.S.days[date].ai.summary.text,'这是正文');assert.equal(s.summaryThinking,'仅内存思考摘要');
 assert.equal(box.api.ai.diag.thinking,true);assert.equal(box.api.ai.diag.stopReason,'end_turn');assert.equal(box.api.ai.diag.output_tokens,8000);assert.equal(box.api.ai.diag.effort,'applied');
 assert.ok(!JSON.stringify(box.S).includes('思考摘要'));assert.ok(!JSON.stringify(box.drafts).includes('思考摘要'));
});
test('truncated summary is saved; thinking-only truncation preserves the previous summary',async()=>{
 let text='已有正文';const box=setup(async()=>stream(events(text,'max_tokens'))),s=box.api.aiSession();
 await box.api.aiRun('summary',s,ctx);assert.equal(box.S.days[date].ai.summary.stopReason,'max_tokens');assert.equal(s.summaryError,'');
 text='';await box.api.aiRun('summary',s,ctx);assert.equal(box.S.days[date].ai.summary.text,'已有正文');assert.equal(s.summaryError,'这次想得太久，没来得及回答，请重试');
});
test('explore truncation survives drafts and only message text is sent in the next round',async()=>{
 const sent=[];const box=setup(async(_url,opts)=>{sent.push(JSON.parse(opts.body));return stream(events('未完的回复','max_tokens'));}),s=box.api.aiSession();s.input='虚构问题';
 await box.api.aiRun('explore',s,ctx);assert.equal(s.messages.at(-1).stopReason,'max_tokens');assert.equal(box.drafts['ai-explore:'+date].messages.at(-1).stopReason,'max_tokens');
 s.input='请接着回答';await box.api.aiRun('explore',s,ctx);
 assert.equal(s.messages[1].stopReason,'max_tokens');assert.ok(!JSON.stringify(sent).includes('thinking'));assert.ok(!JSON.stringify(sent).includes('stopReason'));assert.ok(!JSON.stringify(box.drafts).includes('思考摘要'));
});
test('thinking-only explore keeps a retry and never creates an empty assistant message',async()=>{
 const box=setup(async()=>stream(events('','max_tokens'))),s=box.api.aiSession();s.input='虚构问题';
 await box.api.aiRun('explore',s,ctx);assert.equal(s.messages.length,1);assert.equal(s.retry.question,'虚构问题');assert.equal(s.exploreError,'这次想得太久，没来得及回答，请重试');
});
test('incomplete and error streams preserve old summary and release screen lock',async()=>{
 for(const response of [()=>stream(events('部分文字').slice(0,-2)),()=>new Response('{}',{status:500})]){
  let releases=0;const box=setup(async()=>response(),{request:async()=>({addEventListener(){},release:async()=>{releases++;}})}),s=box.api.aiSession();box.S.days[date].ai={summary:{text:'旧总结'}};
  await box.api.aiRun('summary',s,ctx);assert.equal(box.S.days[date].ai.summary.text,'旧总结');assert.equal(releases,1);assert.ok(s.summaryError);
 }
});
test('wake lock re-acquires on visibility and releases on abort, including late acquisition',async()=>{
 let requested=0,released=0,locks=[];
 const wake={request:async()=>{requested++;const lock=new EventTarget();lock.release=async()=>{released++;lock.dispatchEvent(new Event('release'));};locks.push(lock);return lock;}};
 const box=setup(undefined,wake),r={ctl:new AbortController()};const cleanup=box.api.aiKeepAwake(r);await new Promise(setImmediate);assert.equal(requested,1);
 await locks[0].release();box.document.dispatchEvent(new Event('visibilitychange'));await new Promise(setImmediate);assert.equal(requested,2);r.ctl.abort();assert.equal(released,2);cleanup();assert.equal(released,2);
 let resolve;box.navigator.wakeLock={request:()=>new Promise(r=>resolve=r)};const next={ctl:new AbortController()};box.api.aiKeepAwake(next);next.ctl.abort();resolve({release:async()=>{released++;}});await new Promise(setImmediate);assert.equal(released,3);
});
test('unsupported or denied wake lock never prevents generation',async()=>{
 for(const wake of [undefined,{request:async()=>{throw Error('denied');}}]){const box=setup(async()=>stream(events('正常回答')),wake);await box.api.aiRun('summary',box.api.aiSession(),ctx);assert.equal(box.S.days[date].ai.summary.text,'正常回答');}
});
const hypFixture={text:'在先做五分钟时，可能会更容易开始。',why:'我只做了五分钟就开始了。',near:1};
const hypContext={chat:{id:'chat-1',date,messages:[{role:'user',content:'我只做了五分钟就开始了。'},{role:'assistant',content:'观察下一次。'}]},payload:{messages:[{role:'user',content:'我只做了五分钟就开始了。'}],hyps:[{no:1,text:'已有假设'}]}};
test('extraction sends only confirmed payload, persists no proposals and rejects unknown near',async()=>{
 let sent;const box=setup(async(_url,opts)=>{sent=JSON.parse(opts.body);return new Response(JSON.stringify({hyps:[hypFixture,{...hypFixture,near:99}]}),{headers:{'x-ai-effort':'applied'}});});const before=JSON.stringify(box.S);
 await box.api.aiRunHyps(structuredClone(hypContext));assert.deepEqual(sent,hypContext.payload);assert.equal(JSON.stringify(box.S),before);assert.equal(JSON.stringify(box.drafts),'{}');
 const rows=box.api.ai.hypResults.get(date+'|chat-1').hyps;assert.equal(rows.length,2);assert.equal(rows[0].near,1);assert.equal(rows[1].near,null);assert.equal(rows[0].added,undefined);
});
test('empty, 401 and malformed extraction responses do not create records',async()=>{
 for(const [status,data] of [[200,{hyps:[]}],[401,{error:{code:'unauthorized'}}],[200,{hyps:[{text:'missing why'}]}]]){
  const box=setup(async()=>new Response(JSON.stringify(data),{status}));const before=JSON.stringify(box.S);await box.api.aiRunHyps(structuredClone(hypContext));
  assert.equal(JSON.stringify(box.S),before);assert.equal(box.api.ai.hypRequest,null);const state=box.api.ai.hypResults.get(date+'|chat-1');
  if(status===401){assert.equal(box.api.ai.needsToken,true);assert.equal(box.api.ai.pending.chatId,'chat-1');}else if(data.hyps.length)assert.ok(state.error);else assert.equal(state.hyps.length,0);
 }
});
test('explicit confirmation uses makeHyp, saves source, and double-click does not duplicate',async()=>{
 const box=setup();box.S.hyps={};let number=1,puts=0;
 box.needReady=()=>true;box.claimNo=()=>++number;box.dayKey=()=>date;
 const app=readFileSync(new URL('./app.html',import.meta.url),'utf8');vm.runInContext(app.slice(app.indexOf('function makeHyp('),app.indexOf('function pushHistory(')),box);
 box.put=async(col,id,value)=>{puts++;await new Promise(setImmediate);box.S[col][id]=value;};
 const row={...hypFixture},state={chat:structuredClone(hypContext.chat),hyps:[row]};box.api.ai.hypResults.set(date+'|chat-1',state);
 const el={dataset:{chat:'chat-1',index:'0'}};box.api.aiHypEdit(el);assert.equal(puts,0);assert.equal(number,1);row.edit='在先做三分钟时，可能会开始。';
 await Promise.all([box.api.aiHypAdd(el),box.api.aiHypAdd(el)]);
 assert.equal(number,2);assert.equal(puts,2);assert.equal(Object.keys(box.S.hyps).length,1);const saved=box.S.hyps['test-id'];assert.equal(saved.no,2);assert.equal(saved.status,'test');assert.equal(saved.ev.length,0);assert.equal(saved.text,row.edit||row.text);assert.equal(saved.src.chatId,'chat-1');assert.equal(row.added.no,2);
 assert.equal(box.S.days[date].ai.explores[0].id,'chat-1');assert.ok(!JSON.stringify(box.S).includes('"why"'));
});
test('failed source save cannot create a hypothesis; retry retains one source',async()=>{
 const box=setup();box.S.hyps={};box.needReady=()=>true;let failed=true,created=0;
 box.makeHyp=o=>{created++;return {id:'h1',no:1,...o};};box.put=async(col,id,value)=>{box.S[col][id]=value;if(failed)throw Error('save failed');};
 const row={...hypFixture,edit:hypFixture.text},state={chat:structuredClone(hypContext.chat),hyps:[row]};box.api.ai.hypResults.set(date+'|chat-1',state);const el={dataset:{chat:'chat-1',index:'0'}};
 await box.api.aiHypAdd(el);assert.equal(created,0);assert.equal(row.added,undefined);assert.ok(row.error);
 failed=false;await box.api.aiHypAdd(el);assert.equal(created,1);assert.equal(box.S.days[date].ai.explores.length,1);assert.equal(row.added.no,1);
});
