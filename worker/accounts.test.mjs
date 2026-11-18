import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {createHandler} from './worker.mjs';
crypto.subtle.timingSafeEqual=(a,b)=>timingSafeEqual(new Uint8Array(a),new Uint8Array(b));
const enc=n=>randomBytes(n).toString('base64url');
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec('PRAGMA foreign_keys=ON;'+readFileSync(new URL('./migrations/0001_accounts.sql',import.meta.url),'utf8'));
 const wrap=(sql,v=[])=>{const q=db.prepare(sql);return {bind:(...a)=>wrap(sql,a.map(x=>x instanceof ArrayBuffer?new Uint8Array(x):x)),first:async()=>q.get(...v),all:async()=>({results:q.all(...v),meta:{size_after:4096}}),run:async()=>({meta:{changes:q.run(...v).changes}}),query:/^SELECT/i.test(sql)};};
 const VAULT={prepare:wrap,batch:async ops=>{db.exec('BEGIN');try{const result=[];for(const op of ops)result.push(await (op.query?op.all():op.run()));db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}};
 const env={VAULT,ALLOWED_ORIGIN:'https://zwgcb.cn',AUTH_PEPPER:enc(32),ACCESS_TOKEN:enc(24),AI_RATE_LIMITER:{limit:async()=>({success:true})}};
 const make=(username,invite)=>({username,invite,kdf_salt:enc(16),authKey:enc(32),recoveryAuth:enc(32),wrapped_keys:enc(92),recovery_wrapped:enc(92)});
 const api=async(path,b,c='',headers={})=>{const r=await createHandler()(new Request(env.ALLOWED_ORIGIN+'/api/'+path,{method:b===undefined?'GET':'POST',headers:{origin:env.ALLOWED_ORIGIN,'content-type':'application/json',Cookie:c,...headers},body:JSON.stringify(b)}),env);return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0],retry:r.headers.get('retry-after')};};
 return {db,env,make,api};
}
async function users(t){
 const f=fixture(t),{db,env,make,api}=f,admin=make('owner',env.ACCESS_TOKEN);
 assert.equal((await api('auth/register',admin)).status,201);const ac=(await api('auth/login',admin)).cookie,invite=(await api('admin/invite',{},ac)).body.code;
 const user=make('reader',invite);assert.equal((await api('auth/register',user)).status,201);const login=await api('auth/login',user);
 return {...f,ac,user,uc:login.cookie,id:login.body.user.id,db};
}
test('invitations expire or revoke; deletion requires the exact name and leaves the admin intact',async t=>{
 const {db,ac,id,uc,api,make}=await users(t);
 for(const kind of ['revoked','expired']){
  const code=(await api('admin/invite',{},ac)).body.code;
  if(kind==='revoked'){const {id}=db.prepare('SELECT id FROM invites WHERE used_by IS NULL AND revoked=0').get();await api('admin/revoke',{id},ac);}
  else db.exec('UPDATE invites SET expires_at=0 WHERE used_by IS NULL');
  assert.notEqual((await api('auth/register',make('new_'+kind,code))).status,201);
 }
 assert.equal((await api('admin/user',{action:'delete',id,confirm:'typo'},ac)).status,400);
 db.exec('CREATE TABLE docs(user_id TEXT,k TEXT, size INTEGER,deleted INTEGER); CREATE TABLE history(user_id TEXT,k TEXT);');
 db.prepare('INSERT INTO docs VALUES(?,?,?,0)').run(id,'sample',128);db.prepare('INSERT INTO history VALUES(?,?)').run(id,'sample');
 const stats=(await api('admin/overview',undefined,ac)).body.users.find(x=>x.id===id);assert.equal(stats.doc_count,1);assert.equal(stats.used_bytes,128);assert.ok(!('k' in stats));
 assert.equal((await api('admin/user',{action:'delete',id,confirm:'reader'},ac)).status,200);assert.equal((await api('auth/me',undefined,uc)).status,401);
 for(const table of ['docs','history'])assert.equal(db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n,0);
 assert.equal((await api('auth/me',undefined,ac)).body.user.role,'admin');
});
test('a reset is short-lived, single use, and revokes existing sessions',async t=>{
 const {db,user,api,uc}=await users(t);
 const start=()=>api('auth/recover/start',{username:user.username,recoveryAuth:user.recoveryAuth});
 const finish=token=>api('auth/recover/finish',{token,kdf_salt:enc(16),authKey:enc(32),wrapped_keys:enc(92)});
 const first=(await start()).body.token;db.exec('UPDATE resets SET expires_at=0');assert.equal((await finish(first)).status,401);
 const token=(await start()).body.token;assert.equal((await finish(token)).status,200);assert.equal((await finish(token)).status,401);assert.equal((await api('auth/me',undefined,uc)).status,401);
});
test('cookie slides hourly, expires, checks origin; user cannot use legacy credentials alongside session',async t=>{
 const {db,id,uc,env,api}=await users(t);
 assert.equal((await api('auth/me',undefined,uc)).cookie,undefined);
 db.prepare('UPDATE sessions SET last_seen=? WHERE user_id=?').run(Date.now()-3600001,id);assert.equal((await api('auth/me',undefined,uc)).cookie,uc);
 assert.equal((await api('auth/logout',{},uc,{origin:'https://other.example'})).status,403);
 assert.equal((await api('health',undefined,uc,{authorization:'Bearer '+env.ACCESS_TOKEN})).status,403);
 db.prepare('UPDATE sessions SET expires_at=0 WHERE user_id=?').run(id);assert.equal((await api('auth/me',undefined,uc)).status,401);
});
test('IP failure limit applies across distinct usernames; fake salts are stable and account-specific',async t=>{
 const {api}=fixture(t),salt=async n=>(await api('auth/salt?u='+n)).body.kdf_salt;assert.equal(await salt('abc'),await salt('abc'));assert.notEqual(await salt('abc'),await salt('abcd'));
 for(let i=0;i<20;i++){const r=await api('auth/login',{username:'test_'+i,authKey:enc(32)});assert.equal(r.status,i===19?429:401);if(i===19)assert.ok(Number(r.retry)>=3599);}
});
