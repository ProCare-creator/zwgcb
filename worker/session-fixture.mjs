import {createHash} from 'node:crypto';

// Only the D1 lookup is simulated in the AI transport tests.
const token='a'.repeat(43);
const digest=createHash('sha256').update(token).digest('hex');
export const adminCookie='__Host-zw='+token;
export const sessionVault={
 prepare(){return {bind(hash){return {first:async()=>Buffer.from(hash).toString('hex')===digest
  ? {id:'fixture-admin',role:'admin',last_seen:Date.now()} : null};}};}
};
