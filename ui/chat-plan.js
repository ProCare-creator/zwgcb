function chatPlanHTML(card, key, live) {
  const state = chat.doc.cards[key], attrs = dataAttr('key', key), added = state?.status === 'added', busy = chat.busy.has(chat.doc.id + ':' + key) || live || !!chat.request;
  const edit = chat.edits.get(chat.doc.id + ':' + key), rows = tlParsePlan(state?.text || card.text) || [];
  let h = '<article class="chat-card" data-card-key="' + esc(key) + '"><strong>' + esc(chatDateLabel(card.date)) + ' 的时间计划</strong>';
  if (edit !== undefined) {
    h += '<textarea aria-label="编辑计划行" rows="5" data-chat-edit="' + esc(key) + '">' + esc(edit) + '</textarea>';
  } else {
    h += '<div class="plan-table">' + rows.map(r => '<div><time>' + r.start + '–' + r.end + '</time><span>' + esc(r.name + ' ' + r.label) + '</span></div>').join('') + '</div>';
  }
  if (added) {
    h += '<a class="linkbtn" href="#tl?date=' + esc(card.date) + '">已加到 ' + esc(chatDateLabel(card.date)) + ' 的计划 ›</a>' + (state.undoUntil > Date.now() ? journalButton('planUndo', '撤销', attrs, 'linkbtn') : '');
  } else {
    h += '<div class="row">' + journalButton('planAdd', '加入时间计划', attrs + (busy ? ' disabled' : ''), 'btn sm') + journalButton('chatEdit', '改一下', attrs + (busy ? ' disabled' : ''), 'linkbtn') + '</div>';
  }
  return h + '</article>';
}

async function chatPlanAdd(key, choice) {
  const doc = chat.doc, card = chatCardAt(key), lock = doc.id + ':' + key;
  if (!card || card.type !== 'plan' || doc.cards[key]?.status === 'added' || chat.request || chat.busy.has(lock)) {
    return;
  }
  const text = chat.edits.get(lock) ?? card.text, rows = tlParsePlan(text);
  if (!rows) {
    toast('每行填写「开始-结束 类别 内容」，最多 12 行。');
    return;
  }
  const day = getDay(card.date), prev = day.plan || [];
  if (prev.length && !choice) {
    openJournalDialog('<h2>当天已有计划</h2>' + journalButton('planReplace', '替换当天的计划', dataAttr('key', key)) + ' ' + journalButton('planAppend', '加在后面', dataAttr('key', key)) + ' ' + journalButton('jClose', '取消'));
    return;
  }
  chat.busy.add(lock);
  try {
    const cats = tlCats().slice(), extra = [];
    let misc = cats.find(c => c.name === '杂事');
    if (!misc && rows.some(r => !cats.some(c => c.name === r.name))) {
      misc = {
        id: newId(),
        name: '杂事',
        color: tlColors[9]
      };
      cats.push(misc);
      extra.push([ 'meta', 'tlcats', cats ]);
    }
    const items = rows.map(r => ({
      id: newId(),
      start: r.start,
      end: r.end,
      cat: (cats.find(c => c.name === r.name) || misc).id,
      label: r.label,
      src: {
        type: 'chat',
        chatId: doc.id
      }
    }));
    day.plan = (choice === 'replace' ? [] : prev).concat(items);
    const next = clone(doc);
    next.updated = (new Date).toISOString();
    next.cards[key] = {
      status: 'added',
      type: 'plan',
      text: text,
      ref: {
        date: card.date,
        ids: items.map(x => x.id)
      },
      undoUntil: Date.now() + 10000,
      ...choice === 'replace' ? {
        replaced: prev
      } : {}
    };
    await journalWrite([ [ 'days', card.date, day ], [ 'meta', 'chat:' + doc.id, next ], ...extra ]);
    doc.cards[key] = next.cards[key];
    doc.updated = next.updated;
    chat.edits.delete(lock);
    setTimeout(() => {
      if (route === 'chat') {
        render(true);
      }
    }, 10100);
    jClose();
  } finally {
    chat.busy.delete(lock);
    render(true);
  }
}

async function chatPlanUndo(key) {
  const doc = chat.doc, s = doc.cards[key], lock = doc.id + ':' + key;
  if (s?.status !== 'added' || s.undoUntil < Date.now() || chat.busy.has(lock)) {
    return;
  }
  chat.busy.add(lock);
  try {
    const day = getDay(s.ref.date), others = (day.plan || []).filter(p => !s.ref.ids.includes(p.id));
    const old = s.replaced || [];
    day.plan = old.filter(p => !others.some(x => x.id === p.id)).concat(others);
    const next = clone(doc);
    next.cards[key] = {
      type: 'plan',
      text: s.text,
      status: 'undone'
    };
    next.updated = (new Date).toISOString();
    await journalWrite([ [ 'days', s.ref.date, day ], [ 'meta', 'chat:' + doc.id, next ] ]);
    doc.cards[key] = next.cards[key];
    doc.updated = next.updated;
  } finally {
    chat.busy.delete(lock);
    render(true);
  }
}

const PLAN_ACTIONS = {
  planAdd: e => chatPlanAdd(e.dataset.key),
  planAppend: e => chatPlanAdd(e.dataset.key, 'append'),
  planReplace: e => chatPlanAdd(e.dataset.key, 'replace'),
  planUndo: e => chatPlanUndo(e.dataset.key)
};
