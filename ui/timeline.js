const journalDialog = () => $('#journal-dialog');

const journalButton = (act, label, attrs = '', cls = 'btn ghost sm') => '<button type="button" class="' + cls + '" data-act="' + act + '" ' + attrs + '>' + esc(label) + '</button>';

const dataAttr = (k, v) => 'data-' + k + '="' + esc(v) + '"';

const jClose = () => journalDialog().close();

function openJournalDialog(html) {
  const d = journalDialog();
  d.innerHTML = html;
  if (!d.open) {
    d.showModal();
  }
}

const tlState = {
  busy: false,
  asked: null,
  undo: null
};

function offerJournalUndo(label, run) {
  clearTimeout(tlState.undo?.timer);
  tlState.undo = {
    label: label,
    run: run,
    timer: setTimeout(() => {
      tlState.undo = null;
      updateUndo();
    }, 10000)
  };
  updateUndo();
}

async function journalWrite(changes) {
  if (changes.some(([c, k]) => c === 'meta' && k === 'tlcats')) {
    changes = [ ...changes, [ 'meta', 'tlcatsUpdated', {} ] ];
  }
  const stamp = Date.now(), rows = changes.map(([c, k, v]) => [ c, k, v === undefined || Array.isArray(v) ? v : {
    ...v,
    _t: stamp
  } ]);
  if (mode === 'cloud') {
    const batch = base.firestore.batch();
    for (const [c, k, v] of rows) {
      const ref = base.collection(c).doc(k);
      if (v === undefined) {
        batch.delete(ref);
      } else {
        batch.set(ref, v);
      }
    }
    await batch.commit();
  }
  const old = rows.map(([c, k]) => S[c][k]);
  function assign(c, k, v) {
    if (v === undefined) {
      delete S[c][k];
    } else {
      S[c][k] = v;
    }
  }
  rows.forEach(([c, k, v]) => assign(c, k, v));
  try {
    if (mode === 'idb') {
      await writeRows(rows);
    } else if (mode !== 'cloud' && !lsWrite()) {
      throw Error('本机保存失败。');
    }
  } catch (e) {
    rows.forEach(([c, k, v], i) => {
      if (S[c][k] === v) {
        assign(c, k, old[i]);
      }
    });
    throw e;
  }
  const del = readDel();
  for (const [c, k, v] of rows) {
    if (v === undefined) {
      del[c + '/' + k] = stamp;
    } else {
      delete del[c + '/' + k];
    }
  }
  writeDel(del);
  noteLocalChange();
  queueRefresh();
}

const showJournalError = msg => {
  if ($('#j-error')) {
    $('#j-error').textContent = msg;
  } else {
    toast(msg);
  }
};

