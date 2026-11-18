import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {timingSafeEqual} from 'node:crypto';
const source=readFileSync(new URL('./account-crypto.js',import.meta.url),'utf8');
const c=vm.runInNewContext(source+';accountCrypto',{crypto,TextEncoder,Uint8Array,btoa,atob,performance});
test('password and recovery protect the same 64 random key bytes with fresh IVs',async()=>{
 const secret=c.data(),salt=c.salt(),p=await c.password(c.salt(),salt),code=await c.code(),recovery=await c.recovery(code);
 assert.ok(/^(?:[a-zA-Z0-9._]{4}-){5}[a-zA-Z0-9._]{4}$/.test(code));assert.ok(p.authKey!==recovery.auth);
 const first=await c.wrap(p.kek,secret),second=await c.wrap(p.kek,secret),backup=await c.wrap(recovery.kek,secret);
 assert.ok(first!==second&&second!==backup);assert.ok(timingSafeEqual(await c.unwrap(p.kek,first),secret));assert.ok(timingSafeEqual(await c.unwrap(recovery.kek,backup),secret));
 await assert.rejects(()=>c.unwrap(p.kek,backup));await assert.rejects(()=>c.recovery(code.slice(0,-1)+(code.endsWith('a')?'b':'a')));
 const {dek,mack}=await c.keys(secret);await assert.rejects(()=>crypto.subtle.exportKey('raw',dek));await assert.rejects(()=>crypto.subtle.exportKey('raw',mack));
});
