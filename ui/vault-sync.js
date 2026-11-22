// Account sync metadata lives beside the non-exportable device keys in IndexedDB control.
/* CLOUD_SYNC_LIMITS */
const vault = {
  oversized: new Map(),
  enabled: false,
  keys: null,
  job: null,
  timer: null,
  message: '',
  last: 0,
  stats: null,
  initialized: false
};

const vUTF = new TextEncoder;

function idbValue(req) {
  return new Promise((ok, no) => {
    req.onsuccess = () => ok(req.result);
    req.onerror = () => no(req.error);
  });
}

function idbDone(tx) {
  return new Promise((ok, no) => {
    tx.oncomplete = ok;
    tx.onabort = () => no(tx.error || Error('本机写入失败。'));
  });
}

const vaultControl = (key, db = disk.db) => idbValue(db.transaction('control').objectStore('control').get(key));

async function vaultSet(key, value) {
  const tx = disk.db.transaction('control', 'readwrite'), done = idbDone(tx), store = tx.objectStore('control');
  if (value === undefined) {
    store.delete(key);
  } else {
    store.put(value, key);
  }
  await done;
}

const vaultPath = (col, id) => col + '/' + id;

const v64 = bytes => b64enc(new Uint8Array(bytes));

async function vaultKey(col, id) {
  return v64(await crypto.subtle.sign('HMAC', vault.keys.mack, vUTF.encode(vaultPath(col, id)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

const vaultDigest = async value => v64(await crypto.subtle.digest('SHA-256', vUTF.encode(JSON.stringify(value))));

async function vaultEncrypt(item) {
  const {col: col, id: id, stamp: stamp, value: value, k: k} = item;
  let data = vUTF.encode(JSON.stringify({
    col: col,
    id: id,
    stamp: stamp,
    value: value
  })), flag = 0;
  if (data.length >= 256 && typeof CompressionStream === 'function') {
    const zipped = new Uint8Array(await new Response(new Blob([ data ]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    if (zipped.length < data.length) {
      flag = 1;
      data = zipped;
    }
  }
  const iv = crypto.getRandomValues(new Uint8Array(12)), aad = vUTF.encode(accountUser.id + '/' + k + '/' + flag);
  const cipher = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv: iv,
    additionalData: aad
  }, vault.keys.dek, data);
  const packed = new Uint8Array(13 + cipher.byteLength);
  packed[0] = flag;
  packed.set(iv, 1);
  packed.set(new Uint8Array(cipher), 13);
  return v64(packed);
}

async function vaultDecrypt(row) {
  let raw;
  if (typeof Uint8Array.fromBase64 === 'function') {
    raw = Uint8Array.fromBase64(row.body);
  } else {
    const binary = atob(row.body);
    raw = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) raw[i] = binary.charCodeAt(i);
  }
  const flag = raw[0];
  if (flag > 1) {
    throw Error('云端密文格式无效。');
  }
  const plain = await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: raw.slice(1, 13),
    additionalData: vUTF.encode(accountUser.id + '/' + row.k + '/' + flag)
  }, vault.keys.dek, raw.slice(13));
  const stream = new Blob([ plain ]).stream();
  const item = JSON.parse(await new Response(flag ? stream.pipeThrough(new DecompressionStream('gzip')) : stream).text());
  if (!COLS.includes(item.col) || typeof item.id !== 'string' || [ '__proto__', 'constructor', 'prototype' ].includes(item.id) || !item.value || typeof item.value !== 'object' || !Number.isSafeInteger(item.stamp) || await vaultKey(item.col, item.id) !== row.k || item.stamp !== row.mtime) {
    throw Error('云端记录校验失败。');
  }
  return item;
}

async function vaultRequest(path, docs) {
  const r = await fetch('/api/sync/' + path, {
    method: docs ? 'POST' : 'GET',
    cache: 'no-store',
    headers: {
      'x-journal-account': accountUser.id,
      ...docs ? {
        'content-type': 'application/json'
      } : {}
    },
    ...docs ? {
      body: JSON.stringify({
        docs: docs
      })
    } : {},
    signal: AbortSignal.timeout(9e4)
  }).catch(err => {
    if (err.name === 'TimeoutError') throw Error('同步请求超时，本机修改已保留，可重新同步。');
    if (err instanceof TypeError) throw Error('暂时无法连接云端，本机修改已保留，可重新同步。');
    throw err;
  });
  if (!r.ok) {
    const code = (await r.json().catch(() => ({}))).error?.code;
    const err = Error({
      quota_exceeded: '云端空间已满，本机修改已保留。',
      backup_changed: '下载期间记录有变化，请重新下载加密备份。',
      no_session: '请重新登录后继续同步。',
      account_changed: '账号已切换，请刷新。',
      rate_limited: '同步较频繁，稍后重试。',
      doc_too_large: '单条加密记录超过 '+storageSize(syncLimits.docBytes)+'。'
    }[code] || '云端暂时不可用，本机修改已保留。');
    if (r.status === 429) {
      err.retryAfter = Number(r.headers.get('retry-after')) || 60;
    }
    throw err;
  }
  return r.json();
}

async function vaultBackup() {
  const docs=[], history=[];
  let cursor=null, seq;
  do {
    let part;
    try {
      part=await vaultRequest(cursor?'backup?cursor='+encodeURIComponent(cursor):'backup');
    } catch(e) {
      if (!e.retryAfter) throw e;
      await new Promise(done=>setTimeout(done,e.retryAfter*1000));
      continue;
    }
    seq=part.seq;
    for(const [name,target] of [['docs',docs],['history',history]]) {
      for(const row of part[name]||[]) target.push((target.length?',':'')+JSON.stringify(row));
    }
    cursor=part.next;
    if (!cursor) break;
  } while (true);
  return new Blob(['{"format":"zwgcb-encrypted-v1","docs":[',...docs,'],"history":[',...history,'],"seq":'+seq+'}'],{type:'application/json'});
}

async function vaultSnapshot(db = disk.db) {
  const store = db.transaction('docs').objectStore('docs');
  const [keys, values] = await Promise.all([ idbValue(store.getAllKeys()), idbValue(store.getAll()) ]);
  return keys.map(([col, id], i) => ({
    col: col,
    id: id,
    value: values[i]
  }));
}

async function vaultLocal(index) {
  const local = new Map, paths = new Map, del = readDel(), records = await vaultSnapshot(), catStamp = records.find(x => x.col === 'meta' && x.id === 'tlcatsUpdated')?.value._t;
  for (const [k, r] of Object.entries(index)) {
    if (r.col) {
      paths.set(vaultPath(r.col, r.id), k);
    }
  }
  for (const r of records) {
    const path = vaultPath(r.col, r.id), k = paths.get(path) || (vault.keys ? await vaultKey(r.col, r.id) : 'pending:' + path);
    const sig = await vaultDigest(r.value), stamp = r.value._t || (r.col === 'meta' && r.id === 'tlcats' ? catStamp : 0) || index[k]?.stamp || 0;
    local.set(k, {
      ...r,
      k: k,
      sig: sig,
      stamp: stamp,
      deleted: false
    });
  }
  const markers = disk.db.transaction('control').objectStore('control'), range = IDBKeyRange.bound([ 'vaultDeleted' ], [ 'vaultDeleted', [] ]);
  const [markKeys, markTimes] = await Promise.all([ idbValue(markers.getAllKeys(range)), idbValue(markers.getAll(range)) ]);
  markKeys.forEach(([, c, id], i) => {
    const path = vaultPath(c, id);
    del[path] = Math.max(del[path] || 0, markTimes[i]);
  });
  for (const [path, stamp] of Object.entries(del)) {
    const at = path.indexOf('/'), col = path.slice(0, at), id = path.slice(at + 1);
    if (!COLS.includes(col)) {
      continue;
    }
    const k = paths.get(path) || (vault.keys ? await vaultKey(col, id) : 'pending:' + path);
    if (!local.has(k)) {
      local.set(k, {
        col: col,
        id: id,
        k: k,
        stamp: stamp,
        deleted: true
      });
    }
  }
  return local;
}

const vaultClean = (r, base) => !!base && r.deleted === base.deleted && (r.deleted ? r.stamp <= base.stamp : r.sig === base.sig);

const vaultWire = async (r, baseVer) => ({
  k: r.k,
  baseVer: baseVer,
  mtime: r.stamp,
  deleted: r.deleted,
  body: r.deleted ? null : await vaultEncrypt(r)
});

function vaultBytes(doc) {
  const b=doc.body;
  return b ? b.length/4*3 - (b.endsWith('==')?2:b.endsWith('=')?1:0) : 0;
}

function vaultTooLarge(doc, record) {
  if (vaultBytes(doc)<=syncLimits.docBytes) return false;
  const value=record?.value||{};
  const label=value.title || value.date || value.created?.slice?.(0,10) || record?.id || '';
  vault.oversized.set(doc.k,{col:record?.col||'',label:String(label)});
  return true;
}

async function vaultBatches(items, send, local) {
  let batch = [], size = 0;
  for (const item of items) {
    if (vaultTooLarge(item,local.get(item.k))) continue;
    const n = vaultBytes(item);
    if (batch.length === syncLimits.maxDocs || size + n > syncLimits.batchBytes) {
      await send(batch);
      batch = [];
      size = 0;
    }
    batch.push(item);
    size += n;
  }
  if (batch.length) {
    await send(batch);
  }
}

// Compare the durable preimage in the same transaction as the incoming record and cursor.
// A tab that edits during decryption wins a retry instead of losing its edit.
async function vaultApply(state, changes, archives = []) {
  const visible = changes.map(x => S[x.col][x.id]);
  const tx = disk.db.transaction([ 'docs', 'control' ], 'readwrite'), done = idbDone(tx), docs = tx.objectStore('docs');
  let stale = false;
  for (const x of changes) {
    const key = [ x.col, x.id ], q = docs.get(key);
    q.onsuccess = () => {
      if (JSON.stringify(q.result) !== JSON.stringify(x.before)) {
        stale = true;
        tx.abort();
        return;
      }
      const marks = tx.objectStore('control'), marker = [ 'vaultDeleted', x.col, x.id ];
      if (x.value === undefined) {
        docs.delete(key);
        marks.put(x.stamp, marker);
      } else {
        docs.put(x.value, key);
        marks.delete(marker);
      }
    };
  }
  const control = tx.objectStore('control');
  for (const doc of archives) control.put(doc, ['vaultArchive', doc.k, doc.variant]);
  control.put(state, 'vaultState');
  try {
    await done;
  } catch (e) {
    if (stale) {
      throw Error('同步期间有新的本机修改，将重新同步。');
    }
    throw e;
  }
  const del = readDel();
  for (const [i, x] of changes.entries()) {
    if (S[x.col][x.id] === visible[i]) {
      if (x.value === undefined) {
        delete S[x.col][x.id];
      } else {
        S[x.col][x.id] = x.value;
      }
    }
    const path = vaultPath(x.col, x.id);
    if (x.value === undefined) {
      del[path] = x.stamp;
    } else if (!(del[path] > x.stamp)) {
      delete del[path];
    }
  }
  if (changes.length) {
    writeDel(del);
    queueRefresh();
  }
}

async function vaultMerge(page, state, local) {
  const changes = [], archives = [];
  for (const row of page.docs) {
    const old = state.index[row.k], mine = local.get(row.k);
    const remote = row.deleted ? null : await vaultDecrypt(row);
    const col = remote?.col || mine?.col || old?.col, id = remote?.id || mine?.id || old?.id;
    const sig = remote ? await vaultDigest(remote.value) : undefined;
    const base = {
      col: col,
      id: id,
      ver: row.ver,
      stamp: row.mtime,
      deleted: row.deleted,
      sig: sig
    };
    const localWins = mine && (mine.stamp > base.stamp || (mine.deleted && mine.stamp === base.stamp));
    if (localWins && !vaultClean(mine, base)) {
      if (col === 'meta' && id === 'counters' && remote && mine.value && remote.value.hypSeq > (mine.value.hypSeq || 0)) {
        const value = {
          ...mine.value,
          hypSeq: remote.value.hypSeq
        };
        changes.push({
          col: col,
          id: id,
          value: value,
          before: mine.value,
          stamp: mine.stamp
        });
        local.set(row.k, {
          ...mine,
          value: value,
          sig: await vaultDigest(value)
        });
      }
    } else if (col && (!mine || !vaultClean(mine, base))) {
      if (mine && !mine.deleted && !vaultClean(mine, old) && mine.sig !== sig) {
        archives.push({
          ...await vaultWire(mine, row.ver),
          variant: await vaultKey('conflict', row.k + '/' + mine.sig),
          archiveOnly: true
        });
      }
      let value = remote?.value;
      if (col === 'meta' && id === 'counters' && value && mine?.value?.hypSeq > (value.hypSeq || 0)) {
        value = {
          ...value,
          hypSeq: mine.value.hypSeq
        };
      }
      changes.push({
        col: col,
        id: id,
        before: mine?.value,
        value: value,
        stamp: base.stamp
      });
      local.set(row.k, {
        col: col,
        id: id,
        k: row.k,
        value: value,
        stamp: base.stamp,
        deleted: row.deleted,
        sig: value === remote?.value ? sig : await vaultDigest(value)
      });
    }
    state.index[row.k] = base;
  }
  state.seq = page.next;
  await vaultApply(state, changes, archives);
}

const vaultArchiveRange = () => IDBKeyRange.bound(['vaultArchive'], ['vaultArchive', []]);

// Archive before-images only after the last pull page. A crash before acknowledgment
// leaves the encrypted copy here; the Worker deduplicates retries by its keyed variant.
async function vaultUploadArchives(state) {
  let after;
  while (true) {
    const store = disk.db.transaction('control').objectStore('control');
    const range=after?IDBKeyRange.bound(after,['vaultArchive',[]],true):vaultArchiveRange();
    const keys = await idbValue(store.getAllKeys(range, syncLimits.maxDocs));
    if (!keys.length) return true;
    const docs = [], seen = new Set();
    let bytes = 0;
    for (const key of keys) {
      if (seen.has(key[1])) break;
      const doc = await vaultControl(key);
      if (!doc || vaultTooLarge(doc,state.index[doc.k])) {after=key;continue;}
      doc.baseVer = state.index[doc.k].ver;
      const size = vaultBytes(doc);
      if (docs.length && bytes + size > syncLimits.batchBytes) break;
      after=key;
      seen.add(doc.k);
      docs.push(doc);
      bytes += size;
    }
    if (!docs.length) continue;
    const result = await vaultRequest('push', docs);
    const conflicts = new Set(result.conflicts.map(row => row.k));
    const tx = disk.db.transaction('control', 'readwrite'), done = idbDone(tx);
    for (const doc of docs) {
      if (!conflicts.has(doc.k)) tx.objectStore('control').delete(['vaultArchive', doc.k, doc.variant]);
    }
    await done;
    if (conflicts.size) return false;
  }
}

async function vaultCycle() {
  if (!vault.enabled || !vault.keys || !disk.db) {
    return;
  }
  const state = await vaultControl('vaultState') || {
    seq: 0,
    index: {}
  };
  let local = await vaultLocal(state.index);
  vault.oversized.clear();
  for (let attempt = 0; attempt <= 3; attempt++) {
    let part;
    do {
      part = await vaultRequest('pull?since=' + state.seq + '&limit=200');
      vault.stats = part.stats;
      await vaultMerge(part, state, local);
    } while (part.more);
    if (!await vaultUploadArchives(state)) continue;
    local = await vaultLocal(state.index);
    const dirty = [];
    for (const [k, r] of local) {
      if (!vaultClean(r, state.index[k]) && !(r.deleted && !state.index[k])) {
        dirty.push(await vaultWire(r, state.index[k]?.ver ?? null));
      }
    }
    let conflicts = false;
    await vaultBatches(dirty, async batch => {
      const result = await vaultRequest('push', batch);
      conflicts ||= result.conflicts.length > 0;
      vault.stats = result.stats || vault.stats;
      for (const {k: k, ver: ver, seq: seq} of result.written) {
        if (seq === state.seq + 1) {
          state.seq = seq;
        }
        const r = local.get(k);
        state.index[k] = {
          col: r.col,
          id: r.id,
          stamp: r.stamp,
          deleted: r.deleted,
          sig: r.sig,
          ver: ver
        };
      }
      await vaultSet('vaultState', state);
    },local);
    if (!conflicts) {
      vault.last = Date.now();
      await vaultSet('vaultLast', {
        at: vault.last,
        stats: vault.stats
      });
      return;
    }
  }
  throw Error('其他设备仍在修改，稍后将继续同步。');
}

function vaultPaint() {
  const el = $('#vault-card');
  if (el) {
    el.outerHTML = vaultCard();
  }
}

async function vaultRun() {
  clearTimeout(vault.timer);
  if (!vault.enabled || !accountUser || !vault.initialized) {
    return;
  }
  if (vault.job) {
    vault.again = true;
    return vault.job;
  }
  vault.job = Promise.resolve().then(async () => {
    try {
      if (!navigator.onLine) {
        throw Error('未联网，本机修改已保留。');
      }
      vault.message = '正在同步…';
      vaultPaint();
      const work = async () => {
        if (await vaultControl('vaultEnabled') === false) {
          vault.enabled = false;
          vault.keys = null;
          return;
        }
        await vaultCycle();
      };
      if (navigator.locks) {
        await navigator.locks.request('vault-sync:' + accountUser.id, work);
      } else {
        await work();
      }
      vault.message = '同步完成。';
    } catch (e) {
      if (e.retryAfter) {
        vaultSchedule(e.retryAfter * 1e3);
      }
      vault.message = e.name === 'OperationError' ? '记录解密失败，请重新登录。' : e.message || '同步失败。';
    } finally {
      vault.job = null;
      vaultPaint();
      if (vault.again) {
        vault.again = false;
        vaultSchedule(3e3);
      }
    }
  });
  return vault.job;
}

function vaultSchedule(ms = 3e3) {
  if (!vault.initialized || !vault.enabled) {
    return;
  }
  clearTimeout(vault.timer);
  vault.timer = setTimeout(vaultRun, ms);
}

function vaultCard() {
  if (!accountUser) {
    return '';
  }
  const button = (a, label) => '<button class="btn ghost sm" data-vault="' + a + '">' + label + '</button>';
  const used = vault.stats ? storageSize(vault.stats.bytes) : '—';
  const content = vault.enabled ? '<p>上次同步：' + (vault.last ? esc(new Date(vault.last).toLocaleString()) : '尚未完成') + '</p><p>云端 ' + (vault.stats?.count ?? '—') + ' 条 · 含历史共 ' + used + '</p><div class="row">' + button('sync', '立即同步') + button('backup', '下载加密备份') + acctButton('password', '修改密码') + button('stop', '在这台设备停止同步') + '</div>' : '<p>开启后，记录在这台设备上加密，登录同一账号即可在其他设备恢复。</p>' + (vault.unlock ? '<label>当前密码<input id="vault-password" type="password" autocomplete="current-password"></label>' + button('unlock', '确认开启') : button('enable', '开启云端存储'));
  const large=vault.oversized.size?'<details><summary>'+vault.oversized.size+' 条记录太大，只保存在这台设备上</summary><ul>'+
    Array.from(vault.oversized.values(),r=>'<li>'+esc(r.col)+' · '+esc(r.label)+'</li>').join('')+'</ul></details>':'';
  return '<section class="card" id="vault-card"><h2>云端存储</h2>' + content + large + '<p role="status" class="fine">' + esc(vault.message) + '</p></section>';
}

async function vaultStart() {
  if (!disk.db) {
    return;
  }
  if (!accountUser) {
    await claimCleanup().catch(() => {});
    return;
  }
  vault.keys = await vaultControl('accountKeys');
  vault.enabled = !!vault.keys && await vaultControl('vaultEnabled') !== false;
  const last = await vaultControl('vaultLast');
  vault.last = last?.at || 0;
  vault.stats = last?.stats;
  vault.initialized = true;
  vaultPaint();
  await claimPrompt().catch(() => {
    vault.message = '本机记录暂时无法核对，下次打开重试。';
    vaultPaint();
  });
  vaultSchedule(0);
  setInterval(() => {
    if (!document.hidden) {
      vaultRun();
    }
  }, 3e5);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      vaultSchedule(0);
    }
  });
}

