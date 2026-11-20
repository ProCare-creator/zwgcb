import {test} from 'node:test';
import {validate,upstreamBody} from '../worker/worker.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const src=readFileSync(new URL('./ai.js',import.meta.url),'utf8')+'\n'+readFileSync(new URL('./chat.js',import.meta.url),'utf8');
function setup(fetcher=async()=>{throw Error('unexpected fetch');}){
 let seq=12,id=0;const document=new EventTarget();document.visibilityState='visible';
 const S={days:{},hyps:{h12:{id:'h12',no:12,text:'在只写第一步时，我可能会更早开始。',ev:[{id:'old',note:'旧证据'}]}},meta:{}};
 const b={accountHost:true,accountUser:{role:'admin'},document,window:new EventTarget(),navigator:{onLine:true},location:{origin:'http://localhost',hostname:'localhost',hash:'#chat'},history:{replaceState(_a,_b,hash){b.location.hash=hash;}},localStorage:{getItem:()=>null},$:s=>s==='#ai-confirm'?{addEventListener(){}}:null,ui:{},uiPrefs:{},drafts:{},S,route:'chat',mode:'test',newId:()=>String(++id),clone:structuredClone,saveDrafts:()=>true,saveUIPrefs(){},needReady:()=>true,render(){},toast(){},esc:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),dayKey:()=> '2026-11-17',ymd:d=>d.toISOString().slice(0,10),addDays:()=> '2026-11-18',validDate:s=>/^\d{4}-\d{2}-\d{2}$/.test(s||'')&&!isNaN(new Date(s))&&new Date(s).toISOString().startsWith(s),sameText:(a,c)=>a.replace(/[\s。]/g,'')===c.replace(/[\s。]/g,''),hypText:h=>h.text,getDay:d=>structuredClone(S.days[d]||{date:d,preds:[]}),makeHyp:o=>({...o,id:String(++id),no:++seq,status:'test',ev:[]}),put:async(c,k,v)=>{S[c][k]=structuredClone(v);},remove:async(c,k)=>{delete S[c][k];},fetch:fetcher,AbortController,AbortSignal,TextEncoder,TextDecoder,URLSearchParams,performance,setTimeout:(f,ms)=>{const t=setTimeout(f,ms);t.unref();return t;},clearTimeout,requestAnimationFrame:()=>0,cancelAnimationFrame(){}};
 vm.createContext(b);vm.runInContext(src+';globalThis.api={chat,ai,chatParse,chatNewDoc,chatSend,chatAddCard,chatUndoCard,chatCardHTML,chatMessagesHTML,chatSourceLabel,chatStats,chatSave,chatLoad,chatDraft,CHAT_ACTIONS};',b);b.api.chat.doc=b.api.chatNewDoc();return b;
}
const events=(text,stop='end_turn')=>[{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'PRIVATE_THOUGHT'}},{type:'content_block_delta',delta:{type:'text_delta',text}},{type:'message_delta',delta:{stop_reason:stop},usage:{output_tokens:70}},{type:'message_stop'}];
function stream(ev){const bytes=new TextEncoder().encode(ev.map(e=>'data: '+JSON.stringify(e)+'\r\n\r\n').join(''));return new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=5)c.enqueue(bytes.slice(i,i+5));c.close();}}),{headers:{'content-type':'text/event-stream'}});}
function reply(b,text){b.api.chat.doc.messages=[{role:'user',content:'虚构陈述',at:'2026-11-17'},{role:'assistant',content:text,at:'2026-11-17'}];return b.api.chat.doc;}
test('standalone tags buffer across every character boundary and preserve raw text',()=>{
 const {chatParse:p}=setup().api,tag='<hyp>在只定第一步时，我可能会更快开始。</hyp>';
 for(let i=1;i<tag.length;i++)assert.equal(p('前文\n'+tag.slice(0,i),false).parts.map(x=>x.text).join(''),'前文\n');
 assert.equal(p('前文\n'+tag+'\n后文').parts[1].type,'hyp');
 for(const bad of ['<hyp extra="x">猜测</hyp>','<hyp>未闭合','<pred date="2026-02-30">日期错</pred>','<ev no="12" kind="oops">事实</ev>','<ev no="12" no="13" kind="sup">重复属性</ev>','<hyp>'+ '字'.repeat(301)+'</hyp>','正文 <hyp>行内</hyp>','<script>alert(1)</script>'])assert.equal(p(bad).parts[0].text,bad);
 const result=p(tag+'\n<pred date="2026-11-18">明天写一段</pred>\n<ev no="12" kind="sup">事实</ev>\n<ask>先试哪一步？</ask>\n<ask>什么时候开始？</ask>');
 assert.equal(result.parts.filter(x=>x.type!=='text').length,2);assert.equal(result.asks.length,2);assert.match(result.parts.at(-1).text,/<ev/);
 assert.equal(p('<ask>中间的问题</ask>\n还有正文').asks.length,0);
});
test('hypothesis uses regular numbering, persists edited card state and undoes only its own item',async()=>{
 const b=setup(),d=reply(b,'<hyp>在压力大时，我可能会更晚开始。</hyp>');
 b.api.chat.edits.set(d.id+':1:0','在任务大时，我可能会先整理桌面。');await b.api.chatAddCard('1:0');
 const h=Object.values(b.S.hyps).find(h=>h.no===13);assert.ok(h);assert.equal(h.status,'test');assert.equal(h.text,'在任务大时，我可能会先整理桌面。');assert.equal(h.src.type,'chat');assert.equal(h.src.chatId,d.id);
 assert.equal(b.S.meta['chat:'+d.id].cards['1:0'].status,'added');assert.match(b.api.chatCardHTML(b.api.chatParse(d.messages[1].content).parts[0],'1:0'),/已加入 H13/);
 await b.api.chatAddCard('1:0');assert.equal(Object.keys(b.S.hyps).length,2);await b.api.chatUndoCard('1:0');assert.equal(Object.keys(b.S.hyps).length,1);assert.equal(d.cards['1:0'].status,'undone');
});
test('duplicate hypotheses and predictions do not create or undo existing targets',async()=>{
 const b=setup(),d=reply(b,'<hyp>在只写第一步时，我可能会更早开始。</hyp>');await b.api.chatAddCard('1:0');assert.equal(Object.keys(b.S.hyps).length,1);assert.equal(d.cards['1:0'].existing,true);await b.api.chatUndoCard('1:0');assert.ok(b.S.hyps.h12);
 b.S.days['2026-11-18']={date:'2026-11-18',preds:[{id:'existing',text:'写一段'}]};reply(b,'<pred date="2026-11-18">写一段。</pred>');d.cards={};await b.api.chatAddCard('1:0');assert.equal(b.S.days['2026-11-18'].preds.length,1);assert.equal(d.cards['1:0'].ref.id,'existing');
});
test('prediction and weak evidence save their exact source; undo preserves unrelated data',async()=>{
 const b=setup(),d=reply(b,'<pred date="2026-11-18">明天十点写完一段。</pred>\n<ev no="12" kind="con">昨天只写第一步，仍拖到晚上。</ev>');
 await b.api.chatAddCard('1:0');const p=b.S.days['2026-11-18'].preds[0];assert.equal(p.kind,'specific');assert.equal(p.src,'chat');assert.equal(p.chatId,d.id);assert.equal(p.result,'');assert.equal(p.hid,null);
 await b.api.chatAddCard('1:1');const ev=b.S.hyps.h12.ev[1];assert.equal(ev.str,'weak');assert.equal(ev.kind,'con');assert.equal(ev.src,'chat:'+d.id);assert.match(b.api.chatSourceLabel('ev',ev),/data-msg="1"/);
 b.S.days['2026-11-18'].preds.push({id:'later',text:'另一个'});b.S.hyps.h12.ev.push({id:'later',note:'另一个'});await b.api.chatUndoCard('1:0');await b.api.chatUndoCard('1:1');assert.deepEqual(b.S.days['2026-11-18'].preds.map(x=>x.id),['later']);assert.deepEqual(b.S.hyps.h12.ev.map(x=>x.id),['old','later']);
 delete b.S.meta['chat:'+d.id];assert.match(b.api.chatSourceLabel('pred',p),/对话已删除/);
});
test('unknown evidence target is disabled and never writes',async()=>{
 const b=setup(),d=reply(b,'<ev no="999" kind="sup">事实</ev>');assert.match(b.api.chatCardHTML(b.api.chatParse(d.messages[1].content).parts[0],'1:0'),/找不到 H999/);await b.api.chatAddCard('1:0');assert.equal(Object.keys(d.cards).length,0);
});
test('chat sends raw markers and only opted context, autosaves text but never thoughts',async()=>{
 const sent=[],text='<hyp>在只做五分钟时，我可能会更快开始。</hyp>';const b=setup(async(_u,o)=>{sent.push(JSON.parse(o.body));return stream(events(text));});
 await b.api.chatSend('虚构第一轮');const id=b.api.chat.doc.id;assert.equal(sent[0].materials,undefined);assert.equal(sent[0].hyps[0].ev,undefined);assert.equal(Object.keys(b.S.meta).length,1);assert.ok(!JSON.stringify(b.S).includes('PRIVATE_THOUGHT'));
 b.api.chat.attachment={date:'2026-11-17',materials:{review:'选中记录'}};await b.api.chatSend('第二轮');assert.equal(sent[1].messages[1].content,text);assert.equal(sent[1].messages[2].ctx.materials.review,'选中记录');assert.equal(b.S.meta['chat:'+id].messages[2].ctx.date,'2026-11-17');assert.equal(b.api.chat.attachment,null);
 b.uiPrefs.chatHyps=false;await b.api.chatSend('第三轮');assert.equal(sent[2].materials,undefined);assert.equal(sent[2].hyps,undefined);assert.ok(!JSON.stringify(b.drafts).includes('PRIVATE_THOUGHT'));
});
test('truncated and interrupted replies survive, oversized input never leaves browser',async()=>{
 for(const ev of [events('截断文字','max_tokens'),events('断开的文字').slice(0,-2)]){const b=setup(async()=>stream(ev));await b.api.chatSend('虚构');assert.ok(b.api.chat.doc.messages[1].content);assert.equal(Object.keys(b.S.meta).length,1);assert.ok(b.api.chat.doc.messages[1].stopReason==='max_tokens'||b.api.chat.doc.messages[1].partial);}
 const b=setup();await b.api.chatSend('字'.repeat(90000));assert.equal(b.api.chat.doc.messages.length,0);assert.equal(b.api.chat.error,'这次对话太长了，开一个新对话继续');
});
test('failed local writes roll back target and leave the conversation available for retry',async()=>{
 const b=setup();b.mode='local';b.lsRead=()=>({hyps:{},meta:{}});const d=reply(b,'<hyp>在压力大时，我可能会更晚开始。</hyp>');await b.api.chatAddCard('1:0');assert.equal(Object.keys(b.S.hyps).length,1);assert.equal(b.api.chat.doc,d);assert.equal(d.messages.length,2);assert.match(b.api.chat.error,/没有保存成功/);
});
test('three local sends preserve the original snapshot and only cache the system and final user text',async()=>{
 const requests=[],wire=[],env={MODEL_EXPLORE:'mock',MAX_TOKENS_EXPLORE:'32000'};
 const b=setup(async(_url,o)=>{const raw=JSON.parse(o.body);requests.push(raw);wire.push(upstreamBody(env,'chat',validate(raw,'chat')));return stream(events('虚构回复'));});
 const attachment={date:'2026-11-17',materials:{review:'蓝卡片 <旧记录>'}};
 b.api.chat.attachment=attachment;
 for(const [i,q] of ['第一次','第二次','第三次'].entries()){
   await b.api.chatSend(q);attachment.materials.review='已经变化';
   const raw=requests[i],body=wire[i];assert.equal(raw.messages[0].ctx.materials.review,'蓝卡片 <旧记录>');
   assert.ok(raw.messages.slice(1).every(m=>!m.ctx));assert.equal(raw.messages.length,2*i+1);
   const blocks=body.messages.flatMap(m=>m.content);assert.equal(blocks.filter(v=>v.text.startsWith('<materials>')).length,1);
   assert.match(body.messages[0].content[0].text,/^<materials>/);assert.ok(body.messages[0].content[0].text.includes('\\u003c旧记录>'));
   assert.equal(body.messages[0].content[1].text,'第一次');assert.equal(blocks.filter(v=>v.text.startsWith('<hypotheses>')).length,1);
   assert.match(body.messages.at(-1).content.at(-1).text,/^<hypotheses>/);assert.equal(blocks.at(-2).text,q);
   assert.deepEqual([...body.system,...blocks].filter(v=>v.cache_control),[body.system[0],blocks.at(-2)]);
 }
 const id=b.api.chat.doc.id;assert.equal(b.S.meta['chat:'+id].messages[0].ctx.materials.review,'蓝卡片 <旧记录>');
 b.api.chat.doc.messages[0].ctx.materials.review='字'.repeat(90000);await b.api.chatSend('第四次');assert.equal(requests.length,3);assert.match(b.api.chat.error,/太长/);
});
test('chat HTML renders imported dates, identifiers, labels and roles as inert text',()=>{
 const b=setup(),d=reply(b,'<pred date="2026-11-18">测试</pred>'),sample='<em>样本</em>';
 d.messages[0].ctx={date:'2026-'+sample};d.cards['1:0']={status:'added',type:'pred',ref:{date:'2026-'+sample}};
 d.messages.push({role:'other" '+sample,content:sample});let html=b.api.chatMessagesHTML();
 assert.ok(!html.includes(sample));assert.ok(!html.includes('other"'));assert.ok(html.includes('&lt;em>'));
 d.cards['1:0']={status:'added',type:'hyp',ref:{no:sample}};html=b.api.chatMessagesHTML();assert.ok(!html.includes(sample));
});
test('stream draft checkpoints are one second apart and final reply is flushed',async()=>{
 let now=0;const checkpoints=[],b=setup(async()=>{let i=0;return new Response(new ReadableStream({pull(c){
   now+=100;const e=i<25?{type:'content_block_delta',delta:{type:'text_delta',text:'甲'}}:{type:'message_stop'};
   c.enqueue(new TextEncoder().encode('data: '+JSON.stringify(e)+'\n\n'));if(++i===26)c.close();
 }},{highWaterMark:0}),{headers:{'content-type':'text/event-stream'}});});
 b.performance={now:()=>now};b.saveDrafts=()=>{const r=b.api.chat.request,d=b.drafts['chat:'+b.api.chat.doc.id];if(r&&d?.reply)checkpoints.push([now,!!r.finishedAt,d.reply.content.length]);return true;};
 await b.api.chatSend('虚构限频检查');assert.deepEqual(checkpoints,[[1000,false,10],[2000,false,20],[2600,true,25]]);
});
