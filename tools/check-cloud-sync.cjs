// Synthetic accounts, separate Chrome profiles and a fresh local D1 database on every run.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');

const {randomBytes: randomBytes, randomUUID: randomUUID, createHash: createHash} = require('node:crypto');

const {spawn: spawn, execFileSync: execFileSync} = require('node:child_process'), {DatabaseSync: DatabaseSync} = require('node:sqlite');

const assert = require('node:assert/strict'), {chromium: chromium} = require(process.env.PLAYWRIGHT_PATH || 'playwright');

const root = path.resolve(__dirname, '..'), dir = path.join(root, '.wrangler', 'sync-qa', randomUUID());

const out = process.env.QA_OUTPUT || os.tmpdir(), port = Number(process.env.QA_PORT || 8873), origin = 'http://127.0.0.1:' + port;

const conf = path.join(dir, 'wrangler.json'), persist = path.join(dir, 'db'), cli = process.env.WRANGLER_JS;

const secret = () => randomBytes(24).toString('base64url'), password = secret(), ownerPass = secret(), nextPass = secret(), firstInvite = secret();

const opts = {
  cwd: dir,
  windowsHide: true,
  stdio: 'ignore',
  env: {
    ...process.env,
    WRANGLER_SEND_METRICS: 'false',
    CI: 'true'
  }
};

const args = [ '--local', '--persist-to', persist, '--config', conf ];

const wr = (...a) => execFileSync(process.execPath, [ cli, ...a, ...args ], opts);

let worker, browser, sql, stage = 'boot';

const errors = [], metrics = {};

function at(name) {
  stage = name;
  console.log(name);
}

function findDb(dir) {
  for (const e of fs.readdirSync(dir, {
    withFileTypes: true
  })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) {
      const got = findDb(f);
      if (got) {
        return got;
      }
    } else if (f.endsWith('.sqlite')) {
      const d = new DatabaseSync(f, {
        readOnly: true
      });
      if (d.prepare('SELECT name FROM sqlite_schema WHERE name=\'history\'').get()) {
        return d;
      }
      d.close();
    }
  }
}

