const H=3600_000, DAY=24*H, enc=new TextEncoder(), cookieName='__Host-zw';
const out=(data,status=200,headers={})=>Response.json(data,{status,headers:{'cache-control':'no-store',...headers}});
function fail(status,code,extra={}){throw Object.assign(new Error(code),{status,code,extra});}
const bin=b=>Uint8Array.from(b).buffer;
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
function bytes(s,n){if(typeof s!=='string'||s.length!==Math.ceil(n*4/3)||!/^[\w-]+$/.test(s))fail(400,'invalid');let a;try{a=Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));}catch{fail(400,'invalid');}if(a.length!==n||b64(a)!==s)fail(400,'invalid');return a.buffer;}
const random=()=>b64(crypto.getRandomValues(new Uint8Array(32)));
const sha=s=>crypto.subtle.digest('SHA-256',enc.encode(s));
const pepper=e=>crypto.subtle.importKey('raw',enc.encode(e.AUTH_PEPPER),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
const mac=(p,s)=>crypto.subtle.sign('HMAC',p,typeof s==='string'?enc.encode(s):s);
const same=(p,expected,s)=>crypto.subtle.verify('HMAC',p,bin(expected),typeof s==='string'?enc.encode(s):s);
const stmt=(e,sql,...v)=>e.VAULT.prepare(sql).bind(...v);
const publicUser=r=>({id:r.id,username:r.username,nickname:r.nickname,role:r.role});
function iterations(v=600000){if(!Number.isInteger(v)||v<100000||v>2000000)fail(400,'invalid');return v;}
function name(s){if(typeof s!=='string'||!/^[a-z0-9_]{3,20}$/.test(s))fail(400,'invalid');return s;}
const cookie=(value,age)=>cookieName+'='+value+'; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age='+age;
export async function accountSession(req,e){
 const tok=(req.headers.get('Cookie')||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1);
 if(!tok||!/^[\w-]{43}$/.test(tok)||!e.VAULT)return null;
 const hash=await sha(tok),now=Date.now();
 const user=await stmt(e,'SELECT u.id,u.username,u.nickname,u.role,s.last_seen FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0',hash,now).first();
 if(!user)return null;let renew;
 if(user.last_seen<=now-H){await e.VAULT.batch([stmt(e,'UPDATE sessions SET expires_at=?,last_seen=? WHERE token_hash=? AND last_seen<=?',now+180*DAY,now,hash,now-H),stmt(e,'UPDATE users SET last_seen=? WHERE id=? AND last_seen<=?',now,user.id,now-H)]);renew=cookie(tok,180*86400);}
 return {user:publicUser(user),hash,renew};
}
export function withRenewal(r,s){if(!s?.renew||r.headers.has('set-cookie'))return r;const response=new Response(r.body,r);response.headers.set('set-cookie',s.renew);return response;}
async function gates(e,p,req,u,now){
 const keys=[['u:'+u,5,H/4],['ip:'+b64(await mac(p,'ip:'+(req.headers.get('cf-connecting-ip')||'local'))),20,H]];
 const wait=async()=>{const row=await stmt(e,'SELECT MAX(locked_until) AS until FROM auth_fail WHERE key IN (?,?)',keys[0][0],keys[1][0]).first();if(row?.until>now)fail(429,'locked',{retryAfter:Math.ceil((row.until-now)/1000)});};
 await wait();return async()=>{await e.VAULT.batch(keys.map(([k,max,period])=>stmt(e,'INSERT INTO auth_fail(key,count,first_at,locked_until) VALUES(?,1,?,0) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN first_at<=? THEN 1 ELSE count+1 END,first_at=CASE WHEN first_at<=? THEN excluded.first_at ELSE first_at END,locked_until=CASE WHEN locked_until>? THEN locked_until WHEN first_at>? AND count+1>=? THEN ? ELSE 0 END',k,now,now-period,now-period,now,now-period,max,now+period)));await wait();fail(401,'invalid_credentials');};
}
export async function accounts(req,e,readBody){
 try{
 const url=new URL(req.url),path=url.pathname.replace(/^\/api\//,''),get=['auth/salt','auth/me','admin/overview'].includes(path);
 if(req.method!==(get?'GET':'POST'))fail(405,'method');
 if((!get||req.headers.has('Origin'))&&req.headers.get('Origin')!==e.ALLOWED_ORIGIN)fail(403,'origin');
 if(!e.VAULT||!e.AUTH_PEPPER||enc.encode(e.AUTH_PEPPER).length<32)fail(503,'accounts_unavailable');
 let b={};if(!get){try{b=await readBody(req,8192);}catch{fail(400,'invalid');}if(!b||typeof b!=='object'||Array.isArray(b))fail(400,'invalid');}
 const p=await pepper(e),now=Date.now();
 if(path==='auth/salt'){const u=name(url.searchParams.get('u')),row=await stmt(e,'SELECT kdf_salt,kdf_iter FROM users WHERE username=?',u).first();return out({kdf_iter:row?.kdf_iter??600000,kdf_salt:b64(row?.kdf_salt||new Uint8Array(await mac(p,'salt:'+u)).slice(0,16))});}
 if(path==='auth/register'){
 const u=name(b.username),nick=b.nickname??'';if(typeof nick!=='string'||[...nick].length>12||typeof b.invite!=='string'||!b.invite.length||b.invite.length>512)fail(400,'invalid');
 const bad=await gates(e,p,req,u,now);
 const id=crypto.randomUUID(),hint=await sha(b.invite);bytes(b.authKey,32);bytes(b.recoveryAuth,32);
 const args=[id,u,nick,'user',bytes(b.kdf_salt,16),await mac(p,bytes(b.authKey,32)),bytes(b.wrapped_keys,92),bytes(b.recovery_wrapped,92),await mac(p,bytes(b.recoveryAuth,32)),now,now,hint,iterations(b.kdf_iter)];
 const r=await stmt(e,'INSERT OR IGNORE INTO users(id,username,nickname,role,kdf_salt,auth_hash,wrapped_keys,recovery_wrapped,recovery_hash,created_at,last_seen,invite_hash,kdf_iter) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM invites WHERE code_hash=? AND used_by IS NULL AND revoked=0 AND expires_at>?)',...args,hint,now).run();
 if(!r.meta.changes)await bad();return out({ok:true},201);
 }
 if(path==='auth/login'||path==='auth/recover/start'){
 const u=name(b.username),login=path==='auth/login',credential=login?b.authKey:b.recoveryAuth;bytes(credential,32);
 const bad=await gates(e,p,req,u,now),r=await stmt(e,'SELECT * FROM users WHERE username=?',u).first(),field=login?'auth_hash':'recovery_hash';
 const valid=await same(p,r?.[field]||new Uint8Array(32),bytes(credential,32));if(!valid||!r||r.disabled)await bad();
 const tok=random(),hash=await sha(tok);
 if(!login){const x=await stmt(e,'INSERT INTO resets SELECT ?,id,? FROM users WHERE id=? AND disabled=0 AND recovery_hash=?',hash,now+600000,r.id,bin(r[field])).run();if(!x.meta.changes)fail(401,'invalid_credentials');return out({token:tok,recovery_wrapped:b64(r.recovery_wrapped)});}
 const [x]=await e.VAULT.batch([stmt(e,'INSERT INTO sessions SELECT ?,id,?,?,?,? FROM users WHERE id=? AND auth_hash=? AND disabled=0',hash,now,now,now+180*DAY,(req.headers.get('user-agent')||'').slice(0,160),r.id,bin(r.auth_hash)),stmt(e,'UPDATE users SET last_seen=? WHERE id=?',now,r.id),stmt(e,'DELETE FROM auth_fail WHERE key=?','u:'+u)]);
 if(!x.meta.changes)fail(401,'invalid_credentials');return out({user:publicUser(r),wrapped_keys:b64(r.wrapped_keys) },200,{'Set-Cookie':cookie(tok,180*86400)});
 }
 if(path==='auth/recover/finish'){
 bytes(b.token,32);bytes(b.authKey,32);const h=await sha(b.token);
 const sub='(SELECT user_id FROM resets WHERE token_hash=? AND expires_at>?)';
 const [x]=await e.VAULT.batch([stmt(e,'UPDATE users SET kdf_salt=?,auth_hash=?,wrapped_keys=?,kdf_iter=? WHERE disabled=0 AND id='+sub,bytes(b.kdf_salt,16),await mac(p,bytes(b.authKey,32)),bytes(b.wrapped_keys,92),iterations(b.kdf_iter),h,now),stmt(e,'DELETE FROM sessions WHERE user_id='+sub,h,now),stmt(e,'DELETE FROM auth_fail WHERE key IN (SELECT \'u:\'||username FROM users WHERE id='+sub+')',h,now),stmt(e,'DELETE FROM resets WHERE user_id='+sub,h,now)]);
 if(!x.meta.changes)fail(401,'invalid_reset');return out({ok:true});
 }
 const s=await accountSession(req,e);if(!s)fail(401,'no_session');const uid=s.user.id;
 const reply=v=>withRenewal(out(v),s);
 if(path==='auth/me')return reply({user:s.user});
 if(path==='auth/logout'){await stmt(e,'DELETE FROM sessions WHERE token_hash=?',s.hash).run();return out({ok:true},200,{'set-cookie':cookie('',0)});}
 if(path==='auth/keys'){
  bytes(b.currentAuth,32);const bad=await gates(e,p,req,s.user.username,now);
  const row=await stmt(e,'SELECT wrapped_keys FROM users WHERE id=? AND auth_hash=? AND disabled=0',uid,await mac(p,bytes(b.currentAuth,32))).first();
  if(!row)await bad();return reply({wrapped_keys:b64(row.wrapped_keys)});
 }
 if(path==='auth/password'){
 bytes(b.authKey,32);bytes(b.currentAuth,32);
 const old=await mac(p,bytes(b.currentAuth,32)),next=await mac(p,bytes(b.authKey,32));
 const bad=await gates(e,p,req,s.user.username,now);
 const current="SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=? AND u.auth_hash=? AND u.disabled=0 AND s.token_hash=? AND s.expires_at>?";
 const check=[uid,old,s.hash,now];
 const [,,x]=await e.VAULT.batch([stmt(e,'DELETE FROM sessions WHERE user_id=? AND token_hash<>? AND EXISTS('+current+')',uid,s.hash,...check),stmt(e,'DELETE FROM resets WHERE user_id=? AND EXISTS('+current+')',uid,...check),stmt(e,'UPDATE users SET auth_hash=?,kdf_salt=?,wrapped_keys=?,kdf_iter=? WHERE id=? AND EXISTS('+current+')',next,bytes(b.kdf_salt,16),bytes(b.wrapped_keys,92),iterations(b.kdf_iter),uid,...check)]);
 if(!x.meta.changes)await bad();return reply({ok:true});
 }
 if(!path.startsWith('admin/'))fail(404,'not_found');if(s.user.role!=='admin')fail(403,'forbidden');
 if(path==='admin/overview'){
  const haveDocs=await stmt(e,"SELECT 1 FROM sqlite_schema WHERE type='table' AND name='docs'").first();
  const totals=haveDocs?'SELECT u.id,u.username,u.nickname,u.role,u.disabled,u.quota_bytes,u.created_at,u.last_seen,COUNT(d.k) AS doc_count,COALESCE(SUM(d.size),0) AS used_bytes FROM users u LEFT JOIN docs d ON d.user_id=u.id AND d.deleted=0 GROUP BY u.id ORDER BY u.created_at':'SELECT id,username,nickname,role,disabled,quota_bytes,created_at,last_seen,0 AS doc_count,0 AS used_bytes FROM users ORDER BY created_at';
 const [users,invites]=await e.VAULT.batch([stmt(e,totals),stmt(e,'SELECT id,expires_at,used_by,revoked FROM invites ORDER BY created_at DESC')]);
 return reply({users:users.results,invites:invites.results,db_bytes:users.meta.size_after});
 }
 if(path==='admin/invite'){const code=random();await stmt(e,'INSERT INTO invites(code_hash,id,created_at,expires_at) VALUES(?,?,?,?)',await sha(code),crypto.randomUUID(),now,now+7*DAY).run();return reply({code});}
 if(path==='admin/revoke'){await stmt(e,'UPDATE invites SET revoked=1 WHERE id=? AND used_by IS NULL',String(b.id)).run();return reply({ok:true});}
 if(path==='admin/user'){
 const target=await stmt(e,'SELECT username,role FROM users WHERE id=?',String(b.id)).first();if(!target)fail(404,'not_found');
 if(b.action==='quota'&&Number.isSafeInteger(b.bytes)&&b.bytes>=0)await stmt(e,'UPDATE users SET quota_bytes=? WHERE id=?',b.bytes,b.id).run();
 else if(target.role==='admin')fail(403,'protected_admin');
 else if(b.action==='delete'&&b.confirm===target.username){
  const tables=(await stmt(e,"SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('history','docs')").all()).results.map(r=>r.name);
  await e.VAULT.batch([...['history','docs'].filter(t=>tables.includes(t)).map(t=>stmt(e,'DELETE FROM '+t+' WHERE user_id=?',b.id)),stmt(e,"DELETE FROM users WHERE id=? AND role<>'admin'",b.id)]);
 }
 else if(b.action==='disable'||b.action==='enable'){const ops=[stmt(e,'UPDATE users SET disabled=? WHERE id=?',Number(b.action==='disable'),b.id)];if(b.action==='disable')ops.push(stmt(e,'DELETE FROM sessions WHERE user_id=?',b.id),stmt(e,'DELETE FROM resets WHERE user_id=?',b.id));await e.VAULT.batch(ops);}
 else fail(400,'invalid');return reply({ok:true});
 }
 fail(404,'not_found');
 }catch(e){return out({error:{code:e.code&&e.status?e.code:'accounts_unavailable',...e.extra}},e.status||503,e.extra?.retryAfter?{'retry-after':String(e.extra.retryAfter)}:{});}
}
