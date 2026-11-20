// Local-only, synthetic journal. Run after build:page with PLAYWRIGHT_PATH and CHROME_PATH.
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');

const {chromium: chromium} = require(process.env.PLAYWRIGHT_PATH || 'playwright');

const out = process.env.QA_OUTPUT || require('node:os').tmpdir();

const pageHTML = fs.readFileSync(path.join(__dirname, '../index.html'));

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/auth/me')) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      user: {
        id: 'demo',
        role: 'admin',
        username: 'demo',
        nickname: '演示'
      }
    }));
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(pageHTML);
});

const date = '2026-11-20', tomorrow = '2026-11-21', at = date + 'T10:45:00+08:00';

const row = (id, start, end, cat, label, src = 'manual') => ({
  id: id,
  start: start,
  end: end,
  cat: cat,
  label: label,
  src: src
});

const day = {
  date: date,
  caps: [],
  preds: [],
  plan: [ row('p1', '09:00', '11:00', 'c1', '写实验报告'), row('p2', '11:20', '12:00', 'c2', '沿河步行') ],
  tl: [ row('a1', '09:10', '10:10', 'c1', '整理实验数据'), row('a2', '10:25', '10:45', 'c1', '写引言') ]
};

const chat = {
  id: 'demo-chat',
  title: '安排周六',
  created: at,
  updated: at,
  cards: {},
  messages: [ {
    role: 'user',
    content: '帮我排一下明天的学习和散步。',
    at: at
  }, {
    role: 'assistant',
    content: '上午写报告，午饭后再出门。\n<plan date="' + tomorrow + '">\n09:00-10:30 学习 写实验报告\n14:00-14:40 运动 沿河散步\n</plan>',
    at: at
  } ]
};

const memo = (id, text, pinned = false) => ({
  id: id,
  text: text,
  pinned: pinned,
  created: at,
  updated: at,
  items: [],
  due: null,
  remind: null
});

const seed = {
  days: {
    [date]: day
  },
  meta: {
    'chat:demo-chat': chat,
    'memo:books': memo('books', '周末书单\n去图书馆看看建筑与城市。'),
    'memo:walk': memo('walk', '散步时想到的\n下次沿河走到桥头。')
  }
};

const names = {
  empty: '时序空状态',
  timer: '正在计时',
  day: '计划与实际',
  gap: '空档补记',
  edit: '编辑时段',
  overlap: '重叠提示',
  summary: '当天小结',
  nav: '底部导航',
  plan: '聊天计划',
  added: '已加入计划',
  review: '今天的时间',
  list: '备忘录列表',
  search: '搜索全文',
  memo: '编辑备忘',
  pinned: '置顶备忘',
  undo: '删除后撤销'
};

let browser, stage;

