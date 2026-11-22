import { accountSession, withRenewal } from './accounts.mjs';
import {syncLimits} from './sync-limits.mjs';

const {docBytes:DOC_LIMIT,batchBytes:PAGE_BYTES,maxDocs,pageRows}=syncLimits;
const REQUEST_LIMIT = 4*Math.ceil(PAGE_BYTES/3)+512*maxDocs+32;

const response = (data, status = 200) => Response.json(data, {
  status: status,
  headers: {
    'cache-control': 'no-store'
  }
});

const error = (status, code) => response({
  error: {
    code: code
  }
}, status);

function encode(body) {
  if (body == null) {
    return null;
  }
  const bytes = Array.isArray(body) ? new Uint8Array(body.length) : new Uint8Array(body);
  if (Array.isArray(body)) bytes.set(body);
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let str = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    str += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return btoa(str);
}

function docRow(row) {
  return {
    ...row,
    body: encode(row.body),
    deleted: !!row.deleted
  };
}

async function page(db, uid, since, limit) {
  const meta = await db.prepare('SELECT seq,size FROM docs WHERE user_id=? AND seq>? ORDER BY seq LIMIT ?').bind(uid, since, limit).all();
  let end = since, bytes = 0;
  for (const row of meta.results) {
    if (end !== since && bytes + row.size > PAGE_BYTES) {
      break;
    }
    bytes += row.size;
    end = row.seq;
  }
  const docs = end === since ? [] : (await db.prepare('SELECT k,ver,seq,size,body,deleted,mtime,updated_at FROM docs WHERE user_id=? AND seq>? AND seq<=? ORDER BY seq').bind(uid, since, end).all()).results.map(docRow);
  return {
    docs: docs,
    next: end,
    more: meta.results.length === limit || end < (meta.results.at(-1)?.seq || 0)
  };
}

function decodeDoc(d, seen) {
  if (!d || typeof d.k !== 'string' || !/^[\w-]{43}$/.test(d.k) || seen.has(d.k) || typeof d.deleted !== 'boolean' || !(d.baseVer === null || Number.isSafeInteger(d.baseVer) && d.baseVer > 0)) {
    throw Error('invalid');
  }
  if (!Number.isSafeInteger(d.mtime) || d.mtime < 0) {
    throw Error('invalid');
  }
  if (d.archiveOnly !== undefined && (d.archiveOnly !== true || !d.baseVer || !/^[A-Za-z0-9_-]{43}$/.test(d.variant || ''))) {
    throw Error('invalid');
  }
  seen.add(d.k);
  if (d.deleted) {
    if (d.body != null) {
      throw Error('invalid');
    }
    return {
      ...d,
      bytes: null
    };
  }
  if (typeof d.body !== 'string' || !d.body.length) {
    throw Error('invalid');
  }
  if (d.body.length > 4 * Math.ceil(DOC_LIMIT / 3)) {
    throw Error('doc_too_large');
  }
  let bytes;
  try {
    if (typeof Uint8Array.fromBase64 === 'function') {
      bytes = Uint8Array.fromBase64(d.body);
    } else {
      const raw = atob(d.body);
      bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    }
  } catch {
    throw Error('invalid');
  }
  if (bytes.length > DOC_LIMIT) {
    throw Error('doc_too_large');
  }
  if (bytes.length < 29) {
    throw Error('invalid');
  }
  return {...d, bytes:bytes.buffer};
}

// Negative versions preserve independent offline edits. A keyed content tag deduplicates retries.
const archiveSQL = `INSERT INTO history(user_id,k,ver,body,size,saved_at,variant)
 SELECT d.user_id,d.k,MIN(0,COALESCE((SELECT MIN(h.ver) FROM history h WHERE h.user_id=d.user_id AND h.k=d.k),0))-1,?,?,?,?
 FROM docs d WHERE d.user_id=? AND d.k=? AND d.ver=?
 ON CONFLICT(user_id,k,variant) DO UPDATE SET saved_at=history.saved_at RETURNING k`;

