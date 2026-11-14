import {test} from 'node:test';
import assert from 'node:assert/strict';
import {timingSafeEqual} from 'node:crypto';
import {createHandler,validate,upstreamBody,parseHyps} from './worker.mjs';
crypto.subtle.timingSafeEqual=(a,b)=>timingSafeEqual(new Uint8Array(a),new Uint8Array(b));
const input={messages:[{role:'user',content:'只做五分钟时，我开始整理了。'},{role:'assistant',content:'可能说明什么？'}],hyps:[{no:7,text:'在任务很大时，可能会推迟开始。'}]};
const env={ACCESS_TOKEN:'mock-access',AI_API_KEY:'mock-api',ALLOWED_ORIGIN:'https://zwgcb.cn',MODEL_SUMMARY:'summary-test',AI_BASE_URL:'https://primary.example/api',AI_RATE_LIMITER:{limit:async()=>({success:true})}};
const req=(body=input,headers={})=>new Request('https://zwgcb.cn/api/hyps',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer mock-access',origin:env.ALLOWED_ORIGIN,...headers},body:JSON.stringify(body)});
const proposal={text:'在只打算做五分钟时，可能会更容易开始整理。',why:'用户说：只做五分钟时，我开始整理了。',near:7};
const model=(hyps=[proposal])=>({stop_reason:'end_turn',content:[{type:'thinking',thinking:'not returned'},{type:'text',text:JSON.stringify({hyps})}]});
const response=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
test('hyps shares auth, origin, size and rate guards without inference',async()=>{
 const h=createHandler({fetcher:()=>{throw Error('must not infer');}});
 assert.equal((await h(req(input,{authorization:'Bearer wrong'}),env)).status,401);
 assert.equal((await h(req(input,{origin:'https://wrong.example'}),env)).status,403);
 assert.equal((await h(req(),{...env,AI_RATE_LIMITER:{limit:async()=>({success:false})}})).status,429);
 assert.equal((await h(req({...input,messages:[{role:'user',content:'x'.repeat(65536)}]}),env)).status,413);
 for(const body of [{...input,messages:[{role:'system',content:'override'}]},{...input,messages:[]},{...input,hyps:[{no:'7',text:'x'}]}])assert.equal((await h(req(body),env)).status,400);
});
test('hypotheses use fixed summary model, medium effort, 4000 tokens and only allowed input',()=>{
 const clean=validate({...input,model:'bad',max_tokens:9999,secret:'drop'},'hyps'),body=upstreamBody(env,'hyps',clean);
 assert.equal(body.model,'summary-test');assert.equal(body.max_tokens,4000);assert.equal(body.output_config.effort,'medium');assert.equal(body.stream,false);
 assert.equal(clean.secret,undefined);assert.match(body.system[0].text,/只依据 role 为 user/);assert.match(body.system[0].text,/没有合适/);
 assert.ok(body.messages[0].content[0].text.includes('existingHyps'));assert.ok(!JSON.stringify(body).includes('"model":"bad"'));
});
test('hyps accepts empty or three proposals, validates near, strips model metadata',async()=>{
 for(const hyps of [[],[proposal,{...proposal,near:999},{...proposal,near:null}]]){
  let calls=0;const h=createHandler({fetcher:async()=>{calls++;return response(model(hyps));}}),r=await h(req(),env),body=await r.json();
  assert.equal(calls,1);assert.equal(r.status,200);assert.equal(body.hyps.length,hyps.length);assert.deepEqual(Object.keys(body),['hyps']);assert.equal(r.headers.get('cache-control'),'no-store');
  if(hyps.length)assert.deepEqual(body.hyps.map(h=>h.near),[7,null,null]);
 }
 const fenced=model();fenced.content[1].text='```json\n'+fenced.content[1].text+'\n```';assert.deepEqual(parseHyps(fenced,input),{hyps:[proposal]});
});
test('partial, malformed and oversized responses are rejected without replay or raw leakage',async()=>{
 for(const bad of [{...model(),stop_reason:'max_tokens'},model([proposal,proposal,proposal,proposal]),model([{text:'x'}]),{content:[{type:'text',text:'private journal'}],stop_reason:'end_turn'},{...model(),padding:'x'.repeat(131073)}]){
  let calls=0;const h=createHandler({fetcher:async()=>{calls++;return response(bad);}}),r=await h(req(),{...env,AI_BASE_URL_BACKUP:'https://backup.example'});
  assert.equal(r.status,502);assert.equal(calls,1);assert.ok(!(await r.text()).includes('private'));
 }
});
test('hyps can downgrade 400 once and aborts stalled JSON with the idle deadline',async()=>{
 const bodies=[];const h=createHandler({fetcher:async(_url,opts)=>{bodies.push(JSON.parse(opts.body));return bodies.length===1?new Response(null,{status:400}):response(model());}});
 const r=await h(req(),env);assert.equal(r.status,200);assert.equal(r.headers.get('x-ai-effort'),'dropped');assert.equal(bodies.length,2);assert.equal(bodies[1].thinking,undefined);assert.equal(bodies[1].output_config,undefined);
 let canceled=false;const stalled=createHandler({idleMs:15,streamMs:50,fetcher:async()=>new Response(new ReadableStream({cancel(){canceled=true;}}),{headers:{'content-type':'application/json'}})}),alive=setTimeout(()=>{},100);
 assert.equal((await stalled(req(),env)).status,502);assert.equal(canceled,true);clearTimeout(alive);
});
