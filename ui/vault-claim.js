// A reservation in the anonymous database keeps a crash between the two databases retryable.
function anonymousDb() {
  return new Promise((ok, no) => {
    const q = indexedDB.open('zwgcb', 1);
    q.onupgradeneeded = () => {
      q.result.createObjectStore('control');
      q.result.createObjectStore('docs');
    };
    q.onerror = () => no(q.error);
    q.onsuccess = () => ok(q.result);
  });
}

const claimLock = work => navigator.locks ? navigator.locks.request('journal-anonymous-claim', work) : work();

async function claimSource(db) {
  const cols = blankCols();
  for (const r of await vaultSnapshot(db)) {
    cols[r.col][r.id] = r.value;
  }
  const raw = nativeStore.getItem(LS_KEY), legacy = raw ? JSON.parse(raw) : {}, primary = await vaultControl('primary', db);
  const del = JSON.parse(nativeStore.getItem(DEL_KEY) || '{}');
  const source = raw && (!primary || await backupFingerprint(raw) !== primary.hash) ? mergeSnap({
    cols: cols,
    del: del
  }, {
    cols: legacy,
    del: del
  }).cols : cols;
  const drafts = JSON.parse(nativeStore.getItem(LS_DRAFT) || '{}');
  const rows = COLS.flatMap(col => Object.entries(source[col] || {}).map(([id, value]) => ({
    col: col,
    id: id,
    value: value
  })));
  return {
    rows: rows,
    cols: source,
    del: del,
    drafts: drafts,
    raw: raw
  };
}

async function claimMark(db, uid, record, complete = false) {
  const tx = db.transaction('control', 'readwrite'), done = idbDone(tx), store = tx.objectStore('control'), q = store.get('anonymousClaim');
  q.onsuccess = () => {
    if (q.result && (q.result.uid !== uid || q.result.completed && !complete)) {
      tx.abort();
      return;
    }
    store.put(record, 'anonymousClaim');
  };
  await done;
}

async function claimCopy(db, source) {
  const uid = accountUser.id;
  await claimMark(db, uid, {
    uid: uid,
    completed: false
  });
  const local = blankCols();
  for (const r of await vaultSnapshot()) {
    local[r.col][r.id] = r.value;
  }
  const merged = mergeSnap({
    cols: local,
    del: readDel()
  }, {
    cols: source.cols,
    del: source.del
  });
  const changes = [];
  for (const c of COLS) {
    for (const id of new Set([ ...Object.keys(local[c]), ...Object.keys(merged.cols[c]) ])) {
      const before = local[c][id], value = merged.cols[c][id];
      if (JSON.stringify(before) !== JSON.stringify(value)) {
        changes.push({
          col: c,
          id: id,
          before: before,
          value: value,
          stamp: merged.del[c + '/' + id] || 0
        });
      }
    }
  }
  const state = await vaultControl('vaultState') || {
    index: {}
  };
  state.seq = 0;
  await vaultApply(state, changes);
  const checked = blankCols();
  for (const r of await vaultSnapshot()) {
    checked[r.col][r.id] = r.value;
  }
  for (const {col: col, id: id} of source.rows) {
    if (JSON.stringify(checked[col][id]) !== JSON.stringify(merged.cols[col][id])) {
      throw Error('逐条核对失败，原记录已保留。');
    }
  }
  Object.assign(drafts, {
    ...source.drafts,
    ...drafts
  });
  if (!saveDrafts()) {
    throw Error('草稿复制失败，原草稿已保留。');
  }
  writeDel({
    ...merged.del,
    ...readDel()
  });
  const hashes = [];
  for (const r of source.rows) {
    hashes.push([ r.col, r.id, await vaultDigest(r.value) ]);
  }
  const legacyHashes = [];
  const legacy = source.raw ? JSON.parse(source.raw) : {};
  for (const col of COLS) {
    for (const [id, value] of Object.entries(legacy[col] || {})) {
      legacyHashes.push([ col, id, await vaultDigest(value) ]);
    }
  }
  const draftHashes = {};
  for (const [k, v] of Object.entries(source.drafts)) {
    draftHashes[k] = await vaultDigest(v);
  }
  await claimMark(db, uid, {
    uid: uid,
    claimedBy: uid,
    completed: true,
    until: Date.now() + 30 * 864e5,
    hashes: hashes,
    draftHashes: draftHashes,
    legacyHashes: legacyHashes,
    legacyHash: source.raw ? await backupFingerprint(source.raw) : null
  }, true);
}

