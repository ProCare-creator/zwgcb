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
 const defaultIter=600000;
 async function password(pass,salt,iterations){
  if(!Number.isInteger(iterations)||iterations<100000||iterations>2000000)throw Error('账号的密码派生次数无效。');
  const k=await sub.importKey('raw',utf.encode(pass),'PBKDF2',false,['deriveBits']);const start=performance.now();
  const master=new Uint8Array(await sub.deriveBits({name:'PBKDF2',salt:unpack(salt),hash:'SHA-256',iterations},k,256));const ms=Math.round(performance.now()-start);
  try{return {authKey:await derive(master,'login'),kek:await derive(master,'password-wrap',true),ms};}finally{master.fill(0);}
 }
 async function wrap(kek,raw){const iv=rand(12);const body=new Uint8Array(await sub.encrypt({name:'AES-GCM',iv},kek,raw));return pack(new Uint8Array([...iv,...body]));}
 async function unwrap(kek,envelope){const b=unpack(envelope);return new Uint8Array(await sub.decrypt({name:'AES-GCM',iv:b.slice(0,12)},kek,b.slice(12)));}
 const alphabet='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
 async function codeFor(raw){
  let n=0n;for(const byte of raw)n=(n<<8n)|BigInt(byte);
  let digits='';for(let i=0;i<26;i++){digits=alphabet[Number(n&31n)]+digits;n>>=5n;}
  // Two Base32 checksum symbols keep the complete code in seven equal groups.
  const hash=new Uint8Array(await sub.digest('SHA-256',raw)),check=(hash[0]<<2)|(hash[1]>>6);
  return (digits+alphabet[check>>5]+alphabet[check&31]).match(/.{4}/g).join('-');
 }
 async function recovery(code){
  const text=code.replace(/[\s-]/g,'');if(!/^[a-zA-Z0-9]{28}$/.test(text))throw Error('恢复码应为七组，每组四个字符。');
  const canon=text.toUpperCase().replaceAll('O','0').replace(/[IL]/g,'1');
  if([...canon].some(c=>!alphabet.includes(c))||alphabet.indexOf(canon[0])>7)throw Error('恢复码格式不正确。');
  let n=0n;for(const c of canon.slice(0,26))n=(n<<5n)|BigInt(alphabet.indexOf(c));
  const raw=new Uint8Array(16);for(let i=15;i>=0;i--){raw[i]=Number(n&255n);n>>=8n;}
  if((await codeFor(raw)).replaceAll('-','')!==canon)throw Error('恢复码抄写有误。');
  try{return {auth:await derive(raw,'recovery-auth'),kek:await derive(raw,'recovery-wrap',true)};}finally{raw.fill(0);}
 }
 async function keys(raw){return {dek:await sub.importKey('raw',raw.slice(0,32),'AES-GCM',false,['encrypt','decrypt']),mack:await sub.importKey('raw',raw.slice(32),{name:'HMAC',hash:'SHA-256'},false,['sign','verify'])};}
 return {defaultIter,password,wrap,unwrap,recovery,keys,code:()=>codeFor(rand(16)),salt:()=>pack(rand(16)),data:()=>rand(64)};
})();
