import { accountSession, withRenewal } from './accounts.mjs';

const DOC_LIMIT = 19e5, REQUEST_LIMIT = 4e6, PAGE_BYTES = 28e5;

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
  const bytes = new Uint8Array(body);
  let str = '';
  for (let i = 0; i < bytes.length; i += 16384) {
    str += String.fromCharCode(...bytes.subarray(i, i + 16384));
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
    if (bytes + row.size > PAGE_BYTES) {
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
  let raw;
  try {
    raw = atob(d.body);
  } catch {
    throw Error('invalid');
  }
  if (raw.length > DOC_LIMIT) {
    throw Error('doc_too_large');
  }
  if (raw.length < 29) {
    throw Error('invalid');
  }
  return {
    ...d,
    bytes: Uint8Array.from(raw, ch => ch.charCodeAt(0)).buffer
  };
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
  if (!Array.isArray(payload?.docs) || payload.docs.length > 100) {
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
  const sizes = await db.batch(missing.map(k => db.prepare('SELECT size FROM docs WHERE user_id=? AND k=?').bind(uid, k)));
  let offset = 0;
  const enc = new TextEncoder;
  const stream = new ReadableStream({
    async pull(controller) {
      if (!offset) {
        controller.enqueue(enc.encode('{"written":' + JSON.stringify(written) + ',"stats":' + JSON.stringify(totals) + ',"conflicts":['));
      }
      const start = offset;
      let size = 0;
      do {
        size += sizes[offset++].results[0]?.size || 0;
      } while (offset < missing.length && size + (sizes[offset].results[0]?.size || 0) <= 58e5);
      const keys = missing.slice(start, offset);
      const current = await db.batch(keys.map(k => db.prepare('SELECT k,ver,seq,size,body,deleted,mtime,updated_at FROM docs WHERE user_id=? AND k=?').bind(uid, k)));
      for (let i = 0; i < keys.length; i++) {
        const row = current[i].results[0];
        controller.enqueue(enc.encode((start + i ? ',' : '') + JSON.stringify(row ? docRow(row) : {
          k: keys[i],
          ver: null
        })));
      }
      if (offset === missing.length) {
        controller.enqueue(enc.encode(']}'));
        controller.close();
      }
    }
  });
  return new Response(stream, {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    }
  });
}

const stats = (db, uid) => db.prepare('SELECT seq,sync_count AS count,sync_bytes AS bytes,quota_bytes AS quota FROM users WHERE id=?').bind(uid).first();

async function backup(db, uid) {
  const revision = () => db.prepare('SELECT seq,history_rev FROM users WHERE id=?').bind(uid).first();
  const initial = await revision(), enc = new TextEncoder;
  let since = 0, phase = 'docs', key = '', version = 0, first = true, wrote = false;
  const stream = new ReadableStream({
    async pull(controller) {
      const send = s => controller.enqueue(enc.encode(s));
      function append(row) {
        send((wrote ? ',' : '') + JSON.stringify(row));
        wrote = true;
      }
      if (first) {
        first = false;
        send('{"format":"zwgcb-encrypted-v1","docs":[');
      }
      if (phase === 'docs') {
        const part = await page(db, uid, since, 2e3);
        part.docs.forEach(append);
        since = part.next;
        if (!part.more) {
          send('],"history":[');
          phase = 'history';
          wrote = false;
        }
        return;
      }
      const select = ' FROM history WHERE user_id=? AND (k,ver)>(?,?)';
      const meta = (await db.prepare('SELECT k,ver,size' + select + ' ORDER BY k,ver LIMIT 2000').bind(uid, key, version).all()).results;
      let end, bytes = 0;
      for (const r of meta) {
        if (bytes + r.size > PAGE_BYTES) {
          break;
        }
        end = r;
        bytes += r.size;
      }
      if (end) {
        const batch = await db.prepare('SELECT k,ver,body,size,saved_at' + select + ' AND (k,ver)<=(?,?) ORDER BY k,ver').bind(uid, key, version, end.k, end.ver).all();
        batch.results.forEach(r => append({
          ...r,
          body: encode(r.body)
        }));
        key = end.k;
        version = end.ver;
        if (meta.length === 2e3 || meta.at(-1) !== end) {
          return;
        }
      }
      const current = await revision();
      if (!current || current.seq !== initial.seq || current.history_rev !== initial.history_rev) {
        throw Error('backup_changed');
      }
      send('],"seq":' + initial.seq + '}');
      controller.close();
    }
  });
  return new Response(stream, {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'content-disposition': 'attachment; filename="journal-encrypted.json"'
    }
  });
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
        result = await backup(db, uid);
      } else {
        const totals = await stats(db, uid);
        const since = Number(url.searchParams.get('since') || 0), limit = Number(url.searchParams.get('limit') || 200);
        if (!Number.isSafeInteger(since) || since < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) {
          return error(400, 'invalid');
        }
        result = response({
          ...await page(db, uid, since, limit),
          stats: totals
        });
      }
    }
    return withRenewal(result, session);
  } catch {
    return error(503, 'sync_unavailable');
  }
}