async function run() {
  fs.mkdirSync(dir, {
    recursive: true
  });
  fs.mkdirSync(out, {
    recursive: true
  });
  fs.writeFileSync(path.join(dir, '.dev.vars'), 'AUTH_PEPPER=' + secret() + secret());
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'wrangler.jsonc')));
  fs.writeFileSync(conf, JSON.stringify({
    name: 'journal-cloud-qa',
    compatibility_date: cfg.compatibility_date,
    main: path.join(root, 'worker/worker.mjs'),
    vars: {
      ALLOWED_ORIGIN: origin
    },
    assets: {
      directory: path.join(root, 'dist'),
      binding: 'ASSETS',
      run_worker_first: [ '/api/*' ]
    },
    ratelimits: cfg.ratelimits,
    d1_databases: [ {
      ...cfg.d1_databases[0],
      database_id: '00000000-0000-4000-8000-000000000006',
      migrations_dir: path.join(root, 'worker/migrations')
    } ]
  }));
  wr('d1', 'migrations', 'apply', 'VAULT');
  wr('d1', 'execute', 'VAULT', '--command', 'INSERT INTO invites(code_hash,id,created_at,expires_at) VALUES(X\'' + createHash('sha256').update(firstInvite).digest('hex') + '\',\'fixture\',0,' + (Date.now() + 36e5) + ')');
  worker = spawn(process.execPath, [ cli, 'dev', '--ip', '127.0.0.1', '--port', String(port), ...args ], opts);
  for (let i = 0; i < 90; i++) {
    try {
      if ((await fetch(origin + '/api/auth/me')).status === 401) {
        break;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 350));
  }
  sql = findDb(persist);
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH
  });
  const page = async () => {
    const c = await browser.newContext({
      viewport: {
        width: 390,
        height: 844
      },
      serviceWorkers: 'block'
    }), p = await c.newPage();
    p.setDefaultTimeout(12e3);
    p.on('response', r => {
      if (r.status() >= 400 && new URL(r.url()).pathname.startsWith('/api/sync/')) {
        console.log('sync response', stage, r.status());
      }
    });
    p.on('pageerror', e => {
      errors.push(e.name);
      console.log('pageerror', stage, e.name, e.message.slice(0, 100));
    });
    await p.goto(origin + '/#settings');
    await p.locator('#account-card').waitFor();
    return p;
  };
  const act = (p, a) => p.locator('[data-account="' + a + '"]').first(), fill = (p, id, v) => p.locator('#ac-' + id).fill(v);
  async function register(p, u, pw, invite) {
    await act(p, 'register').click();
    for (const [k, v] of Object.entries({
      invite: invite,
      user: u,
      pass: pw,
      confirm: pw
    })) {
      await fill(p, k, v);
    }
    await act(p, 'submit').click();
    await p.locator('#ac-ack').check();
    await act(p, 'ack').click();
    await act(p, 'logout').waitFor();
  }
  async function login(p, u, pw) {
    await act(p, 'login').click();
    await fill(p, 'user', u);
    await fill(p, 'pass', pw);
    await act(p, 'submit').click();
    await act(p, 'logout').waitFor();
  }
  const call = (p, route, data) => p.evaluate(async ({route: route, data: data}) => {
    const r = await fetch('/api/' + route, {
      method: data ? 'POST' : 'GET',
      headers: {
        'content-type': 'application/json'
      },
      body: data ? JSON.stringify(data) : undefined
    });
    return {
      status: r.status,
      json: await r.json()
    };
  }, {
    route: route,
    data: data
  });
  async function imp(p, file) {
    await p.locator('#importFile').setInputFiles({
      name: 'synthetic.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(file))
    });
    await p.waitForFunction(() => document.querySelector('#toast')?.textContent.startsWith('导入了'));
  }
  async function exp(p) {
    const dl = p.waitForEvent('download');
    await p.locator('[data-act=export]').click();
    return JSON.parse(fs.readFileSync(await (await dl).path()));
  }
  const status = (p, msg) => p.locator('#vault-card [role=status]').filter({
    hasText: msg
  }).waitFor({
    timeout: 18e4
  });
  async function sync(p) {
    await p.locator('[data-vault=sync]').click();
    try {
      await status(p, '同步完成');
    } catch (e) {
      console.error('sync status:', await p.locator('#vault-card [role=status]').textContent());
      throw e;
    }
  }
  const shot = async (p, sel, file) => {
    await p.locator(sel).evaluate(el => el.scrollIntoView({
      block: 'center',
      behavior: 'instant'
    }));
    await p.screenshot({
      path: path.join(out, file + '.png'),
      animations: 'disabled'
    });
  };
  const owner = await page(), a = await page(), b = await page();
  at('register owner and prepare anonymous journal');
  await register(owner, 'owner', ownerPass, firstInvite);
  wr('d1', 'execute', 'VAULT', '--command', 'UPDATE users SET role=\'admin\' WHERE username=\'owner\'');
  await owner.reload();
  const invitation = (await call(owner, 'admin/invite', {})).json.code;
  const memo = (id, text) => ({
    id: id,
    text: text,
    created: (new Date).toISOString(),
    updated: (new Date).toISOString(),
    pinned: false,
    items: [],
    due: null,
    remind: null
  });
  await imp(a, {
    days: {
      '2026-11-20': {
        date: '2026-11-20',
        caps: [],
        preds: [],
        tl: [ {
          id: 'a',
          start: '12:00',
          end: '12:30',
          cat: 'c3',
          label: '午餐',
          src: 'manual'
        } ]
      }
    },
    meta: {
      'memo:hello': memo('hello', '云端验收样例'),
      'chat:fixture': {
        id: 'fixture',
        title: '虚构聊天',
        messages: [ {
          role: 'user',
          content: '虚构记录'
        } ],
        cards: {}
      }
    }
  });
  await a.evaluate(() => localStorage.setItem('zwgcb-drafts-v1', JSON.stringify({
    fixture: {
      text: '只在本机的草稿'
    }
  })));
  at('claim and first-device verification');
  await register(a, 'reader', password, invitation);
  await a.locator('#vault-claim').waitFor();
  await shot(a, '#vault-claim', '01-claim');
  await a.locator('#claim-yes').click();
  await a.locator('#vault-claim').waitFor({
    state: 'hidden'
  });
  await sync(a);
  await shot(a, '#vault-card', '02-synced');
  await login(b, 'reader', password);
  await sync(b);
  let data = await exp(b);
  assert.equal(data.meta['memo:hello'].text, '云端验收样例');
  assert.equal(data.days['2026-11-20'].tl.length, 1);
  assert.equal(data.meta['chat:fixture'].id, 'fixture');
  assert.ok(await a.evaluate(() => Object.keys(localStorage).some(k => k.startsWith('zwgcb-drafts-v1:') && localStorage.getItem(k).includes('只在本机的草稿'))));
  const uid = (await call(a, 'auth/me')).json.user.id;
  const ownerId = (await call(owner, 'auth/me')).json.user.id;
  at('two offline devices and same-document conflict');
  await a.context().setOffline(true);
  await b.context().setOffline(true);
  await imp(a, {
    days: {},
    meta: {
      'memo:a': memo('a', '离线甲')
    }
  });
  await imp(b, {
    days: {},
    meta: {
      'memo:b': memo('b', '离线乙')
    }
  });
  async function editMemo(p, text) {
    await p.evaluate(() => location.hash = '#memo?id=hello');
    await p.locator('#memo-text').fill(text);
    await p.waitForFunction(() => document.querySelector('#memo-status')?.textContent === '已保存');
    await p.evaluate(() => location.hash = '#settings');
    await p.locator('#vault-card').waitFor();
  }
  await editMemo(a, '先写的虚构内容');
  await editMemo(b, '后写的虚构内容');
  await a.context().setOffline(false);
  await sync(a);
  await b.context().setOffline(false);
  await sync(b);
  await sync(a);
  data = await exp(a);
  assert.equal(data.meta['memo:hello'].text, '后写的虚构内容');
  assert.ok(data.meta['memo:a'] && data.meta['memo:b']);
  assert.ok(sql.prepare('SELECT COUNT(*) AS n FROM history WHERE user_id=?').get(uid).n >= 1);
  await a.evaluate(() => location.hash = '#memo?id=a');
  await a.locator('[data-act=memoMenu]').click();
  await a.locator('[data-act=memoDelete]').click();
  await a.locator('#memo-search').waitFor();
  await a.evaluate(() => location.hash = '#settings');
  await sync(a);
  await sync(b);
  assert.equal((await exp(b)).meta['memo:a'], undefined);
  at('quota, owner scope, ciphertext, backup');
  await call(owner, 'admin/user', {
    id: uid,
    action: 'quota',
    bytes: 1
  });
  await imp(a, {
    days: {},
    meta: {
      'memo:quota': memo('quota', '配额满仍能本机记录')
    }
  });
  await a.locator('[data-vault=sync]').click();
  await status(a, '云端空间已满');
  await shot(a, '#vault-card', '03-quota');
  assert.ok((await exp(a)).meta['memo:quota']);
  await call(owner, 'admin/user', {
    id: uid,
    action: 'quota',
    bytes: 52428800
  });
  await sync(a);
  const isolated = (await call(a, 'sync/pull?since=0&user_id=' + ownerId)).json.docs;
  assert.ok(isolated.length > 0);
  assert.equal((await call(owner, 'sync/pull?since=0&user_id=' + uid)).json.docs.length, 0);
  const rows = sql.prepare('SELECT k,body FROM docs WHERE user_id=? AND deleted=0').all(uid);
  assert.ok(rows.every(r => /^[\w-]{43}$/.test(r.k) && !Buffer.from(r.body).includes(Buffer.from('虚构'))));
  const down = a.waitForEvent('download');
  await a.locator('[data-vault=backup]').click();
  const backup = JSON.parse(fs.readFileSync(await (await down).path()));
  assert.ok(backup.history.length >= 1);
  metrics.backupHistory = backup.history.length;
  assert.equal(backup.docs.length, (await call(a, 'sync/pull?since=0')).json.docs.length);
  await act(owner, 'manage').click();
  await owner.getByText('数据库总量', {
    exact: true
  }).waitFor();
  await shot(owner, '#account-card', '04-admin');
  assert.ok(!(await owner.locator('#account-card').innerText()).includes('虚构'));
  at('password rotation and paused device');
  await act(a, 'password').click();
  await fill(a, 'old', password);
  await fill(a, 'pass', nextPass);
  await fill(a, 'confirm', nextPass);
  await act(a, 'submit').click();
  await a.getByText(/密码已更新/).waitFor();
  assert.equal((await call(b, 'sync/pull')).status, 401);
  const beforeWrong = sql.prepare('SELECT seq FROM users WHERE id=?').get(uid).seq;
  await b.reload();
  await act(b, 'login').click();
  await fill(b, 'user', 'reader');
  await fill(b, 'pass', password);
  await act(b, 'submit').click();
  await b.locator('#ac-note').filter({
    hasText: '不正确'
  }).waitFor();
  assert.equal(sql.prepare('SELECT seq FROM users WHERE id=?').get(uid).seq, beforeWrong);
  await fill(b, 'pass', nextPass);
  await act(b, 'submit').click();
  await act(b, 'logout').waitFor();
  await sync(b);
  assert.equal((await exp(b)).meta['memo:hello'].text, '后写的虚构内容');
  await b.locator('[data-vault=stop]').click();
  await b.locator('[data-vault=enable]').click();
  await b.locator('#vault-password').fill(nextPass);
  await b.locator('[data-vault=unlock]').click();
  await status(b, '同步完成');
  at('deferred legacy claim and expired copies');
  const logout = async p => {
    await act(p, 'logout').click();
    await act(p, 'keep').click();
    await act(p, 'login').waitFor();
  };
  const legacy = await page();
  await legacy.evaluate(m => localStorage.setItem('zwgcb-data-v1', JSON.stringify({
    days: {},
    meta: {
      'memo:legacy': m
    }
  })), memo('legacy', '旧存储样例'));
  await legacy.reload();
  await login(legacy, 'reader', nextPass);
  await legacy.locator('#claim-no').click();
  await logout(legacy);
  assert.equal((await exp(legacy)).meta['memo:legacy'].text, '旧存储样例');
  await login(legacy, 'reader', nextPass);
  await legacy.locator('#claim-yes').click();
  await legacy.locator('#vault-claim').waitFor({
    state: 'hidden'
  });
  await sync(legacy);
  await logout(legacy);
  await login(legacy, 'owner', ownerPass);
  await sync(legacy);
  assert.equal(await legacy.locator('#vault-claim').count(), 0);
  assert.equal((await exp(legacy)).meta['memo:legacy'], undefined);
  await logout(legacy);
  await imp(legacy, {
    days: {},
    meta: {
      'memo:later': memo('later', '认领后新增')
    }
  });
  await legacy.evaluate(() => new Promise((ok, no) => {
    const q = indexedDB.open('zwgcb');
    q.onsuccess = () => {
      const db = q.result, t = db.transaction('control', 'readwrite'), store = t.objectStore('control'), v = store.get('anonymousClaim');
      v.onsuccess = () => store.put({
        ...v.result,
        until: 0
      }, 'anonymousClaim');
      t.oncomplete = () => {
        db.close();
        ok();
      };
      t.onerror = () => no(t.error);
    };
  }));
  await legacy.reload();
  await legacy.waitForFunction(() => new Promise(ok => {
    const q = indexedDB.open('zwgcb');
    q.onsuccess = () => {
      const db = q.result, t = db.transaction('control'), v = t.objectStore('control').get('anonymousClaim');
      v.onsuccess = () => {
        db.close();
        ok(v.result?.cleaned);
      };
    };
  }));
  await legacy.reload();
  const remaining = await exp(legacy);
  assert.ok(remaining.meta['memo:later']);
  assert.equal(remaining.meta['memo:legacy'], undefined);
  at('capacity: 3000 documents incl. 10 MiB synthetic chat content');
  const bulk = {
    days: {},
    meta: {}
  };
  for (let i = 0; i < 2990; i++) {
    bulk.meta['memo:bulk' + i] = memo('bulk' + i, '容量样本 ' + i);
  }
  for (let i = 0; i < 10; i++) {
    bulk.meta['chat:bulk' + i] = {
      id: 'bulk' + i,
      title: '容量样例',
      cards: {},
      messages: [ {
        role: 'user',
        content: randomBytes(786432).toString('base64')
      } ]
    };
  }
  const bench = await page(), benchPass = secret(), benchInvite = (await call(owner, 'admin/invite', {})).json.code;
  await register(bench, 'capacity', benchPass, benchInvite);
  await sync(bench);
  const benchId = (await call(bench, 'auth/me')).json.user.id;
  await bench.context().setOffline(true);
  await imp(bench, bulk);
  const start = performance.now();
  await bench.context().setOffline(false);
  await sync(bench);
  metrics.uploadSeconds = +((performance.now() - start) / 1e3).toFixed(2);
  at('capacity download');
  const fresh = await page();
  const loadStart = performance.now();
  await login(fresh, 'capacity', benchPass);
  await sync(fresh);
  metrics.restoreSeconds = +((performance.now() - loadStart) / 1e3).toFixed(2);
  const restored = await exp(fresh);
  for (const [k, v] of Object.entries(bulk.meta)) {
    const got = restored.meta[k];
    assert.ok(got, k);
    if (k.startsWith('chat:')) {
      assert.equal(got.messages[0].content, v.messages[0].content);
    } else {
      assert.equal(got.text, v.text);
    }
  }
  at('incremental upload + restore');
  const inc = performance.now();
  await imp(bench, {
    days: {},
    meta: {
      'memo:delta': memo('delta', '一次增量')
    }
  });
  await sync(bench);
  await sync(fresh);
  metrics.deltaSeconds = +((performance.now() - inc) / 1e3).toFixed(2);
  assert.ok((await exp(fresh)).meta['memo:delta']);
  await shot(fresh, '#vault-card', '05-capacity');
  metrics.bulkDocuments = 3e3;
  metrics.chatBytes = 10485760;
  metrics.cloud = sql.prepare('SELECT sync_count AS docs,sync_bytes AS ciphertextBytes FROM users WHERE id=?').get(benchId);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'metrics.json'), JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify(metrics));
}

run().catch(e => {
  console.error('FAIL', stage, e.name, (e.message || '').slice(0, 400), (e.stack || '').split('\n').filter(x => x.includes('check-cloud-sync.cjs:')).slice(0, 2).join(' '));
  process.exitCode = 1;
}).finally(async () => {
  sql?.close();
  await (browser?.close());
  worker?.kill();
});
