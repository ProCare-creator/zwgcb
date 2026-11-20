const memoState = {
  doc: null,
  dirty: false,
  timer: null,
  q: '',
  menu: false,
  error: ''
};

const memoKey = id => 'memo:' + id;

const memoDocs = () => Object.entries(S.meta).filter(([k, v]) => k.startsWith('memo:') && v && typeof v.text === 'string').map(([, v]) => v);

const memoRecent = (a, b) => String(b.updated).localeCompare(String(a.updated));

const memoTitle = d => d.text.trim().split(/\r?\n/)[0];

function memoEntry() {
  const docs = memoDocs().sort(memoRecent);
  return '<a class="card journal-link" href="#memo"><strong>备忘录</strong><span>' + docs.length + ' 条' + (docs.length ? ' · ' + esc(memoTitle(docs[0])) : '') + '</span><b>›</b></a>';
}

function memoList() {
  const q = memoState.q.trim().toLocaleLowerCase(), docs = memoDocs().filter(d => d.text.toLocaleLowerCase().includes(q)).sort((a, b) => Number(b.pinned) - Number(a.pinned) || memoRecent(a, b));
  return docs.map(d => '<a class="memo-item" href="#memo?id=' + encodeURIComponent(d.id) + '"><strong>' + (d.pinned ? '<small>置顶</small> ' : '') + esc(memoTitle(d)) + '</strong><span>' + esc((d.text.trim().split(/\r?\n/)[1] || '').slice(0, 90)) + '</span><time>' + esc(new Date(d.updated).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })) + '</time></a>').join('') || '<p class="fine">' + (q ? '没有匹配的备忘。' : '还没有备忘。') + '</p>';
}

function memoBlank(id) {
  const now = (new Date).toISOString();
  return {
    id: id,
    text: '',
    pinned: false,
    created: now,
    updated: now,
    items: [],
    due: null,
    remind: null
  };
}

function vMemo() {
  const id = new URLSearchParams(location.hash.split('?')[1]).get('id');
  if (!id) {
    return '<section class="card"><div class="memo-head"><h1>备忘录</h1>' + journalButton('memoNew', '新建') + '</div><input id="memo-search" type="search" aria-label="搜索备忘全文" placeholder="搜索全文" value="' + esc(memoState.q) + '"><div id="memo-list">' + memoList() + '</div></section>';
  }
  if (memoState.doc?.id !== id) {
    memoState.doc = clone(S.meta[memoKey(id)]) || memoBlank(id);
    memoState.dirty = false;
    memoState.error = '';
    memoState.menu = false;
  }
  const d = memoState.doc;
  return '<section class="memo-editor"><header class="memo-head"><a href="#memo">‹ 备忘录</a><span class="fine" id="memo-status">' + esc(memoState.error || (memoState.dirty ? '正在编辑' : d.text ? '已保存' : '')) + '</span>' + journalButton('memoMenu', '⋯', 'aria-label="备忘菜单"') + '</header>' + (memoState.menu ? '<div class="row memo-menu">' + journalButton('memoPin', d.pinned ? '取消置顶' : '置顶') + journalButton('memoDelete', '删除') + '</div>' : '') + '<textarea id="memo-text" aria-label="备忘正文" placeholder="第一行写标题">' + esc(d.text) + '</textarea></section>';
}

function memoSize() {
  const el = $('#memo-text');
  if (el) {
    el.style.height = 'auto';
    el.style.height = Math.max(el.scrollHeight, window.innerHeight * .6) + 'px';
  }
}

async function memoFlush() {
  clearTimeout(memoState.timer);
  const d = memoState.doc;
  if (!d || !memoState.dirty) {
    return;
  }
  const doc = clone(d);
  memoState.dirty = false;
  try {
    if (doc.text.trim()) {
      await journalWrite([ [ 'meta', memoKey(doc.id), doc ] ]);
    } else if (S.meta[memoKey(doc.id)]) {
      await journalWrite([ [ 'meta', memoKey(doc.id) ] ]);
    }
    if (d === memoState.doc && !memoState.dirty && $('#memo-status')) {
      $('#memo-status').textContent = doc.text.trim() ? '已保存' : '';
    }
  } catch {
    if (d === memoState.doc) {
      memoState.dirty = true;
      memoState.error = '保存失败，请重试';
    }
    throw Error('备忘保存失败。');
  }
}

async function memoDelete() {
  const doc = clone(memoState.doc);
  clearTimeout(memoState.timer);
  memoState.dirty = false;
  if (S.meta[memoKey(doc.id)]) {
    await journalWrite([ [ 'meta', memoKey(doc.id) ] ]);
  }
  memoState.doc = null;
  location.hash = '#memo';
  if (doc.text.trim()) {
    offerJournalUndo('已删除备忘', () => journalWrite([ [ 'meta', memoKey(doc.id), doc ] ]));
  }
}

const MEMO_ACTIONS = {
  memoNew() {
    location.hash = '#memo?id=' + newId();
  },
  memoMenu() {
    memoState.menu = !memoState.menu;
    render(true);
  },
  async memoPin() {
    memoState.doc.pinned = !memoState.doc.pinned;
    memoState.doc.updated = (new Date).toISOString();
    memoState.dirty = true;
    memoState.menu = false;
    await memoFlush();
    render(true);
  },
  memoDelete: memoDelete
};

document.addEventListener('input', e => {
  if (e.target.id === 'memo-search') {
    memoState.q = e.target.value;
    $('#memo-list').innerHTML = memoList();
  }
  if (e.target.id === 'memo-text') {
    memoState.doc.text = e.target.value;
    memoState.doc.updated = (new Date).toISOString();
    memoState.dirty = true;
    memoState.error = '';
    memoSize();
    $('#memo-status').textContent = '正在编辑';
    clearTimeout(memoState.timer);
    memoState.timer = setTimeout(() => memoFlush().catch(e => toast(e.message)), 1000);
  }
});

window.addEventListener('pagehide', () => memoFlush().catch(e => toast(e.message)));

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    memoFlush().catch(e => toast(e.message));
  }
});