async function vaultHasPending() {
  if (vault.job) {
    await vault.job;
  }
  if (await idbValue(disk.db.transaction('control').objectStore('control').count(vaultArchiveRange()))) return true;
  const state = await vaultControl('vaultState') || {
    index: {}
  };
  const local = await vaultLocal(state.index);
  return [ ...local ].some(([k, r]) => !vaultClean(r, state.index[k]) && (!r.deleted || state.index[k]));
}

document.addEventListener('click', async e => {
  const el = e.target.closest?.('[data-vault]');
  if (!el) {
    return;
  }
  el.disabled = true;
  try {
    switch (el.dataset.vault) {
     case 'sync':
      await vaultRun();
      break;

     case 'backup':
      {
        const data = await vaultBackup();
        const url = URL.createObjectURL(data), a = document.createElement('a');
        a.href = url;
        a.download = '自我观察本-加密备份-' + dayKey() + '.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 6e4);
        break;
      }

     case 'unlock':
      {
        const pw = $('#vault-password').value;
        if (!pw) {
          throw Error('请输入当前账号的密码。');
        }
        $('#vault-password').value = '';
        const params = await acctApi('auth/salt?u=' + encodeURIComponent(accountUser.username));
        const p = await accountCrypto.password(pw, params.kdf_salt, params.kdf_iter);
        const wrapped = await acctApi('auth/keys', {
          currentAuth: p.authKey
        });
        const raw = await accountCrypto.unwrap(p.kek, wrapped.wrapped_keys);
        try {
          vault.keys = await accountCrypto.keys(raw);
          await acctDbKeys(accountUser.id, vault.keys);
        } finally {
          raw.fill(0);
        }
        vault.unlock = false;
        await vaultSet('vaultEnabled', true);
        vault.enabled = true;
        await vaultRun();
        break;
      }

     case 'stop':
      {
        if (vault.job) {
          await vault.job;
        }
        const stop = async () => {
          const tx = disk.db.transaction('control', 'readwrite'), done = idbDone(tx), store = tx.objectStore('control');
          store.put(false, 'vaultEnabled');
          store.delete('accountKeys');
          await done;
        };
        if (navigator.locks) {
          await navigator.locks.request('vault-sync:' + accountUser.id, stop);
        } else {
          await stop();
        }
        vault.enabled = false;
        vault.keys = null;
        vault.message = '已停止同步，本机记录已保留。';
        break;
      }

     case 'enable':
      {
        vault.keys = await vaultControl('accountKeys');
        if (!vault.keys) {
          vault.unlock = true;
          vault.message = '请输入当前密码以解开数据钥匙。';
          break;
        }
        await vaultSet('vaultEnabled', true);
        vault.enabled = true;
        await vaultRun();
        break;
      }
    }
  } catch (err) {
    vault.message = err.message || '操作失败。';
  } finally {
    el.disabled = false;
    vaultPaint();
  }
});
