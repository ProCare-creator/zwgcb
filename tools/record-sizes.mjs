// Measure with the page's actual envelope, compression and AES-GCM implementation.
// Only counts and ciphertext lengths leave this process. No keys from the journal are needed.
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import assert from 'node:assert/strict';

const collections = ['days','hyps','weeks','events','archives','meta'];
const source = await readFile(new URL('../ui/vault-sync.js', import.meta.url), 'utf8');
const encryptSource = source.slice(source.indexOf('async function vaultEncrypt('), source.indexOf('async function vaultDecrypt('));
const dek = await crypto.subtle.generateKey({name:'AES-GCM',length:256}, false, ['encrypt']);
const encryptSize = runInNewContext(encryptSource + '\nvaultEncrypt', {
  vUTF:new TextEncoder(), Blob, Response, CompressionStream, crypto, vault:{keys:{dek}},
  accountUser:{id:'fixture'}, v64:packed => packed.byteLength
});

function synthetic() {
  const date = '2000-01-01', stamp = Date.UTC(2000,0,1);
  let seed = 928371;
  const alphabet=Array.from({length:94},(_,i)=>String.fromCharCode(33+i)).filter(c=>c!=='"' && c!=='\\');
  function chars(n) {
    let s='';
    while(s.length<n) {
      seed ^= seed<<13; seed ^= seed>>>17; seed ^= seed<<5;
      s+=alphabet[(seed>>>0)%alphabet.length];
    }
    return s;
  }
  function conversation(count, fillBytes) {
    const id='00000000-0000-4000-8000-000000000001';
    const ctx={date,materials:{review:chars(200),preds:[],caps:[],hyps:[]}};
    const messages=Array.from({length:count},(_,i)=>{
      // An interrupted request can leave a user message without a reply.
      const role=(count-i)%2===0 && i!==0?'assistant':'user';
      return {role,content:chars(fillBytes?1260:120),at:new Date(stamp+i*1000).toISOString(),
        ...(role==='assistant'?{stopReason:'end_turn'}:{}),...(i===0?{ctx}:{})};
    });
    const requestSize=()=>Buffer.byteLength(JSON.stringify({messages:messages.map(({role,content,ctx})=>({role,content,ctx})),hyps:[]}));
    if(fillBytes) messages.at(-1).content+=chars(256*1024-requestSize());
    const requestBytes=requestSize();
    assert.equal(messages.at(-1).role,'user');
    assert.ok(requestBytes<=256*1024 && count<=200);
    if(fillBytes) assert.equal(requestBytes,256*1024);
    const updated=new Date(stamp+count*1000).toISOString();
    messages.push({role:'assistant',content:chars(256),at:updated,stopReason:'end_turn'});
    const value={id,title:messages[0].content.slice(0,20),created:messages[0].at,updated,messages,cards:{},_t:stamp+count*1000};
    return {value,requestBytes};
  }
  return [conversation(200,false),conversation(199,true)];
}

async function run() {
  const arg=process.argv[2];
  if(!arg || process.argv.length!==3) throw Error();
  if(arg==='--synthetic') {
    for(const {value,requestBytes} of synthetic()) {
      const size=await encryptSize({col:'meta',id:'chat:'+value.id,stamp:value._t,value,k:'fixture'});
      console.log(JSON.stringify({collection:'meta',requestMessages:value.messages.length-1,requestBytes,ciphertextBytes:size}));
    }
    return;
  }
  const data=JSON.parse((await readFile(arg,'utf8')).replace(/^\uFEFF/,''));
  if(!data || !collections.some(c=>Object.hasOwn(data,c))) throw Error();
  for(const col of collections) {
    const records=data[col]??{};
    if(typeof records!=='object' || Array.isArray(records)) throw Error();
    const sizes=[];
    for(const [id,value] of Object.entries(records)) {
      if(!value || typeof value!=='object') throw Error();
      const stamp=value._t || (col==='meta' && id==='tlcats'?records.tlcatsUpdated?._t:0) || 0;
      sizes.push(await encryptSize({col,id,stamp,value,k:'fixture'}));
    }
    sizes.sort((a,b)=>b-a);
    console.log(JSON.stringify({collection:col,count:sizes.length,maximumBytes:sizes[0]??0,
      over64KiB:sizes.filter(n=>n>65536).length,over128KiB:sizes.filter(n=>n>131072).length,
      over256KiB:sizes.filter(n=>n>262144).length,largestFiveBytes:sizes.slice(0,5)}));
  }
}
run().catch(()=>{console.error('无法完成测量。请提供自我观察本 JSON 导出文件路径，或使用 --synthetic。');process.exitCode=1;});
