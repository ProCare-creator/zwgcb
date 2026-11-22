import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {createHandler} from './worker.mjs';
const enc=n=>randomBytes(n).toString('base64url');
test('second migration preserves existing users and gives their original credentials 600000 iterations',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const sql=file=>readFileSync(new URL('./migrations/'+file,import.meta.url),'utf8');
 db.exec(sql('0001_accounts.sql'));
 db.exec("INSERT INTO users(id,username,role,kdf_salt,auth_hash,wrapped_keys,recovery_wrapped,recovery_hash,created_at,last_seen) VALUES('1','existing','user',randomblob(16),randomblob(32),randomblob(92),randomblob(92),randomblob(32),1,1)");
 const before=db.prepare('SELECT * FROM users').get();db.exec(sql('0002_user_kdf_iter.sql'));
 const {kdf_iter,...after}=db.prepare('SELECT * FROM users').get();assert.equal(kdf_iter,600000);assert.deepEqual(after,{...before});
 assert.throws(()=>db.exec('UPDATE users SET kdf_iter=99999'));
});
function fixture(t,sync=false){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec('PRAGMA foreign_keys=ON;'+readFileSync(new URL('./migrations/0001_accounts.sql',import.meta.url),'utf8'));
 db.exec(readFileSync(new URL('./migrations/0002_user_kdf_iter.sql',import.meta.url),'utf8'));
 if(sync)for(const migration of ['0003_cloud_sync.sql','0004_history_quota.sql'])db.exec(readFileSync(new URL('./migrations/'+migration,import.meta.url),'utf8'));
 const wrap=(sql,v=[])=>{const q=db.prepare(sql);return {bind:(...a)=>wrap(sql,a.map(x=>x instanceof ArrayBuffer?new Uint8Array(x):x)),first:async()=>q.get(...v),all:async()=>({results:q.all(...v),meta:{size_after:4096}}),run:async()=>({meta:{changes:q.run(...v).changes}}),query:/^SELECT|RETURNING /i.test(sql)};};
 const VAULT={prepare:wrap,batch:async ops=>{db.exec('BEGIN');try{const result=[];for(const op of ops)result.push(await (op.query?op.all():op.run()));db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}};
 const env={VAULT,SYNC_RATE_LIMITER:{limit:async()=>({success:true})},ALLOWED_ORIGIN:'https://zwgcb.cn',AUTH_PEPPER:enc(32),ACCESS_TOKEN:enc(24),AI_RATE_LIMITER:{limit:async()=>({success:true})}};
 const make=(username,invite)=>({username,invite,kdf_salt:enc(16),authKey:enc(32),recoveryAuth:enc(32),wrapped_keys:enc(92),recovery_wrapped:enc(92)});
 const api=async(path,b,c='',headers={})=>{const r=await createHandler()(new Request(env.ALLOWED_ORIGIN+'/api/'+path,{method:b===undefined?'GET':'POST',headers:{origin:env.ALLOWED_ORIGIN,'content-type':'application/json',Cookie:c,...headers},body:JSON.stringify(b)}),env);return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0],retry:r.headers.get('retry-after')};};
 return {db,env,make,api};
}
async function users(t,sync=false){
 const f=fixture(t,sync),{db,env,make,api}=f,admin=make('owner',enc(32));
 db.prepare('INSERT INTO invites(code_hash,id,created_at,expires_at) VALUES(?,?,?,?)').run(createHash('sha256').update(admin.invite).digest(), 'seed', Date.now(), Date.now()+60000);
 assert.equal((await api('auth/register',admin)).status,201);
 db.exec("UPDATE users SET role='admin' WHERE username='owner'");
 const ac=(await api('auth/login',admin)).cookie,invite=(await api('admin/invite',{},ac)).body.code;
 const user=make('reader',invite);assert.equal((await api('auth/register',user)).status,201);const login=await api('auth/login',user);
 return {...f,ac,user,uc:login.cookie,id:login.body.user.id,db};
}
test('iterations belong to the credential and update atomically on password change and recovery',async t=>{
 const {api,user,uc,make}=await users(t),params=async u=>(await api('auth/salt?u='+u)).body;
 for(const u of ['owner','reader','unknown'])assert.equal((await params(u)).kdf_iter,600000);
 const next=make('reader','');
 for(const n of [99999,2000001,null,'150000',123456.5])assert.equal((await api('auth/password',{...next,currentAuth:user.authKey,kdf_iter:n},uc)).status,400);
 assert.equal((await params('reader')).kdf_salt,user.kdf_salt);
 assert.equal((await api('auth/password',{...next,currentAuth:user.authKey,kdf_iter:180000},uc)).status,200);
 assert.equal((await params('reader')).kdf_iter,180000);assert.equal((await params('owner')).kdf_iter,600000);
 const tok=(await api('auth/recover/start',{username:'reader',recoveryAuth:user.recoveryAuth})).body.token;
 assert.equal((await api('auth/recover/finish',{...user,token:tok,kdf_iter:750000})).status,200);
 assert.equal((await params('reader')).kdf_iter,750000);
});
test('invitations expire or revoke; deletion requires the exact name and leaves the admin intact',async t=>{
 const {db,ac,id,uc,api,make}=await users(t,true);
 for(const kind of ['revoked','expired']){
  const code=(await api('admin/invite',{},ac)).body.code;
  if(kind==='revoked'){const {id}=db.prepare('SELECT id FROM invites WHERE used_by IS NULL AND revoked=0').get();await api('admin/revoke',{id},ac);}
  else db.exec('UPDATE invites SET expires_at=0 WHERE used_by IS NULL');
  assert.notEqual((await api('auth/register',make('new_'+kind,code))).status,201);
 }
 assert.equal((await api('admin/user',{action:'delete',id,confirm:'typo'},ac)).status,400);
 db.prepare('INSERT INTO docs(user_id,k,ver,seq,size,mtime,body,deleted,updated_at) VALUES(?,?,1,1,128,0,zeroblob(128),0,0)').run(id,'sample');
 db.prepare('INSERT INTO history(user_id,k,ver,body,size,saved_at) VALUES(?,?,-1,zeroblob(40),40,0)').run(id,'sample');
 const stats=(await api('admin/overview',undefined,ac)).body.users.find(x=>x.id===id);assert.equal(stats.doc_count,1);assert.equal(stats.used_bytes,168);assert.ok(!('k' in stats));
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

test('retired token alone grants neither registration on an empty database nor AI access',async t=>{
 const {db,env,make,api}=fixture(t);
 assert.equal((await api('auth/register',make('first',env.ACCESS_TOKEN))).status,401);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n,0);
 for(const path of ['health','summary','explore','chat','hyps']){
  assert.equal((await api(path,path==='health'?undefined:{},'',{authorization:'Bearer '+env.ACCESS_TOKEN})).status,401);
 }
});

test('sync CAS, per-account sequences, partial conflicts, history, deletion, quota and pagination',async t=>{
 const {db,api,ac,uc,id}=await users(t,true);
 const make=(k,baseVer=null)=>({k,baseVer,deleted:false,mtime:100,body:randomBytes(40).toString('base64')});
 const a=make(enc(32)),b=make(enc(32)),c=make(enc(32));
 const push=(docs,cookie=uc)=>api('sync/push',{docs},cookie);
 assert.equal((await push([a,b])).body.written.length,2);
 assert.deepEqual((await api('sync/pull?since=0&limit=1',undefined,uc)).body.docs.map(d=>d.k),[a.k]);
 const mixed=await push([a,c]);assert.deepEqual(mixed.body.conflicts,[{k:a.k,ver:1}]);assert.equal(mixed.body.written[0].seq,3);
 assert.equal((await api('sync/pull?since=1&user_id='+id,undefined,ac)).body.docs.length,0);
 assert.equal((await api('sync/push',{user_id:id,docs:[a]},ac)).body.written[0].seq,1);
 assert.equal((await push([{...a,baseVer:1}])).body.written[0].ver,2);
 db.prepare('UPDATE users SET quota_bytes=200 WHERE id=?').run(id);
 const failed=await push([{...a,baseVer:2},make(enc(32))]);assert.equal(failed.status,413);assert.equal(failed.body.error.code,'quota_exceeded');
 const current=(await api('sync/pull?since=0',undefined,uc)).body;assert.equal(current.stats.seq,4);assert.equal(current.stats.bytes,160);
 db.prepare('UPDATE users SET quota_bytes=1 WHERE id=?').run(id);
 assert.equal((await push([{...a,baseVer:2,deleted:true,body:null}])).body.written[0].seq,5);
 const variant=()=>({...make(a.k,3),archiveOnly:true,variant:enc(32)});
 const loser=variant(),other=variant();
 assert.equal((await push([loser])).body.error.code,'quota_exceeded');
 db.prepare('UPDATE users SET quota_bytes=240 WHERE id=?').run(id);
 for(const doc of [loser,other,loser])assert.deepEqual((await push([doc])).body.conflicts,[]);
 assert.equal((await api('sync/pull',undefined,uc)).body.stats.bytes,240);
 const saved=(await api('sync/backup',undefined,uc)).body;assert.equal(saved.docs.length,3);assert.equal(saved.docs.filter(x=>x.deleted).length,1);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM history WHERE user_id=?').get(id).n,4);assert.equal(saved.history.length,4);assert.ok(saved.history.some(h=>h.body===other.body));
});
test('sync rejects invalid origin, missing cookies and oversize docs before writing; limiter separate from AI',async t=>{
 const {env,api,uc}=await users(t,true),d={k:enc(32),baseVer:null,body:randomBytes(1900001).toString('base64'),deleted:false,mtime:1};
 assert.equal((await api('sync/push',{docs:[d]},uc)).body.error.code,'doc_too_large');
 assert.equal((await api('sync/push',{docs:Array(101).fill(null)},uc)).status,400);
 assert.equal((await api('sync/push',{docs:[]},uc,{origin:'https://other.example'})).status,403);
 assert.equal((await api('sync/backup')).status,401);
 env.AI_RATE_LIMITER.limit=async()=>({success:false});assert.equal((await api('sync/pull',undefined,uc)).status,200);
 env.SYNC_RATE_LIMITER.limit=async()=>({success:false});assert.equal((await api('sync/pull',undefined,uc)).status,429);
});

test('history migration counts existing ciphertext and releases bytes when old versions expire',async t=>{
 const {db,id}=await users(t);
 const migrate=file=>db.exec(readFileSync(new URL('./migrations/'+file,import.meta.url),'utf8'));
 migrate('0003_cloud_sync.sql');
 const day=86400000, now=Date.now();
 db.prepare('INSERT INTO docs(user_id,k,ver,seq,size,mtime,body,deleted,updated_at) VALUES(?,?,1,1,40,0,zeroblob(40),0,0)').run(id,'sample');
 const archive=db.prepare('INSERT INTO history(user_id,k,ver,body,size,saved_at) VALUES(?,?,?,zeroblob(30),30,?)');
 for(let version=1;version<=12;version++)archive.run(id,'sample',version,now-40*day+version);
 const used=()=>db.prepare('SELECT sync_bytes AS n FROM users WHERE id=?').get(id).n;
 assert.equal(used(),40);
 migrate('0004_history_quota.sql');
 assert.equal(used(),400);
 archive.run(id,'sample',-1,now);
 assert.equal(used(),340); // live + the most recent ten histories
 for(let n=2;n<=15;n++)archive.run(id,'sample',-n,now+n);
 assert.equal(used(),490); // all fifteen recent versions survive
});

test('backup detects a simultaneous history replacement even when row count and bytes stay equal',async t=>{
 const {db,env,api,id,uc}=await users(t,true);
 const insert=db.prepare('INSERT INTO history(user_id,k,ver,body,size,saved_at) VALUES(?,?,?,zeroblob(40),40,?)');
 const now=Date.now(),old=now-40*86400000;
 for(let n=1;n<=10;n++)insert.run(id,'sample',n,old+n);
 const prepare=env.VAULT.prepare;
 let replaced=false;
 env.VAULT.prepare=sql=>{
  if(!replaced && sql.startsWith('SELECT k,ver,size FROM history')){
   replaced=true;
   insert.run(id,'sample',-1,now); // retention removes the oldest version
  }
  return prepare(sql);
 };
 await assert.rejects(api('sync/backup',undefined,uc),/backup_changed/);
 assert.equal((await api('sync/backup',undefined,uc)).body.history.length,10);
});