const tlOptions = id => [ ...tlCats(), ...id && !tlCats().some(c => c.id === id) ? [ tlCat(id) ] : [] ].map(c => '<option value="' + esc(c.id) + '"' + (c.id === id ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('');

const tlTint = id => /^#[\da-f]{6}$/i.test(tlCat(id).color) ? tlCat(id).color : '#837e78';

function tlLines(day, k) {
  const now = new Date, s = tlSummary(day, k < ymd(now) ? 1440 : k > ymd(now) ? 0 : tlMinute(hm(now)));
  // A linked timer can finish on a different date from its plan.
    if (s.byPlan.size) {
    for (const [date, other] of Object.entries(S.days)) {
      if (date === k) {
        continue;
      }
      for (const r of other.tl || []) {
        if (!s.byPlan.has(r.planId)) {
          continue;
        }
        const n = tlMinute(r.end) - tlMinute(r.start);
        if (n > 0) {
          s.byPlan.set(r.planId, s.byPlan.get(r.planId) + n);
          s.completed += n;
        }
      }
    }
  }
  const lines = [ ...s.categories ].sort((a, b) => b[1] - a[1]).map(([id, n]) => tlCat(id).name + ' · ' + tlDuration(n));
  lines.push('未记录 · ' + tlDuration(s.unrecorded));
  return {
    s: s,
    lines: lines
  };
}

function tlPlanLine(p, s) {
  const n = s.byPlan.get(p.id) || 0;
  return '计划 ' + p.start + '–' + p.end + ' ' + tlCat(p.cat).name + ' ' + (p.label || '') + ' → 实际做了 ' + tlDuration(n) + '（' + Math.round(100 * n / (tlMinute(p.end) - tlMinute(p.start))) + '%）';
}

function tlMaterials(day, k) {
  const {s: s} = tlLines(day, k);
  return [ ...(day.tl || []).map(r => '实际 ' + r.start + '–' + r.end + ' ' + tlCat(r.cat).name + ' ' + (r.label || '')), ...(day.plan || []).map(r => tlPlanLine(r, s)) ].slice(0, 120).map(t => t.slice(0, 300));
}

function tlReview(k, d) {
  if (!d.tl?.length && !d.plan?.length) {
    return '';
  }
  return '<a class="card journal-link" href="#tl?date=' + k + '"><strong>今天的时间</strong><span>' + esc(tlLines(d, k).lines.slice(0, 3).join('　')) + '</span><b>›</b></a>';
}

function tlBoard(day) {
  const actual = (day.tl || []).slice().sort((a, b) => a.start.localeCompare(b.start)), plans = day.plan || [], all = [ ...actual, ...plans ];
  if (!all.length) {
    return '<p class="fine">当天还没有时段。可以先排计划，也可以补记已经做过的事。</p>';
  }
  const first = Math.max(0, Math.min(...all.map(r => tlMinute(r.start))) - 30);
  const end = Math.min(1440, Math.max(...all.map(r => tlMinute(r.end) + 30), sel === dayKey() ? tlMinute(hm(new Date)) : 0)), scale = 1.15, top = t => (t - first) * scale;
  function blocks(rows, kind) {
    const lanes = [];
    const layout = rows.slice().sort((a, b) => a.start.localeCompare(b.start)).map(r => {
      const a = tlMinute(r.start), b = tlMinute(r.end);
      let lane = lanes.findIndex(t => t <= a);
      if (lane < 0) {
        lane = lanes.length;
      }
      lanes[lane] = Math.max(b, a + 24 / scale);
      return {
        r: r,
        lane: lane,
        a: a,
        b: b
      };
    });
    return layout.map(({r: r, lane: lane, a: a, b: b}) => {
      const pos = 'top:' + top(a) + 'px;height:' + Math.max(24, (b - a) * scale) + 'px;left:' + lane / lanes.length * 100 + '%;width:' + 100 / lanes.length + '%;--tint:' + tlTint(r.cat);
      const attrs = dataAttr('id', r.id) + ' ' + dataAttr('kind', kind);
      return '<div class="tl-block ' + kind + '" ' + dataAttr('row', r.id) + ' style="' + pos + '">' + journalButton('tlEdit', tlCat(r.cat).name + (r.label ? ' · ' + r.label : ''), attrs + ' title="' + esc(r.start + '–' + r.end) + '"', 'tl-row-main') + (kind === 'plan' ? journalButton('tlFromPlan', '开始', attrs, 'tl-inline') : '') + (kind === 'plan' && r.src?.type === 'chat' && AI_ON ? '<a class="tl-inline" href="#chat?id=' + encodeURIComponent(r.src.chatId) + '">对话 ↗</a>' : '') + '</div>';
    }).join('');
  }
  const gaps = [];
  let cursor = first;
  for (const r of actual) {
    const a = tlMinute(r.start);
    if (a > cursor) {
      gaps.push([ cursor, a ]);
    }
    cursor = Math.max(cursor, tlMinute(r.end));
  }
  if (cursor < end) {
    gaps.push([ cursor, end ]);
  }
  const g = gaps.map(([a, b]) => journalButton('tlGap', '未记录 · 补记 ›', dataAttr('start', tlClock(a)) + ' ' + dataAttr('end', tlClock(b)) + ' style="top:' + top(a) + 'px;height:' + (b - a) * scale + 'px"', 'tl-gap')).join('');
  let ticks = '';
  for (let n = Math.ceil(first / 60) * 60; n < end; n += 60) {
    ticks += '<time style="top:' + top(n) + 'px">' + tlClock(n) + '</time>';
  }
  return '<div class="tl-columns"><span></span><b>计划</b><b>实际</b></div><div class="tl-chart" style="height:' + Math.ceil((end - first) * scale) + 'px"><div class="tl-axis">' + ticks + '</div><div class="tl-track">' + blocks(plans, 'plan') + '</div><div class="tl-track">' + g + blocks(actual, 'tl') + '</div></div>';
}

function vTimeline() {
  const d = getDay(sel), t = S.meta.timer, {s: s, lines: lines} = tlLines(d, sel);
  const card = '<section id="tl-now" class="card"><span class="fine">正在做</span><h2>' + (t ? esc(tlCat(t.cat).name) + ' <small class="tl-elapsed">' + tlDuration(Math.max(0, Math.floor((Date.now() - Date.parse(t.startISO)) / 60000))) + '</small>' : '现在在做什么？') + '</h2>' + (t ? '<p>' + esc(t.label) + '</p>' + journalButton('tlStop', '结束') + ' ' + journalButton('tlRenameTimer', '改备注') : '') + '</section>';
  const grid = sel === dayKey() ? '<div class="tl-cats">' + tlCats().map(c => '<div style="--tint:' + tlTint(c.id) + '">' + journalButton('tlStart', c.name, dataAttr('cat', c.id), 'tl-cat') + journalButton('tlStartNote', '…', dataAttr('cat', c.id) + ' aria-label="' + esc(c.name) + '备注"', 'tl-more') + '</div>').join('') + '</div>' : '';
  return '<div class="tl-page">' + card + grid + '<div class="row">' + journalButton('tlNewPlan', '排计划') + journalButton('tlNew', '补记时段') + journalButton('tlCategories', '管理类别', '', 'linkbtn') + '</div><section class="card tl-board"><h2>时间线</h2>' + tlBoard(d) + '</section><section class="card" id="tl-summary"><h2>当天小结</h2>' + lines.map(x => '<p>' + esc(x) + '</p>').join('') + (d.plan || []).map(p => '<p>' + esc(tlPlanLine(p, s)) + '</p>').join('') + (d.plan?.length ? '<strong>计划 ' + tlDuration(s.planned) + '，按计划完成 ' + tlDuration(s.completed) + '</strong>' : '') + '</section></div>';
}

function tlTimeInput(k, label, val) {
  return '<label>' + label + '<span class="tl-times">' + journalButton('tlStep', '−5', dataAttr('field', k) + ' data-delta="-5"') + '<input id="tl-' + k + '" type="time" value="' + esc(val === '24:00' ? '00:00' : val) + '">' + journalButton('tlStep', '+5', dataAttr('field', k) + ' data-delta="5"') + '</span></label>';
}

function tlEditor(kind, row = {}) {
  const date = sel, start = row.start || tlClock(Math.min(1410, tlMinute(hm(new Date)))), end = row.end || tlClock(Math.min(1440, tlMinute(start) + 30));
  openJournalDialog('<h2>' + (row.id ? '编辑' : kind === 'tl' ? '补记' : '新增') + (kind === 'tl' ? '实际时段' : '计划') + '</h2><label>类别<select id="tl-cat">' + tlOptions(row.cat || tlCats()[0]?.id) + '</select></label><label>备注<input id="tl-label" maxlength="160" value="' + esc(row.label || '') + '"></label>' + tlTimeInput('start', '开始', start) + tlTimeInput('end', '结束（00:00 表示午夜）', end) + '<p id="j-error" role="status"></p><div class="row">' + journalButton('tlSave', '保存', '', 'btn') + (row.id ? journalButton('tlDelete', '删除') : '') + journalButton('jClose', '取消') + '</div>');
  tlState.editor = {
    date: date,
    kind: kind,
    row: row
  };
}

function tlSaveEditor() {
  const {date: date, kind: kind, row: row} = tlState.editor, cat = $('#tl-cat').value, start = $('#tl-start').value, end = $('#tl-end').value === '00:00' ? '24:00' : $('#tl-end').value;
  if (!cat || !Number.isFinite(tlMinute(start) + tlMinute(end)) || start === end) {
    return showJournalError('请填写类别和两个不同的时间。');
  }
  const value = {
    ...row,
    id: row.id || newId(),
    cat: cat,
    start: start,
    end: end,
    label: $('#tl-label').value.trim(),
    src: row.src || 'manual'
  };
  if (end < start) {
    return tlPersist([ {
      date: date,
      kind: kind,
      row: {
        ...value,
        end: '24:00'
      }
    }, {
      date: addDays(date, 1),
      kind: kind,
      row: {
        ...value,
        id: newId(),
        start: '00:00'
      }
    } ], []);
  }
  return tlPersist([ {
    date: date,
    kind: kind,
    row: value
  } ], []);
}

async function tlPersist(entries, extra, origin, crop = false) {
  const days = new Map, conflicts = [];
  for (const {date: date, kind: kind, row: row} of entries) {
    const day = days.get(date) || getDay(date);
    days.set(date, day);
    const rows = day[kind] || [];
    if (kind === 'plan') {
      day.plan = rows.filter(r => r.id !== row.id).concat(row);
    } else {
      const result = tlInsert(rows, row, crop);
      if (result.conflicts) {
        conflicts.push(...result.conflicts);
      } else {
        day.tl = result.rows;
      }
    }
  }
  if (conflicts.length) {
    tlState.crop = () => tlPersist(entries, extra, origin, true);
    openJournalDialog('<h2>实际时段重叠</h2><p>' + conflicts.map(r => esc(r.start + '–' + r.end + ' ' + tlCat(r.cat).name + ' ' + r.label)).join('<br>') + '</p>' + journalButton('tlCrop', '裁剪相邻时段', '', 'btn') + ' ' + journalButton('jClose', '取消'));
    return;
  }
  await journalWrite([ ...days ].map(([k, d]) => [ 'days', k, d ]).concat(extra));
  jClose();
  render(true);
  if (reducedMotion()) {
    return;
  }
  const current = $('#tl-now');
  if (origin && current) {
    const dest = current.getBoundingClientRect();
    current.animate([ {
      transform: 'translate(' + (origin.x - dest.x) + 'px,' + (origin.y - dest.y) + 'px) scale(.35)',
      opacity: .3
    }, {
      transform: 'none',
      opacity: 1
    } ], {
      duration: 220
    });
  }
  for (const {row: row} of entries) {
    document.querySelector('[data-row="' + CSS.escape(row.id) + '"]')?.animate([ {
      transform: 'scaleY(.1)',
      opacity: 0
    }, {
      transform: 'scaleY(1)',
      opacity: 1
    } ], {
      duration: 220
    });
  }
}

function tlSwitch(cat, label = '', planId, origin, finish = new Date) {
  const old = S.meta.timer;
  if (old && +finish < Date.parse(old.startISO)) {
    return showJournalError('结束时间早于开始时间。');
  }
  const entries = old ? tlSplit(old, finish).map(x => ({
    ...x,
    kind: 'tl'
  })) : [];
  return tlPersist(entries, [ [ 'meta', 'timer', cat ? {
    cat: cat,
    label: label,
    startISO: finish.toISOString(),
    ...planId ? {
      planId: planId
    } : {}
  } : undefined ] ], origin);
}

function tlPromptTimer() {
  const t = S.meta.timer;
  if (!ready || !t || tlState.asked === t.startISO || Date.now() - Date.parse(t.startISO) <= 16 * 3600000 || journalDialog().open) {
    return;
  }
  tlState.asked = t.startISO;
  openJournalDialog('<h2>还在做「' + esc(tlCat(t.cat).name) + '」吗？</h2>' + journalButton('tlEndAt', '在某个时间结束') + ' ' + journalButton('jClose', '继续'));
}

function tlCategories() {
  openJournalDialog('<h2>管理类别</h2>' + tlCats().map(c => '<div class="row"><b>' + esc(c.name) + '</b>' + journalButton('tlCategoryEdit', '编辑', dataAttr('cat', c.id), 'linkbtn') + '</div>').join('') + journalButton('tlCategoryEdit', '添加类别') + ' ' + journalButton('jClose', '完成'));
}

function tlCategoryForm(id) {
  const c = tlCats().find(x => x.id === id);
  openJournalDialog('<h2>' + (c ? '编辑类别' : '添加类别') + '</h2><label>名称<input id="tl-name" maxlength="30" value="' + esc(c?.name || '') + '"></label><label>颜色<input type="color" id="tl-color" value="' + tlTint(id) + '"></label><p id="j-error"></p>' + journalButton('tlCategorySave', '保存', dataAttr('cat', id || '')) + ' ' + (c ? journalButton('tlCategoryDelete', '删除', dataAttr('cat', id)) : '') + ' ' + journalButton('jClose', '取消'));
}

function tlNote(cat, rename) {
  openJournalDialog('<h2>' + esc(tlCat(cat).name) + '</h2><label>备注<input id="tl-note" maxlength="160" value="' + esc(rename ? S.meta.timer.label : '') + '"></label>' + journalButton(rename ? 'tlNoteSave' : 'tlNoteStart', rename ? '保存' : '开始', dataAttr('cat', cat)) + ' ' + journalButton('jClose', '取消'));
  $('#tl-note').focus();
}

const TL_ACTIONS = {
  jClose: jClose,
  tlCategories: tlCategories,
  tlCategoryEdit: e => tlCategoryForm(e.dataset.cat),
  async tlCategorySave(e) {
    const id = e.dataset.cat || newId(), name = $('#tl-name').value.trim(), color = $('#tl-color').value;
    if (!name || tlCats().some(c => c.id !== id && c.name === name)) {
      return showJournalError('请填写不重复的类别名称。');
    }
    const cats = tlCats().slice(), i = cats.findIndex(x => x.id === id);
    cats.splice(i < 0 ? cats.length : i, i < 0 ? 0 : 1, {
      id: id,
      name: name,
      color: color
    });
    await journalWrite([ [ 'meta', 'tlcats', cats ] ]);
    tlCategories();
  },
  async tlCategoryDelete(e) {
    await journalWrite([ [ 'meta', 'tlcats', tlCats().filter(c => c.id !== e.dataset.cat) ] ]);
    tlCategories();
  },
  tlStart: e => tlSwitch(e.dataset.cat, '', null, e.getBoundingClientRect()),
  tlStartNote: e => tlNote(e.dataset.cat, false),
  tlRenameTimer: () => tlNote(S.meta.timer.cat, true),
  async tlNoteSave() {
    await journalWrite([ [ 'meta', 'timer', {
      ...S.meta.timer,
      label: $('#tl-note').value.trim()
    } ] ]);
    jClose();
  },
  tlNoteStart: e => tlSwitch(e.dataset.cat, $('#tl-note').value.trim()),
  tlStop: () => tlSwitch(null),
  tlEndAt() {
    openJournalDialog('<h2>在某个时间结束</h2><input type="datetime-local" id="tl-end-at" value="' + ymd(new Date) + 'T' + hm(new Date) + '"><p id="j-error"></p>' + journalButton('tlEndAtSave', '结束') + ' ' + journalButton('jClose', '继续'));
  },
  tlEndAtSave() {
    const at = new Date($('#tl-end-at').value);
    if (!Number.isFinite(+at) || at > new Date) {
      return showJournalError('请选择已经过去的时间。');
    }
    return tlSwitch(null, '', null, null, at);
  },
  tlEdit: e => tlEditor(e.dataset.kind, getDay(sel)[e.dataset.kind].find(x => x.id === e.dataset.id)),
  tlNewPlan: () => tlEditor('plan'),
  tlNew: () => tlEditor('tl'),
  tlGap: e => tlEditor('tl', {
    start: e.dataset.start,
    end: e.dataset.end
  }),
  tlFromPlan(e) {
    const p = getDay(sel).plan.find(x => x.id === e.dataset.id);
    return tlSwitch(p.cat, p.label, p.id, e.getBoundingClientRect());
  },
  tlStep(e) {
    const el = $('#tl-' + e.dataset.field), n = e.dataset.field === 'end' && el.value === '00:00' ? 1440 : tlMinute(el.value);
    el.value = tlClock(Math.max(0, Math.min(e.dataset.field === 'end' ? 1440 : 1439, n + Number(e.dataset.delta))) % 1440);
  },
  tlSave: tlSaveEditor,
  tlCrop: () => tlState.crop(),
  async tlDelete() {
    const {date: date, kind: kind, row: row} = tlState.editor, d = getDay(date);
    d[kind] = d[kind].filter(x => x.id !== row.id);
    await journalWrite([ [ 'days', date, d ] ]);
    jClose();
    offerJournalUndo('已删除时段', () => tlPersist([ {
      date: date,
      kind: kind,
      row: row
    } ], []));
  }
};

setInterval(() => {
  const el = $('.tl-elapsed'), t = S.meta.timer;
  if (el && t) {
    el.textContent = tlDuration(Math.max(0, Math.floor((Date.now() - Date.parse(t.startISO)) / 60000)));
  }
}, 60000);
