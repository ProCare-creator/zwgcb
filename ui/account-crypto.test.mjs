import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {timingSafeEqual} from 'node:crypto';
const source=readFileSync(new URL('./account-crypto.js',import.meta.url),'utf8');
const c=vm.runInNewContext(source+';accountCrypto',{crypto,TextEncoder,Uint8Array,btoa,atob,performance});
test('recovery transcription accepts ambiguous letters but rejects noncanonical high bits',async()=>{
 const fixed=vm.runInNewContext(source+';accountCrypto',{crypto:{subtle:crypto.subtle,getRandomValues:a=>{a.fill(0);a[a.length-1]=1;return a;}},TextEncoder,Uint8Array,btoa,atob,performance});
 const code=await fixed.code(),base=(await fixed.recovery(code)).auth;
 for(const one of ['I','l'])assert.ok((await fixed.recovery(code.toLowerCase().replaceAll('-',' - ').replaceAll('0','o').replaceAll('1',one))).auth===base);
 for(const first of ['8','U','!'])await assert.rejects(()=>fixed.recovery(first+code.slice(1)));
});
test('password derivation rejects missing, noninteger and out-of-range work factors',async()=>{
 const salt=c.salt();for(const n of [undefined,null,'600000',99999,100000.5,2000001])await assert.rejects(()=>c.password('sample',salt,n),/次数/);
 const low=await c.password('sample',salt,100000),high=await c.password('sample',salt,2000000);assert.ok(low.authKey!==high.authKey);
});
test('password and recovery protect the same 64 random key bytes with fresh IVs',async()=>{
 const secret=c.data(),salt=c.salt(),p=await c.password(c.salt(),salt,c.defaultIter),code=await c.code(),recovery=await c.recovery(code);
 assert.ok(/^(?:[0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{4}$/.test(code));assert.ok(p.authKey!==recovery.auth);
 const first=await c.wrap(p.kek,secret),second=await c.wrap(p.kek,secret),backup=await c.wrap(recovery.kek,secret);
 assert.ok(first!==second&&second!==backup);assert.ok(timingSafeEqual(await c.unwrap(p.kek,first),secret));assert.ok(timingSafeEqual(await c.unwrap(recovery.kek,backup),secret));
 await assert.rejects(()=>c.unwrap(p.kek,backup));await assert.rejects(()=>c.recovery(code.slice(0,-1)+(code.endsWith('A')?'B':'A')));
 const {dek,mack}=await c.keys(secret);await assert.rejects(()=>crypto.subtle.exportKey('raw',dek));await assert.rejects(()=>crypto.subtle.exportKey('raw',mack));
});