async function run() {
  fs.mkdirSync(out, {
    recursive: true
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  for (const width of [ 360, 390 ]) {
    const context = await browser.newContext({
      viewport: {
        width: width,
        height: 800
      },
      timezoneId: 'Asia/Shanghai',
      locale: 'zh-CN',
      serviceWorkers: 'block',
      reducedMotion: 'reduce'
    });
    const p = await context.newPage(), errors = [];
    p.on('pageerror', e => {
      errors.push(e.message);
      console.error('page error', e.message);
    });
    await p.clock.setFixedTime(new Date(at));
    p.setDefaultTimeout(6500);
    const go = async hash => {
      await p.goto(origin + '/' + hash);
      await p.locator('#view[data-view]').waitFor({
        state: 'attached'
      });
    };
    const act = a => p.locator('[data-act="' + a + '"]:visible').first(), tap = async a => act(a).click(), snap = async n => {
      stage = n;
      await p.screenshot({
        path: path.join(out, width + '-' + n + '.png'),
        animations: 'disabled'
      });
    };
    const load = async data => {
      await go('#settings');
      await p.locator('#importFile').setInputFiles({
        name: 'synthetic.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(data))
      });
      await p.waitForFunction(() => document.querySelector('#toast').textContent.startsWith('导入了'));
      await p.locator('#toast').waitFor({
        state: 'hidden'
      });
    };
    const exp = async () => {
      await go('#settings');
      const promise = p.waitForEvent('download');
      await tap('export');
      return JSON.parse(fs.readFileSync(await (await promise).path()));
    };
    stage = 'empty';
    await go('#tl');
    await p.locator('#tl-now').waitFor();
    await snap('empty');
    const bounds = await p.locator('.tabs a:visible').evaluateAll(els => els.map(e => [ e.textContent.trim(), e.getBoundingClientRect().width, e.getBoundingClientRect().height ]));
    assert.equal(bounds.length, 7);
    assert.ok(bounds.every(x => Math.min(x[1], x[2]) >= 48), JSON.stringify(bounds));
    console.log(width, 'nav', JSON.stringify(bounds));
    await snap('nav');
    await tap('tlStart');
    await p.locator('.tl-elapsed').waitFor();
    await p.clock.setFixedTime(new Date(date + 'T11:10:00+08:00'));
    await p.reload();
    await p.getByText('25 分', {
      exact: true
    }).waitFor();
    await snap('timer');
    await p.clock.setFixedTime(new Date(at));
    await p.reload();
    await p.locator('.tl-elapsed').waitFor();
    await tap('tlStop');
    await tap('tlNew');
    await tap('jClose');
    await load(seed);
    await go('#tl?date=' + date);
    await p.locator('.tl-board').evaluate(el => el.scrollIntoView({
      block: 'start',
      behavior: 'instant'
    }));
    await snap('day');
    const gap = p.locator('.tl-gap[data-start="10:10"]');
    await gap.click();
    assert.equal(await p.locator('#tl-end').inputValue(), '10:25');
    await snap('gap');
    await tap('jClose');
    await p.locator('.tl-row-main[data-id="a2"]').click();
    await snap('edit');
    await p.locator('#tl-start').fill('10:00');
    await tap('tlSave');
    await p.getByText('实际时段重叠', {
      exact: true
    }).waitFor();
    await snap('overlap');
    await tap('jClose');
    await p.locator('#tl-summary').scrollIntoViewIfNeeded();
    assert.match(await p.locator('#tl-summary').innerText(), /67%/);
    await snap('summary');
    await go('#review');
    await p.getByText('今天的时间', {
      exact: true
    }).scrollIntoViewIfNeeded();
    await snap('review');
    await go('#chat?id=demo-chat');
    await act('planAdd').scrollIntoViewIfNeeded();
    await snap('plan');
    await tap('planAdd');
    const added = p.getByRole('link', {
      name: /已加到/
    });
    await added.waitFor();
    await snap('added');
    await added.click();
    await p.locator('.tl-block.plan').first().waitFor();
    assert.equal(await p.locator('.tl-block.plan a').count(), 2);
    await go('#more');
    await p.locator('#memo-entry a').click();
    await p.locator('#memo-search').waitFor();
    await snap('list');
    await p.locator('#memo-search').fill('桥头');
    assert.equal(await p.locator('.memo-item').count(), 1);
    await snap('search');
    await p.locator('#memo-search').fill('');
    await tap('memoNew');
    const editor = p.locator('#memo-text');
    await editor.fill('周五的灵感\n把散步时想到的细节写在这里。');
    await p.waitForFunction(() => document.querySelector('#memo-status')?.textContent === '已保存');
    await snap('memo');
    await tap('memoMenu');
    await tap('memoPin');
    await p.locator('.memo-head a').click();
    await p.locator('.memo-item small').waitFor();
    assert.match(await p.locator('.memo-item').first().innerText(), /周五的灵感/);
    await snap('pinned');
    await p.locator('.memo-item').first().click();
    await tap('memoMenu');
    await tap('memoDelete');
    await p.getByText('已删除备忘', {
      exact: true
    }).waitFor();
    await snap('undo');
    await tap('undoCap');
    await p.getByText('周五的灵感', {
      exact: false
    }).first().waitFor();
    await tap('memoNew');
    await editor.fill('离开时保存\n尚未到一秒');
    await p.locator('.memo-head a').click();
    await p.getByText('离开时保存', {
      exact: true
    }).waitFor();
    await tap('memoNew');
    await editor.waitFor();
    await p.locator('.memo-head a').click();
    await go('#tl');
    await tap('tlCategories');
    await tap('tlCategoryEdit');
    await p.locator('#tl-name').fill('课程');
    await tap('tlCategorySave');
    await tap('jClose');
    // A second card for the same day exercises replace, reload/undo, append and the source link.
        const otherChat = {
      ...chat,
      id: 'replace-demo'
    };
    await load({
      days: {},
      meta: {
        'chat:replace-demo': otherChat
      }
    });
    await go('#chat?id=replace-demo');
    await tap('planAdd');
    await tap('planReplace');
    await p.reload();
    await tap('planUndo');
    await tap('planAdd');
    await tap('planAppend');
    await tap('planUndo');
    // Commit a crop, then use an explicit late finish to split a timer at local midnight.
        await go('#tl?date=' + date);
    await p.locator('.tl-row-main[data-id="a2"]').click();
    await p.locator('#tl-start').fill('10:00');
    await tap('tlSave');
    await tap('tlCrop');
    await tap('tlStart');
    await p.clock.setFixedTime(new Date('2026-11-21T07:00:00+08:00'));
    await p.reload();
    await tap('tlEndAt');
    await p.locator('#tl-end-at').fill('2026-11-21T07:00');
    await tap('tlEndAtSave');
    await p.locator('#journal-dialog').waitFor({
      state: 'hidden'
    });
    await go('#tl');
    await tap('tlStart');
    const exported = await exp();
    assert.ok(exported.meta.timer.startISO);
    assert.equal(exported.days[tomorrow].plan.length, 2);
    assert.ok(exported.days[tomorrow].plan.every(r => r.src.chatId === 'demo-chat'));
    assert.equal(exported.days[date].tl.find(x => x.id === 'a1').end, '10:00');
    assert.ok(exported.days[date].tl.some(x => x.end === '24:00'));
    assert.ok(exported.days[tomorrow].tl.some(x => x.start === '00:00' && x.end === '07:00'));
    assert.ok(Array.isArray(exported.meta.tlcats));
    assert.equal(exported.meta.tlcats[0].name, '课程');
    assert.equal(Object.keys(exported.meta).filter(k => k.startsWith('memo:')).length, 4);
    await context.close();
    const fresh = await browser.newContext({
      serviceWorkers: 'block'
    }), q = await fresh.newPage();
    await q.goto(origin + '/#settings');
    await q.locator('#importFile').setInputFiles({
      name: 'roundtrip.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(exported))
    });
    await q.waitForFunction(() => document.querySelector('#toast').textContent.startsWith('导入了'));
    const download = q.waitForEvent('download');
    await q.locator('[data-act=export]').click();
    const again = JSON.parse(fs.readFileSync(await (await download).path()));
    const normalize = x => JSON.parse(JSON.stringify(x, (k, v) => k === '_t' ? undefined : v));
    assert.deepEqual(normalize(again.days), normalize(exported.days));
    assert.deepEqual(normalize(again.meta), normalize(exported.meta));
    assert.deepEqual(errors, []);
    await fresh.close();
    console.log(width, 'roundtrip OK');
  }
  const captions = Object.entries(names).map(([key, name]) => '<section><h2>' + name + '</h2><div>' + [ 360, 390 ].map(w => '<figure><figcaption>' + w + ' px</figcaption><a href="' + w + '-' + key + '.png"><img loading="lazy" src="' + w + '-' + key + '.png"></a></figure>').join('') + '</div></section>').join('');
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>v6.15.0 手机验收</title><style>body{font:16px system-ui;margin:20px auto;max-width:860px;background:#eeeae1;color:#28382c}section>div{display:flex;gap:8px}h2{margin-top:40px}figure{margin:0;flex:1;min-width:0}img{width:100%;height:auto}figcaption{padding:6px}</style><h1>时序与备忘录 · v6.15.0</h1>' + captions);
}

run().catch(e => {
  console.error(stage, e.stack);
  process.exitCode = 1;
}).finally(async () => {
  await (browser?.close());
  server.close();
});
