import {test} from 'node:test';
import assert from 'node:assert/strict';
import {timingSafeEqual} from 'node:crypto';
import {createHandler,validate,upstreamBody} from './worker.mjs';
// Test-only compatibility shim. Values here are fixtures, never real credentials.
crypto.subtle.timingSafeEqual=(a,b)=>timingSafeEqual(new Uint8Array(a),new Uint8Array(b));
const body={date:'2026-11-10',materials:{review:'����������ʮ���ӡ�',preds:[],caps:[],hyps:[]}};
const env=()=>({ACCESS_TOKEN:'mock-access',AI_API_KEY:'mock-upstream',ALLOWED_ORIGIN:'https://zwgcb.cn',AI_BASE_URL:'https://primary.example/api',AI_BASE_URL_BACKUP:'https://backup.example/api',MODEL_SUMMARY:'summary-test',MODEL_EXPLORE:'explore-test',MAX_TOKENS_SUMMARY:'1024',MAX_TOKENS_EXPLORE:'2048',AI_RATE_LIMITER:{limit:async()=>({success:true})},ASSETS:{fetch:async()=>new Response('static')}});
const req=(path='/api/summary',data=body,opts={})=>new Request('https://zwgcb.cn'+path,{method:'POST',headers:{origin:'https://zwgcb.cn',authorization:'Bearer mock-access','content-type':'application/json',...opts.headers},body:typeof data==='string'?data:JSON.stringify(data),...Object.fromEntries(Object.entries(opts).filter(([k])=>k!=='headers'))});
const sse=text=>new Response(text||'data: {"type":"message_stop"}\n\n',{headers:{'content-type':'text/event-stream'}});
test('adaptive thinking, effort allowlist and token limits are server controlled',()=>{
 const e={...env(),MAX_TOKENS_SUMMARY:'8000',MAX_TOKENS_EXPLORE:'32000',EFFORT_SUMMARY:'high',EFFORT_EXPLORE:'xhigh'};
 const input=validate({...body,messages:[{role:'user',content:'��һ����'}]},'explore');
 for(const mode of ['summary','explore']){
  const b=upstreamBody(e,mode,input);assert.equal(b.max_tokens,mode==='summary'?8000:32000);
  assert.deepEqual(b.thinking,{type:'adaptive',display:'summarized'});assert.equal(b.output_config.effort,mode==='summary'?'high':'xhigh');
 }
 for(const effort of ['low','medium','high','xhigh','max',undefined,'','invalid']){
  const b=upstreamBody({...e,EFFORT_SUMMARY:effort},'summary',input);
  assert.deepEqual(b.output_config,['low','medium','high','xhigh','max'].includes(effort)?{effort}:undefined);
 }
 assert.equal(upstreamBody({...e,MAX_TOKENS_SUMMARY:'64000'},'summary',input).max_tokens,64000);
 for(const max of ['64001','0','NaN','1.5'])assert.throws(()=>upstreamBody({...e,MAX_TOKENS_SUMMARY:max},'summary',input));
});
test('400 retries exactly once with both optional fields removed and safe diagnostics',async()=>{
 for(const second of [200,400,401,429]){
  const calls=[];let canceled=false;const h=createHandler({fetcher:async(url,opts)=>{
   calls.push({url,body:JSON.parse(opts.body)});
   if(calls.length===1)return new Response(new ReadableStream({cancel(){canceled=true;}}),{status:400});
   return second===200?sse():new Response('private echoed material',{status:second});
  }});
  const r=await h(req(),{...env(),EFFORT_SUMMARY:'high'});
  assert.equal(calls.length,2);assert.equal(calls[0].url,calls[1].url);assert.equal(canceled,true);
  const {thinking,output_config,...plain}=calls[0].body;assert.ok(thinking);assert.ok(output_config);assert.deepEqual(calls[1].body,plain);
  assert.equal(r.headers.get('x-ai-effort'),'dropped');assert.equal(r.headers.get('x-ai-effort-fallback-status'),'400');assert.equal(r.status,second===200?200:502);assert.ok(!(await r.text()).includes('private'));
 }
});
test('success and in-stream errors never retry; original bytes and applied header preserved',async()=>{
 let calls=0;const bytes='data: {"type":"error","error":{"type":"invalid_request_error"}}\n\n';
 const h=createHandler({fetcher:async()=>{calls++;return sse(bytes);}});
 const r=await h(req(),{...env(),EFFORT_SUMMARY:'high'});assert.equal(r.headers.get('x-ai-effort'),'applied');assert.equal(await r.text(),bytes);assert.equal(calls,1);
});
test('connection deadline and idle deadline are independent; total budget includes connection',async()=>{
 let timer;const h=createHandler({timeoutMs:10,idleMs:100,streamMs:200,fetcher:async()=>new Response(new ReadableStream({start(c){timer=setTimeout(()=>{c.enqueue(new TextEncoder().encode('ok'));c.close();},35);},cancel(){clearTimeout(timer);}}),{headers:{'content-type':'text/event-stream'}})});
 assert.equal(await (await h(req(),env())).text(),'ok');
 let canceled=false;const total=createHandler({timeoutMs:200,idleMs:200,streamMs:60,fetcher:async()=>{await new Promise(r=>setTimeout(r,35));return new Response(new ReadableStream({start(c){timer=setInterval(()=>c.enqueue(new Uint8Array([1])),5);},cancel(){canceled=true;clearInterval(timer);}}),{headers:{'content-type':'text/event-stream'}});}});
 const start=Date.now(),r=await total(req(),env());await assert.rejects(()=>r.text());assert.ok(Date.now()-start<95);assert.equal(canceled,true);
});
test('routes, methods, origin, authorization and health avoid upstream calls',async()=>{
 const handler=createHandler({fetcher:()=>{throw Error('must not call upstream');}}),e=env();
 assert.equal((await handler(new Request('https://zwgcb.cn/'),e)).status,200);
 assert.equal((await handler(req('/api/unknown'),e)).status,404);
 assert.equal((await handler(new Request('https://zwgcb.cn/api/summary'),e)).status,405);
 for(const origin of ['', 'https://evil.example'])assert.equal((await handler(req('/api/summary',body,{headers:{origin}}),e)).status,403);
 for(const authorization of ['', 'mock-access','Bearer wrong'])assert.equal((await handler(req('/api/summary',body,{headers:{authorization}}),e)).status,401);
 const r=await handler(new Request('https://zwgcb.cn/api/health',{headers:{authorization:'Bearer mock-access'}}),e);
 assert.deepEqual(await r.json(),{ok:true,models:{summary:'summary-test',explore:'explore-test'}});
 assert.equal(r.headers.get('access-control-allow-origin'),null);
});
test('body validation checks real dates, roles, size, and drops untrusted parameters',async()=>{
 const h=createHandler({fetcher:async()=>sse()}),e=env();
 for(const b of [{...body,date:'2026-02-30'},{...body,materials:{}},{...body,materials:{caps:[{inten:9}]}},'{',null])assert.equal((await h(req('/api/summary',b),e)).status,400);
 assert.equal((await h(req('/api/summary',' '.repeat(65537)),e)).status,413);
 assert.equal((await h(req('/api/summary',body,{headers:{'content-length':'65537'}}),e)).status,413);
 for(const turns of [[],[{role:'system',content:'x'}],[{role:'assistant',content:'x'}],Array.from({length:61},()=>({role:'user',content:'x'}))])assert.equal((await h(req('/api/explore',{...body,messages:turns}),e)).status,400);
 const input=validate({...body,model:'attacker',max_tokens:100000,materials:{...body.materials,secret:'must disappear'}},'summary');
 assert.equal(input.model,undefined);assert.equal(input.materials.secret,undefined);
 const built=upstreamBody(e,'summary',input);assert.equal(built.model,'summary-test');assert.equal(built.max_tokens,1024);assert.equal(built.stream,true);
});
test('one shared authenticated rate bucket rejects request 11',async()=>{
 let n=0;const e=env();e.AI_RATE_LIMITER.limit=async({key})=>{assert.equal(key,'journal-owner');return {success:++n<=10};};
 const h=createHandler({fetcher:async()=>sse()});
 for(let i=0;i<11;i++)assert.equal((await h(req(),e)).status,i===10?429:200);
});
test('prompt caching keeps material prefix stable and marks latest user turn',()=>{
 const e=env(),first=upstreamBody(e,'explore',validate({...body,messages:[{role:'user',content:'�����￪ʼ��'}]},'explore'));
 const second=upstreamBody(e,'explore',validate({...body,messages:[{role:'user',content:'�����￪ʼ��'},{role:'assistant',content:'�㿨����һ����'},{role:'user',content:'���ĵ���'}]},'explore'));
 assert.deepEqual(first.messages[0],second.messages[0]);
 assert.equal(first.system[0].cache_control.type,'ephemeral');
 assert.equal(second.messages.at(-1).content[0].cache_control.type,'ephemeral');
 assert.equal(second.model,'explore-test');
});
test('fallback once before output; no fallback on auth or quota errors; no raw error leakage',async()=>{
 for(const fail of ['network',500,401,429]){
  const urls=[];const h=createHandler({fetcher:async(url)=>{urls.push(url);if(urls.length>1)return sse();if(fail==='network')throw Error('private detail');return new Response('private key and journal',{status:fail});}});
  const r=await h(req(),env());assert.equal(r.status,fail==='network'||fail===500?200:502);
  assert.equal(urls.length,fail==='network'||fail===500?2:1);assert.ok(!(await r.text()).includes('private'));
 }
});
test('timeouts return 504; request cancellation aborts outgoing fetch',async()=>{
 const hold=(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 const h=createHandler({fetcher:hold,timeoutMs:20}),e=env();
 const alive=setTimeout(()=>{},300);
 assert.equal((await h(req(),e)).status,504);
 const ctl=new AbortController();const p=h(req('/api/summary',body,{signal:ctl.signal}),e);setTimeout(()=>ctl.abort(),5);
 assert.equal((await p).status,499);clearTimeout(alive);
});
test('SSE bytes arrive incrementally, body cancel cancels upstream, no buffering or parsing',async()=>{
 let source,canceled=false;
 const stream=new ReadableStream({start(c){source=c;c.enqueue(new TextEncoder().encode('data: first\n\n'));},cancel(){canceled=true;}});
 const h=createHandler({fetcher:async()=>new Response(stream,{headers:{'content-type':'text/event-stream'}})});
 const r=await h(req(),env()),reader=r.body.getReader();
 assert.equal(r.headers.get('cache-control'),'no-store');
 assert.equal(new TextDecoder().decode((await reader.read()).value),'data: first\n\n');
 source.enqueue(new TextEncoder().encode('data: second\n\n'));
 assert.equal(new TextDecoder().decode((await reader.read()).value),'data: second\n\n');
 await reader.cancel();assert.equal(canceled,true);
});
test('upstream authentication and endpoints are configuration, never frontend input',async()=>{
 const e=env();e.AI_AUTH_MODE='bearer';let call;
 const h=createHandler({fetcher:async(url,options)=>{call={url,...options};return sse();}});await h(req(),e);
 assert.equal(call.url,'https://primary.example/api/v1/messages');assert.equal(call.headers.authorization,'Bearer mock-upstream');assert.equal(call.headers['x-api-key'],undefined);
});
test('307/308 keeps POST only inside configured origins; external targets never get credentials',async()=>{
 const calls=[];const h=createHandler({fetcher:async(url,opts)=>{calls.push({url,method:opts.method,redirect:opts.redirect});return calls.length===1?new Response(null,{status:307,headers:{location:'/api/v1/messages/'}}):sse();}});
 const r=await h(req(),env());assert.equal(r.status,200);assert.equal(calls[1].url,'https://primary.example/api/v1/messages/');assert.equal(calls[1].method,'POST');assert.equal(calls[0].redirect,'manual');
 assert.equal(r.headers.get('x-ai-redirected'),'true');assert.equal(r.headers.get('x-ai-redirect-domain'),'primary.example');assert.equal(r.headers.get('x-ai-upstream-url'),null);assert.equal(r.headers.get('x-ai-redirects'),null);
 const blocked=[];const no=createHandler({fetcher:async(url)=>{blocked.push(url);return new Response(null,{status:307,headers:{location:'https://unapproved.example/collect'}});}});
 assert.equal((await no(req(),env())).status,502);assert.deepEqual(blocked,['https://primary.example/api/v1/messages','https://backup.example/api/v1/messages']);
});
test('redirect diagnostics omit credentials and query values',async()=>{
 let n=0;const h=createHandler({fetcher:async()=>++n===1?new Response(null,{status:307,headers:{location:'/mock-upstream/mock-access?token=private'}}):sse()});
 const r=await h(req(),env()),d=JSON.stringify([...r.headers]);
 assert.ok(!d.includes('mock-upstream'));assert.ok(!d.includes('mock-access'));assert.ok(!d.includes('private'));assert.equal(r.headers.get('x-ai-redirect-domain'),'primary.example');
});
test('active bytes can continue longer than the connection timeout; stalled streams cancel upstream',async()=>{
 let n=0,timer;
 const source=new ReadableStream({start(c){timer=setInterval(()=>{c.enqueue(new TextEncoder().encode('data: '+n+++'\n\n'));if(n===6){clearInterval(timer);c.close();}},10);},cancel(){clearInterval(timer);}});
 const active=createHandler({fetcher:async()=>new Response(source,{headers:{'content-type':'text/event-stream'}}),timeoutMs:35,streamMs:250});
 const r=await active(req(),env());assert.match(await r.text(),/data: 5/);
 let canceled=false;
 const stalled=createHandler({fetcher:async()=>new Response(new ReadableStream({cancel(){canceled=true;}}),{headers:{'content-type':'text/event-stream'}}),timeoutMs:20,idleMs:20,streamMs:250});
 const s=await stalled(req(),env()),alive=setTimeout(()=>{},300);
 await assert.rejects(()=>s.text());assert.equal(canceled,true);clearTimeout(alive);
});
