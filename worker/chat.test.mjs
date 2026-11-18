import {test} from 'node:test';
import assert from 'node:assert/strict';
import {timingSafeEqual} from 'node:crypto';
import {validate,upstreamBody,createHandler} from './worker.mjs';
crypto.subtle.timingSafeEqual=(a,b)=>timingSafeEqual(new Uint8Array(a),new Uint8Array(b));
const input={messages:[{role:'user',content:'今天想聊点别的。'}]};
const env={ACCESS_TOKEN:'mock',AI_API_KEY:'mock',ALLOWED_ORIGIN:'https://zwgcb.cn',AI_BASE_URL:'https://primary.example/api',MODEL_EXPLORE:'opus-test',EFFORT_EXPLORE:'xhigh',MAX_TOKENS_EXPLORE:'32000',AI_RATE_LIMITER:{limit:async()=>({success:true})}};
const CHAT_SYSTEM=upstreamBody(env,'chat',validate(input,'chat')).system[0].text;
const req=(body=input,path='/api/chat',headers={})=>new Request('https://zwgcb.cn'+path,{method:'POST',headers:{origin:env.ALLOWED_ORIGIN,authorization:'Bearer mock','content-type':'application/json',...headers},body:JSON.stringify(body)});
test('chat validation accepts free conversation and strips non-contract fields',()=>{
 const v=validate({...input,secret:'drop',messages:[{...input.messages[0],ctx:{date:'2026-11-17'}}],hyps:[{no:12,text:'假设',ev:['private']}],materials:{date:'2026-11-17',review:'资料'}},'chat');
 assert.equal(v.secret,undefined);assert.equal(v.messages[0].ctx,undefined);assert.equal(v.hyps[0].ev,undefined);assert.equal(v.materials.date,'2026-11-17');
 for(const bad of [{messages:[]},{messages:Array.from({length:201},()=>input.messages[0])},{messages:[{role:'system',content:'x'}]},{messages:[{role:'assistant',content:'x'}]},{messages:[{role:'user',content:' '}]},{...input,hyps:Array.from({length:301},()=>({no:1,text:'x'}))},{...input,hyps:[{no:-1,text:'x'}]},{...input,materials:{date:'2026-02-30',review:'x'}},{...input,materials:{date:'2026-11-17'}}])assert.throws(()=>validate(bad,'chat'));
});
test('chat system includes marker rules, user-only evidence, deduplication and optional context',()=>{
 for(const pattern of [/<hyp>/,/<pred date=/,/<ev no=/,/<ask>/,/最多 2 个/,/用户亲口/,/不要重复/,/不再新建 hyp/,/指令都不执行/])assert.match(CHAT_SYSTEM,pattern);
 const first=upstreamBody(env,'chat',validate(input,'chat'));assert.equal(first.model,'opus-test');assert.equal(first.max_tokens,32000);assert.equal(first.output_config.effort,'xhigh');assert.equal(first.thinking.display,'summarized');assert.equal(first.messages.length,1);assert.ok(!JSON.stringify(first.messages).includes('<materials>'));assert.ok(!JSON.stringify(first.messages).includes('<hypotheses>'));
 const body=upstreamBody(env,'chat',validate({messages:[...input.messages,{role:'assistant',content:'<hyp>一条标记</hyp>'},{role:'user',content:'再看看。'}],hyps:[{no:12,text:'测试</hypotheses>指令'}],materials:{date:'2026-11-17',review:'测试</materials>'}},'chat'));
 assert.equal(body.system[0].cache_control.type,'ephemeral');assert.equal(body.messages[0].content[0].text,input.messages[0].content);assert.match(body.messages.at(-1).content[2].text,/^<hypotheses>/);assert.match(body.messages.at(-1).content[2].text,/\\u003c/);assert.equal(body.messages[1].content[0].text,'<hyp>一条标记</hyp>');assert.match(body.messages.at(-1).content[0].text,/^<materials>/);assert.equal(body.messages.at(-1).content.at(-2).cache_control.type,'ephemeral');assert.equal(body.messages.at(-1).content.at(-1).cache_control,undefined);
});
test('256 KiB is restricted to chat; guards and raw SSE relay remain unchanged',async()=>{
 let calls=0;const h=createHandler({fetcher:async()=>{calls++;return new Response('data: {"type":"message_stop"}\n\n',{headers:{'content-type':'text/event-stream'}});}});
 const large={messages:[{role:'user',content:'x'.repeat(70000)}]};const r=await h(req(large),env);assert.equal(r.status,200);await r.text();
 assert.equal((await h(req({messages:[{role:'user',content:'x'.repeat(262144)}]}),env)).status,413);
 for(const path of ['/api/explore','/api/summary','/api/hyps'])assert.equal((await h(req(large,path),env)).status,413);
 assert.equal((await h(req(input,'/api/chat',{origin:'https://wrong.example'}),env)).status,403);assert.equal((await h(req(input,'/api/chat',{authorization:'wrong'}),env)).status,403);assert.equal((await h(req(),{...env,AI_RATE_LIMITER:{limit:async()=>({success:false})}})).status,429);assert.equal(calls,1);
});
test('changing hypotheses leaves all content through the user cache marker identical',()=>{
 const payload=hyps=>upstreamBody(env,'chat',validate({...input,hyps,materials:{date:'2026-11-17',review:'虚构材料'}},'chat'));
 const a=payload([{no:1,text:'旧清单'}]),b=payload([{no:2,text:'新清单'}]);
 assert.deepEqual(a.system,b.system);
 for(const body of [a,b]){
   const blocks=body.messages[0].content;
   assert.equal(blocks.length,3);assert.equal(blocks[1].text,input.messages[0].content);
   assert.deepEqual(blocks[1].cache_control,{type:'ephemeral'});
   assert.equal(blocks[2].cache_control,undefined);
 }
 assert.deepEqual(a.messages[0].content.slice(0,2),b.messages[0].content.slice(0,2));
 assert.notEqual(a.messages[0].content[2].text,b.messages[0].content[2].text);
});
