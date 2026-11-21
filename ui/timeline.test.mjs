import { test } from 'node:test';

import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import vm from 'node:vm';

import { validate } from '../worker/worker.mjs';

const source = f => readFileSync(new URL(f, import.meta.url), 'utf8');

const pad = n => String(n).padStart(2, '0'), hm = d => pad(d.getHours()) + ':' + pad(d.getMinutes());

let seq = 0;

const box = vm.createContext({
  pad: pad,
  hm: hm,
  ymd: d => [ d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate()) ].join('-'),
  newId: () => String(++seq),
  document: new EventTarget,
  window: new EventTarget,
  validDate: s => /^\d{4}-\d\d-\d\d$/.test(s) && new Date(s).toISOString().startsWith(s)
});

const core = vm.runInContext(source('timeline-core.js') + '\n' + source('chat.js') + ';({tlSplit,tlSummary,tlLiveSlice,tlInsert,chatParse})', box);

const plain = x => JSON.parse(JSON.stringify(x));

test('split a running timer at every local midnight, keeping its source and plan', () => {
  const t = {
    cat: 'sleep',
    label: '睡觉',
    startISO: new Date(2026, 10, 20, 23, 30).toISOString(),
    planId: 'p'
  };
  const x = core.tlSplit(t, new Date(2026, 10, 21, 7, 0));
  assert.deepEqual(plain(x.map(v => [ v.date, v.row.start, v.row.end, v.row.planId ])), [ [ '2026-11-20', '23:30', '24:00', 'p' ], [ '2026-11-21', '00:00', '07:00', 'p' ] ]);
  assert.equal(core.tlSplit(t, new Date(2026, 10, 21, 0, 0)).length, 1);
});

test('crop only overlapping intervals, keep both tails and allow touching boundaries', () => {
  const x = {
    id: 'a',
    start: '09:00',
    end: '12:00',
    cat: 'study'
  }, y = {
    id: 'b',
    start: '10:00',
    end: '11:00'
  };
  assert.equal(core.tlInsert([ x ], y).conflicts[0].id, 'a');
  const cropped = core.tlInsert([ x ], y, true).rows;
  assert.deepEqual(plain(cropped.map(r => [ r.start, r.end ])), [ [ '09:00', '10:00' ], [ '10:00', '11:00' ], [ '11:00', '12:00' ] ]);
  assert.equal(new Set(cropped.map(r => r.id)).size, 3);
  assert.equal(core.tlInsert([ x ], {
    ...y,
    start: '12:00',
    end: '12:30'
  }).rows.length, 2);
});

test('matching minutes, linked minutes outside schedule, and daily union', () => {
  const p = {
    cat: 's',
    start: '09:00',
    end: '11:00',
    id: 'p'
  }, s = core.tlSummary({
    plan: [ p, {
      ...p,
      id: 'p2'
    } ],
    tl: [ {
      cat: 's',
      start: '10:00',
      end: '11:00'
    }, {
      cat: 's',
      start: '14:00',
      end: '14:20',
      planId: 'p'
    }, {
      cat: 'gym',
      start: '09:00',
      end: '09:10'
    } ]
  });
  assert.equal(s.byPlan.get('p'), 80);
  assert.equal(s.byPlan.get('p2'), 60);
  assert.equal(s.completed, 80);
  assert.equal(s.planned, 240);
  assert.equal(s.unrecorded, 1350);
});

test('plan has its own quota, bad lines survive, broken and oversized blocks stay literal', () => {
  const block = '<plan date="2026-11-21">\n09:00-10:00 学习 写作\n坏行\n</plan>';
  const p = core.chatParse('<hyp>甲</hyp>\n' + block + '\n<hyp>乙</hyp>\n' + block);
  assert.equal(p.parts.filter(c => c.type === 'plan').length, 1);
  assert.equal(p.parts.filter(c => c.type === 'hyp').length, 2);
  assert.ok(p.parts.some(c => c.type === 'text' && c.text.includes('坏行')));
  for (const raw of [ block.replace('</plan>', ''), block.replace('坏行', Array(13).fill('10:00-10:30 学习 阅读').join('\n')) ]) {
    assert.equal(core.chatParse(raw).parts[0].text, raw);
  }
});

test('timeline material works alone and has item and length limits; memo is excluded', () => {
  const data = {
    date: '2026-11-21',
    materials: {
      timeline: [ '实际 09:00–10:00 学习' ],
      memo: 'private'
    }
  };
  assert.deepEqual(validate(data, 'summary').materials.timeline, data.materials.timeline);
  assert.equal(validate(data, 'summary').materials.memo, undefined);
  for (const timeline of [ Array(121).fill('a'), [ 'x'.repeat(301) ], [ 42 ] ]) {
    assert.throws(() => validate({
      ...data,
      materials: {
        timeline: timeline
      }
    }, 'summary'));
  }
});

test('memo flush stores the optional fields, skips blank drafts and can undo a deletion', async () => {
  const S = {
    meta: {}
  }, box = vm.createContext({
    S: S,
    location: {
      hash: '#memo'
    },
    document: new EventTarget,
    window: new EventTarget,
    clearTimeout: clearTimeout,
    structuredClone: structuredClone,
    clone: structuredClone,
    $: () => null,
    offerJournalUndo: (_label, restore) => {
      box.restore = restore;
    },
    journalWrite: async rows => {
      for (const [c, k, v] of rows) {
        if (v === undefined) {
          delete S[c][k];
        } else {
          S[c][k] = structuredClone(v);
        }
      }
    }
  });
  const api = vm.runInContext(source('memo.js') + ';({memoBlank,memoState,memoFlush,memoDelete})', box);
  const d = api.memoBlank('example');
  api.memoState.doc = d;
  api.memoState.dirty = true;
  await api.memoFlush();
  assert.deepEqual(S.meta, {});
  d.text = '书单\n去图书馆';
  api.memoState.dirty = true;
  await api.memoFlush();
  const saved = plain(S.meta['memo:example']);
  assert.deepEqual(saved.items, []);
  assert.equal(saved.due, null);
  assert.equal(saved.remind, null);
  await api.memoDelete();
  assert.equal(S.meta['memo:example'], undefined);
  await box.restore();
  assert.deepEqual(plain(S.meta['memo:example']), saved);
});

test('live timer contributes only today’s elapsed unoccupied minutes to category and plan',()=>{
 const live=core.tlLiveSlice({cat:'s',startISO:new Date(2026,10,19,23,30).toISOString(),planId:'p'},'2026-11-20',new Date(2026,10,20,1,0));
 const s=core.tlSummary({tl:[{start:'00:00',end:'00:10',cat:'x'}],plan:[{id:'p',cat:'s',start:'08:00',end:'10:00'}]},60,live);
 assert.equal(s.categories.get('s'),50);assert.equal(s.byPlan.get('p'),50);assert.ok(s.activePlans.has('p'));assert.equal(s.unrecorded,0);
});
test('overrun retains actual duration but caps both displayed rate and credited total per plan',()=>{
 const p={id:'p',cat:'s',start:'09:00',end:'11:00'},s=core.tlSummary({plan:[p,{id:'q',cat:'x',start:'15:00',end:'17:00'}],tl:[{cat:'s',planId:'p',start:'09:00',end:'12:00'}]});
 const fmt=vm.runInContext(source('timeline.js').split('function tlPlanLine')[1].split('function tlMaterials')[0].replace(/^/,'(function tlPlanLine')+')',box);
 box.S={meta:{}};assert.match(fmt(p,s),/3 小时（100%，超出 1 小时）/);assert.equal(s.completed,120);
});