async function claimCleanup() {
  const db = await anonymousDb();
  try {
    await claimLock(async () => {
      const mark = await vaultControl('anonymousClaim', db);
      if (!mark?.completed || mark.cleaned || Date.now() < mark.until) {
        return;
      }
      const current = await vaultSnapshot(db), hashes = new Map(mark.hashes.map(([c, k, h]) => [ vaultPath(c, k), h ])), eligible = [];
      for (const r of current) {
        if (hashes.get(vaultPath(r.col, r.id)) === await vaultDigest(r.value)) {
          eligible.push(r);
        }
      }
      const originalDrafts = JSON.parse(nativeStore.getItem(LS_DRAFT) || '{}');
      const removeKeys = [];
      for (const [k, v] of Object.entries(originalDrafts)) {
        if (mark.draftHashes[k] === await vaultDigest(v)) {
          removeKeys.push(k);
        }
      }
      const raw = nativeStore.getItem(LS_KEY), removeRaw = raw && mark.legacyHash === await backupFingerprint(raw);
      let prunedRaw = raw;
      if (raw && mark.legacyHashes && !removeRaw) {
        const legacy = JSON.parse(raw);
        for (const [col, id, digest] of mark.legacyHashes) {
          if (Object.hasOwn(legacy[col] || {}, id) && await vaultDigest(legacy[col][id]) === digest) {
            delete legacy[col][id];
          }
        }
        prunedRaw = JSON.stringify(legacy);
      }
      const tx = db.transaction([ 'control', 'docs' ], 'readwrite'), done = idbDone(tx), docs = tx.objectStore('docs');
      for (const r of eligible) {
        const key = [ r.col, r.id ], q = docs.get(key);
        q.onsuccess = () => {
          if (JSON.stringify(q.result) === JSON.stringify(r.value)) {
            docs.delete(key);
          }
        };
      }
      await done;
      if (raw && nativeStore.getItem(LS_KEY) === raw) {
        if (removeRaw) {
          nativeStore.removeItem(LS_KEY);
        } else if (prunedRaw !== raw) {
          nativeStore.setItem(LS_KEY, prunedRaw);
        }
      }
      const recent = JSON.parse(nativeStore.getItem(LS_DRAFT) || '{}');
      for (const k of removeKeys) {
        if (JSON.stringify(recent[k]) === JSON.stringify(originalDrafts[k])) {
          delete recent[k];
        }
      }
      nativeStore.setItem(LS_DRAFT, JSON.stringify(recent));
      await claimMark(db, mark.uid, {
        uid: mark.uid,
        claimedBy: mark.uid,
        completed: true,
        cleaned: true
      }, true);
      if (!accountUser && eligible.length) {
        location.reload();
      }
    });
  } finally {
    db.close();
  }
}

async function claimPrompt() {
  await claimCleanup();
  if (sessionStorage.getItem('claimLater:' + accountUser.id)) {
    return;
  }
  const db = await anonymousDb();
  try {
    const marker = await vaultControl('anonymousClaim', db);
    if (marker && (marker.completed || marker.uid !== accountUser.id)) {
      return;
    }
    const source = await claimSource(db);
    if (!source.rows.length && !Object.keys(source.drafts).length) {
      return;
    }
    const dates = source.rows.map(r => r.value.date || r.value.created?.slice?.(0, 10) || r.id).filter(validDate).sort();
    const dialog = document.createElement('dialog');
    dialog.id = 'vault-claim';
    dialog.setAttribute('aria-label', '认领本机记录');
    document.body.append(dialog);
    dialog.innerHTML = '<h2>认领本机记录</h2><p>这台设备上有 ' + source.rows.length + ' 条记录' + (dates.length ? '（最早 ' + esc(md(dates[0])) + '，最晚 ' + esc(md(dates.at(-1))) + '）' : '') + '，归到「' + esc(accountUser.username) + '」名下吗？</p><button class="btn" id="claim-yes">归到我的账号</button> <button class="btn ghost" id="claim-no">暂不</button><p role="status"></p>';
    dialog.addEventListener('cancel', () => sessionStorage.setItem('claimLater:' + accountUser.id, '1'));
    dialog.addEventListener('close', () => dialog.remove());
    dialog.querySelector('#claim-no').onclick = () => {
      sessionStorage.setItem('claimLater:' + accountUser.id, '1');
      dialog.close();
    };
    dialog.querySelector('#claim-yes').onclick = async () => {
      const buttons = [ ...dialog.querySelectorAll('button') ];
      buttons.forEach(b => b.disabled = true);
      try {
        await claimLock(async () => {
          const anon = await anonymousDb();
          try {
            const work = async () => claimCopy(anon, await claimSource(anon));
            if (navigator.locks) {
              await navigator.locks.request('vault-sync:' + accountUser.id, work);
            } else {
              await work();
            }
          } finally {
            anon.close();
          }
        });
        dialog.close();
        toast('本机记录已核对并归入账号。');
        vaultSchedule(0);
      } catch (e) {
        dialog.querySelector('[role=status]').textContent = e.message || '认领中断，可重试。';
        buttons.forEach(b => b.disabled = false);
      }
    };
    dialog.showModal();
  } finally {
    db.close();
  }
}