const writeSQL = `INSERT INTO docs(user_id,k,ver,seq,size,body,deleted,mtime,updated_at)\n SELECT u.id,?,COALESCE(old.ver,0)+1,u.seq+1,?,?,?,?,?\n FROM users u LEFT JOIN docs old ON old.user_id=u.id AND old.k=?\n WHERE u.id=? AND u.disabled=0 AND old.ver IS ?\n ON CONFLICT(user_id,k) DO UPDATE SET ver=excluded.ver,seq=excluded.seq,size=excluded.size,\n mtime=excluded.mtime,body=excluded.body,deleted=excluded.deleted,updated_at=excluded.updated_at RETURNING k,ver,seq`;

async function push(req, db, uid, readBody) {
  let payload;
  try {
    payload = await readBody(req, REQUEST_LIMIT);
  } catch (e) {
    return error(e.message === 'too_large' ? 413 : 400, e.message === 'too_large' ? 'request_too_large' : 'invalid');
  }
  if (!Array.isArray(payload?.docs) || payload.docs.length > maxDocs) {
    return error(400, 'invalid');
  }
  const seen = new Set;
  let docs;
  try {
    docs = payload.docs.map(d => decodeDoc(d, seen));
  } catch (e) {
    return error(e.message === 'doc_too_large' ? 413 : 400, e.message);
  }
  const now = Date.now();
  if (docs.reduce((n,d)=>n+(d.bytes?.byteLength||0),0)>PAGE_BYTES) return error(413,'request_too_large');
  const ops = docs.map(d => {
    if (d.archiveOnly === true) {
      return db.prepare(archiveSQL).bind(d.bytes, d.bytes?.byteLength || 0, now, d.variant, uid, d.k, d.baseVer);
    }
    return db.prepare(writeSQL).bind(d.k, d.bytes?.byteLength || 0, d.bytes, Number(d.deleted), d.mtime, now, d.k, uid, d.baseVer);
  });
  let results;
  try {
    results = ops.length ? await db.batch(ops) : [];
  } catch (e) {
    if ((String(e) + ' ' + String(e.cause)).includes('sync_quota')) {
      return error(413, 'quota_exceeded');
    }
    throw e;
  }
  const written = [], missing = [];
  results.forEach((r, i) => {
    if (docs[i].archiveOnly) {
      if (!r.results?.length) {
        missing.push(docs[i].k);
      }
      return;
    }
    if (r.results?.length) {
      written.push(r.results[0]);
    } else {
      missing.push(docs[i].k);
    }
  });
  const totals = await stats(db, uid);
  if (!missing.length) {
    return response({
      written: written,
      stats: totals,
      conflicts: []
    });
  }
  const current = await db.batch(missing.map(k =>
    db.prepare('SELECT ver FROM docs WHERE user_id=? AND k=?').bind(uid, k)));
  const conflicts = missing.map((k, i) => ({k, ver:current[i].results[0]?.ver ?? null}));
  return response({written, stats:totals, conflicts});
}

const stats = (db, uid) => db.prepare('SELECT seq,sync_count AS count,sync_bytes AS bytes,quota_bytes AS quota FROM users WHERE id=?').bind(uid).first();

// Escape metadata normally. Only the generated ASCII base64 bypasses JSON escaping.
function pageResponse(field, rows, meta) {
  const pieces = [JSON.stringify(meta).slice(0,-1), ',"' + field + '":['];
  for (const [i, {body, ...fields}] of rows.entries()) {
    if (i) pieces.push(',');
    pieces.push(JSON.stringify(fields).slice(0,-1), ',"body":');
    if (body == null) pieces.push('null}');
    else pieces.push('"', body, '"}');
  }
  pieces.push(']}');
  const bytes = new Uint8Array(pieces.reduce((n,s) => n + s.length, 0));
  const encoder = new TextEncoder();
  let offset = 0;
  for (const s of pieces) offset += encoder.encodeInto(s, bytes.subarray(offset)).written;
  return new Response(new ReadableStream({start(c){c.enqueue(bytes);c.close();}}),
    {headers:{'content-type':'application/json','cache-control':'no-store'}});
}

