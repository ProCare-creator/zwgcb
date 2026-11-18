// Only small, fixed-size credential envelopes cross the account API.
const accountCrypto=(()=>{
 const utf=new TextEncoder(),sub=crypto.subtle,rand=n=>crypto.getRandomValues(new Uint8Array(n));
 const pack=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
 const unpack=s=>Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
 async function derive(seed,label,use){
  const key=await sub.importKey('raw',seed,'HKDF',false,['deriveBits','deriveKey']);
  const params={name:'HKDF',hash:'SHA-256',salt:utf.encode('zwgcb/accounts/v1'),info:utf.encode(label)};
  return use?sub.deriveKey(params,key,{name:'AES-GCM',length:256},false,['encrypt','decrypt']):pack(await sub.deriveBits(params,key,256));
 }
 async function password(pass,salt){
  const k=await sub.importKey('raw',utf.encode(pass),'PBKDF2',false,['deriveBits']);const start=performance.now();
  const master=new Uint8Array(await sub.deriveBits({name:'PBKDF2',salt:unpack(salt),hash:'SHA-256',iterations:600000},k,256));const ms=Math.round(performance.now()-start);
  try{return {authKey:await derive(master,'login'),kek:await derive(master,'password-wrap',true),ms};}finally{master.fill(0);}
 }
 async function wrap(kek,raw){const iv=rand(12);const body=new Uint8Array(await sub.encrypt({name:'AES-GCM',iv},kek,raw));return pack(new Uint8Array([...iv,...body]));}
 async function unwrap(kek,envelope){const b=unpack(envelope);return new Uint8Array(await sub.decrypt({name:'AES-GCM',iv:b.slice(0,12)},kek,b.slice(12)));}
 async function codeFor(raw){const check=pack(await sub.digest('SHA-256',raw)).slice(0,2);return (pack(raw)+check).replaceAll('-','.').match(/.{4}/g).join('-');}
 async function recovery(code){
  if(!/^(?:[A-Za-z0-9._]{4}-){5}[A-Za-z0-9._]{4}$/.test(code))throw Error('恢复码格式不正确。');
  const raw=unpack(code.replaceAll('-','').replaceAll('.','-').slice(0,22));if(await codeFor(raw)!==code)throw Error('恢复码抄写有误。');
  try{return {auth:await derive(raw,'recovery-auth'),kek:await derive(raw,'recovery-wrap',true)};}finally{raw.fill(0);}
 }
 async function keys(raw){return {dek:await sub.importKey('raw',raw.slice(0,32),'AES-GCM',false,['encrypt','decrypt']),mack:await sub.importKey('raw',raw.slice(32),{name:'HMAC',hash:'SHA-256'},false,['sign','verify'])};}
 return {password,wrap,unwrap,recovery,keys,code:()=>codeFor(rand(16)),salt:()=>pack(rand(16)),data:()=>rand(64)};
})();
