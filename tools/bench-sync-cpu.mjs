// Node 22+. Run from a checkout of the Worker to measure, or pass --worker=/path/to/worker.mjs.
// Input construction and client-side JSON parsing are outside the sample. D1 returns
// prefabricated rows, so database execution and D1 binding serialization are excluded.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cpus } from 'node:os';
import { adminCookie, sessionVault } from '../worker/session-fixture.mjs';
import {syncLimits} from '../worker/sync-limits.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(s => s.replace(/^--/, '').split('=')));
const { createHandler } = await import(args.worker ? pathToFileURL(resolve(args.worker)).href : '../worker/worker.mjs');
const handle = createHandler();
const origin = 'https://bench.invalid';
const usage = process.threadCpuUsage?.bind(process) ?? process.cpuUsage.bind(process);

// Isolate V8 primitives used after D1 has returned a row. Prepare each stage's
// input outside its timer. Whole-route samples below also cover composed costs.
async function stages(size) {
  const {rows}=fixture(1,size), row=rows[0], array=row.body;
  const bytes=new Uint8Array(array);
  const base64=bytes.toBase64();
  const doc={...row,body:base64,deleted:false};
  const page={docs:[doc],next:1,more:false};
  const json=JSON.stringify(page), encoder=new TextEncoder(), chunk=encoder.encode(json);
  async function sample(label,fn) {
    let keep;
    for(let i=0;i<4;i++) keep=await fn();
    const blocks=[];
    for(let block=0;block<5;block++) {
      const start=usage(); let n=0, cpu=0;
      do {
        keep=await fn(); n++;
        const elapsed=usage(start); cpu=elapsed.system+elapsed.user;
      } while(cpu<120000);
      blocks.push(cpu/n/1000);
    }
    assert.ok(keep);
    console.log(label,blocks.sort((a,b)=>a-b)[2].toFixed(3));
  }
  await sample('D1 array -> Uint8Array (constructor)',()=>new Uint8Array(array));
  await sample('D1 array -> Uint8Array (set)',()=>{const b=new Uint8Array(array.length);b.set(array);return b;});
  await sample('native base64',()=>bytes.toBase64());
  await sample('pull JSON.stringify',()=>JSON.stringify(page));
  await sample('backup row JSON.stringify',()=>JSON.stringify(doc));
  await sample('UTF-8 encode',()=>encoder.encode(json));
  const fragments=()=> {
    const {body,...fields}=doc;
    return [JSON.stringify({next:1,more:false}).slice(0,-1),',"docs":[',
      JSON.stringify(fields).slice(0,-1),',"body":"',body,'"}]}'];
  };
  await sample('optimized metadata JSON',fragments);
  const parts=fragments();
  await sample('optimized fragments -> UTF-8',()=>{
    const out=new Uint8Array(parts.reduce((n,s)=>n+s.length,0));
    let offset=0;
    for(const s of parts) offset+=encoder.encodeInto(s,out.subarray(offset)).written;
    return out;
  });
  await sample('write and drain response stream',async()=>{
    const res=new Response(new ReadableStream({start(c){c.enqueue(chunk);c.close();}}));
    for await(const part of res.body) assert.equal(part.length,chunk.length);
    return true;
  });
}

function fixture(count, size) {
  const bytes = Buffer.alloc(size, 165);
  const blob = Array.from(bytes); // D1 SELECT returns a BLOB as an array of byte values
  const body = bytes.toString('base64');
  const rows = Array.from({length:count}, (_, i) => ({
    k: String(i).padStart(43, '0'), ver:1, seq:i+1, size, body:blob, deleted:0, mtime:1, updated_at:1
  }));
  const meta = rows.map(({seq, size}) => ({seq, size}));
  const stats = {seq:count, count, bytes:count*size, quota:52428800, history_rev:0};
  const VAULT = {
    prepare(sql) {
      if (sql.includes('FROM sessions')) return sessionVault.prepare(sql);
      return {bind(...values) {
        return {
          values,
          first:async () => stats,
          all:async () => {
            if (sql.includes('FROM history')) return {results:[]};
            if (sql.startsWith('SELECT seq,size')) return {results:meta.slice(values[1], values[1]+values[2])};
            if (sql.includes('FROM docs')) return {results:rows.slice(values[1], values[2])};
            throw Error('Unexpected query: ' + sql);
          }
        };
      }};
    },
    batch: async ops => ops.map((op,i) => ({results:[{k:op.values[0], ver:1, seq:i+1}]}))
  };
  const input = Buffer.from(JSON.stringify({docs:rows.map(({k}) => ({k, baseVer:null, mtime:1, deleted:false, body}))}));
  const env = {VAULT, ALLOWED_ORIGIN:origin, SYNC_RATE_LIMITER:{limit:async () => ({success:true})}};
  return {rows, input, env};
}

async function measure(route, fixture) {
  const post = route === 'push';
  const headers = {origin, cookie:adminCookie, 'content-type':'application/json'};
  const request = () => new Request(origin + '/api/sync/' + route, post ?
    {method:'POST', headers, body:fixture.input} : {headers});
  const execute = async req => {
    const response = await handle(req, fixture.env);
    assert.equal(response.status, 200);
    // Drain streaming backup on the Worker side. Do not charge client JSON parsing.
    for await (const chunk of response.body) assert.ok(chunk.length);
  };
  const check = await handle(request(), fixture.env);
  const result = await check.json();
  assert.equal(check.status, 200, JSON.stringify(result.error));
  assert.equal((post ? result.written : result.docs).length, fixture.rows.length);
  for(let i=0;i<3;i++) await execute(request());
  // Accumulate across requests to avoid the OS CPU timer quantum. Each displayed
  // sample is a mean over at least 180 ms of CPU, not a per-request percentile.
  const samples = [];
  for (let block=0;block<5;block++) {
    let cpu=0, n=0;
    while(cpu<180000) {
      const req=request(), start=usage();
      await execute(req);
      const elapsed=usage(start);
      cpu+=elapsed.user+elapsed.system;
      n++;
    }
    samples.push(cpu/n/1000);
  }
  samples.sort((a,b)=>a-b);
  return [samples[2], samples.at(-1)].map(n=>n.toFixed(2)).join(' / ');
}

const cases = args.bytes ? [[Number(args.count||1),Number(args.bytes)]] :
  args.sweep ? [[1,65536],[1,131072],[1,262144],[1,524288],[100,1310]] :
  args.worker ? [[100,3000],[100,29850],[1,1900000],[100,28000]] :
  [[1,syncLimits.docBytes],[syncLimits.maxDocs,Math.floor(syncLimits.batchBytes/syncLimits.maxDocs)]];
console.log(process.version, cpus()[0].model, 'CPU ms: median / slowest block average');
if(args.stages){await stages(Number(args.bytes??1900000));process.exit(0);}
for(const [count,size] of cases) {
  const f=fixture(count,size);
  const routes=args.routes?.split(',') ?? (count===100 && size===29850 ? ['push','backup'] : ['push','pull','backup']);
  for(const route of routes) console.log(count,size,route,await measure(route,f));
}