async function backup(db, uid, cursor) {
  const revision = () => db.prepare('SELECT seq,history_rev FROM users WHERE id=?').bind(uid).first();
  const initial = await revision();
  let phase = 'docs', since = 0, key = '', ver = 0;
  if (cursor !== null) {
    let c;
    try { c = JSON.parse(atob(cursor)); } catch { return error(400,'invalid'); }
    if (!Array.isArray(c) || c.length !== 6 || !['docs','history'].includes(c[2]) ||
        !Number.isSafeInteger(c[3]) || c[3] < 0 || typeof c[4] !== 'string' ||
        (c[4] !== '' && !/^[\w-]{43}$/.test(c[4])) || !Number.isSafeInteger(c[5])) return error(400,'invalid');
    if (c[0] !== initial.seq || c[1] !== initial.history_rev) return error(409,'backup_changed');
    [, , phase, since, key, ver] = c;
  }
  let rows, next = null;
  const token = (p,s,k,v) => btoa(JSON.stringify([initial.seq,initial.history_rev,p,s,k,v]));
  if (phase === 'docs') {
    const part = await page(db, uid, since, pageRows);
    rows = part.docs;
    next = part.more ? token('docs',part.next,'',0) : token('history',0,'',0);
  } else {
    const select = ' FROM history WHERE user_id=? AND (k,ver)>(?,?)';
    const meta = (await db.prepare('SELECT k,ver,size'+select+' ORDER BY k,ver LIMIT ?').bind(uid,key,ver,pageRows).all()).results;
    let end, used=0;
    for(const row of meta) {
      if (used + row.size > PAGE_BYTES && end) break;
      used+=row.size; end=row;
    }
    rows=[];
    if (end) {
      const batch=await db.prepare('SELECT k,ver,body,size,saved_at'+select+' AND (k,ver)<=(?,?) ORDER BY k,ver').bind(uid,key,ver,end.k,end.ver).all();
      rows=batch.results.map(r=>({...r,body:encode(r.body)}));
      if (meta.length===pageRows || end!==meta.at(-1)) next=token('history',0,end.k,end.ver);
    }
  }
  const current = await revision();
  if (!current || current.seq!==initial.seq || current.history_rev!==initial.history_rev) return error(409,'backup_changed');
  return pageResponse(phase,rows,{seq:initial.seq,next});
}

export async function syncAPI(req, env, readBody) {
  try {
    const url = new URL(req.url), op = url.pathname.slice('/api/sync/'.length);
    if (![ 'pull', 'push', 'backup' ].includes(op)) {
      return error(404, 'not_found');
    }
    if (req.method !== (op === 'push' ? 'POST' : 'GET')) {
      return error(405, 'method');
    }
    if ((op === 'push' || req.headers.has('origin')) && req.headers.get('origin') !== env.ALLOWED_ORIGIN) {
      return error(403, 'origin');
    }
    const session = await accountSession(req, env);
    if (!session) {
      return error(401, 'no_session');
    }
    const uid = session.user.id, db = env.VAULT;
    if (req.headers.get('x-journal-account') && req.headers.get('x-journal-account') !== uid) {
      return error(409, 'account_changed');
    }
    if (!(await env.SYNC_RATE_LIMITER.limit({
      key: uid
    })).success) {
      const limited = error(429, 'rate_limited');
      limited.headers.set('retry-after', '60');
      return limited;
    }
    let result;
    if (op === 'push') {
      result = await push(req, db, uid, readBody);
    } else {
      if (op === 'backup') {
        result = await backup(db, uid, url.searchParams.get('cursor'));
      } else {
        const totals = await stats(db, uid);
        const since = Number(url.searchParams.get('since') || 0), limit = Number(url.searchParams.get('limit') || 200);
        if (!Number.isSafeInteger(since) || since < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) {
          return error(400, 'invalid');
        }
        const {docs,next,more}=await page(db, uid, since, Math.min(limit,pageRows));
        result = pageResponse('docs',docs,{next,more,stats:totals});
      }
    }
    return withRenewal(result, session);
  } catch {
    return error(503, 'sync_unavailable');
  }
}
