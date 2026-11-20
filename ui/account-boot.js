const accountHost=location.origin==='https://zwgcb.cn'||['127.0.0.1','localhost'].includes(location.hostname);
const activeKey='zwgcb-account-device',nativeStore=(()=>{try{return window.localStorage;}catch{return {getItem(){throw Error('存储不可用');},setItem(){throw Error('存储不可用');},removeItem(){throw Error('存储不可用');}};}})();
if(accountHost){const loading=document.querySelector('#view');if(loading){loading.textContent='正在打开记录本…';loading.setAttribute('aria-busy','true');}}
const accountUser=await (async()=>{
 if(!accountHost)return null;
 let cached=null;try{cached=JSON.parse(nativeStore.getItem(activeKey));}catch{}
 try{const r=await fetch('/api/auth/me',{cache:'no-store',signal:AbortSignal.timeout(4500)});
  if(r.status===401){nativeStore.removeItem(activeKey);return null;}
  if(!r.ok)return cached;
  const {user}=await r.json();if(!user?.id)return null;nativeStore.setItem(activeKey,JSON.stringify(user));return user;
 }catch{return cached;}
})();
if(accountHost){try{const pref=JSON.parse(nativeStore.getItem('zwgcb-ui'+(accountUser?':'+accountUser.id:''))||'{}');if(['dark','light'].includes(pref.theme))document.documentElement.dataset.theme=pref.theme;else delete document.documentElement.dataset.theme;}catch{}}
// A destructive logout takes the exclusive lock and checks durable data, including other tabs' writes.
const deviceLease=accountUser?'journal-device:'+accountUser.id:'';
let releaseLease=null,leaseHeld=null;
async function shareDevice(){
 if(!deviceLease||!navigator.locks)return;
 await new Promise((resolve,reject)=>{leaseHeld=navigator.locks.request(deviceLease,{mode:'shared'},()=>new Promise(done=>{releaseLease=done;resolve();}));leaseHeld.catch(reject);});
}
await shareDevice();
if(accountHost)document.querySelector('#view')?.removeAttribute('aria-busy');
// Remove the retired AI credential from this device, including the pre-account key.
try{nativeStore.removeItem('zwgcb-ai');if(accountUser)nativeStore.removeItem('zwgcb-ai:'+accountUser.id);}catch{}
const accountSuffix=accountUser?':'+accountUser.id:'';
const localStorage={getItem:k=>nativeStore.getItem(k+accountSuffix),setItem:(k,v)=>nativeStore.setItem(k+accountSuffix,v),removeItem:k=>nativeStore.removeItem(k+accountSuffix)};
if(accountHost){
 window.addEventListener('storage',e=>{if(e.key===activeKey&&e.oldValue!==e.newValue)location.reload();});
 window.addEventListener('pageshow',e=>{if(e.persisted)location.reload();});
}
