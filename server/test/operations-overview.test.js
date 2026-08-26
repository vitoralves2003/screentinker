'use strict';

/*
 * The landing page's one request.
 *
 * Two questions an operator has before they have a task — "is anything down?" and "am I running
 * out of room?" — answered in a single call, because a page the app opens on must not fan out into
 * five requests before it shows a number, and counting the files must not mean fetching them.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';

const express = require('express');
const { db } = require('../db/database');

db.prepare("INSERT INTO users (id,email,password_hash,name,role) VALUES ('u1','a@b.c','x','A','admin')").run();
/*
 * organizations.plan_id is set to something DIFFERENT from the workspaces' on purpose. This page
 * used to read it, and that is how a customer saw "de 15,0 GB no plano Premium" while their
 * invoice charged Corporativo — the divergence is the fixture now.
 */
db.prepare("INSERT INTO organizations (id,name,owner_user_id,plan_id) VALUES ('o1','Org','u1','corporate')").run();
db.prepare("INSERT INTO workspaces (id,organization_id,name,plan_id) VALUES ('w1','o1','WS-A','premium')").run();
// A SECOND workspace under the same organisation row. Under the current model each workspace IS a
// tenant, so these are two customers who happen to share an ancestor record — and their storage
// must not pool.
db.prepare("INSERT INTO workspaces (id,organization_id,name,plan_id) VALUES ('w2','o1','WS-B','premium')").run();

function app(workspaceId) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.user = { id: 'u1', role: 'admin' }; req.workspaceId = workspaceId; next(); });
  a.use('/api/devices', require('../routes/devices'));
  return a;
}

async function get(workspaceId, url = '/api/devices/overview') {
  const server = app(workspaceId).listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${url}`);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  } finally { server.close(); }
}

test('the route resolves before /:id, or the landing page 404s', async () => {
  /*
   * Express matches in declaration order. With this below router.get('/:id'), a request for
   * /api/devices/overview is read as a device whose id is the word "overview" — 404 Device not
   * found, on the first page anyone sees. It was declared in the wrong place first; this is what
   * keeps it from drifting back.
   */
  const res = await get('w1');
  assert.equal(res.status, 200);
  assert.ok(res.body.screens, 'a device row would have no `screens` key');
});

test('screens are counted, provisioning ones excluded', async () => {
  db.prepare("INSERT INTO devices (id,name,workspace_id,status) VALUES ('d1','A','w1','online')").run();
  db.prepare("INSERT INTO devices (id,name,workspace_id,status) VALUES ('d2','B','w1','offline')").run();
  // Never paired: it is not a screen anybody operates, and counting it as offline would put a red
  // number on the landing page for a box still showing its pairing code.
  db.prepare("INSERT INTO devices (id,name,workspace_id,status) VALUES ('d3','C','w1','provisioning')").run();

  const { body } = await get('w1');
  assert.equal(body.screens.total, 2);
  assert.equal(body.screens.online + body.screens.offline, 2, 'every counted screen is one or the other');
});

test('online means the same thing here as in the list', async () => {
  /*
   * The count comes from heartbeat.livenessFor, not from devices.status. Reading the column would
   * be cheaper and would disagree with the list two clicks away: a screen mid-reconnect would be
   * online in the counter and offline in its row, leaving the operator to decide which page lies.
   *
   * In this test no socket exists, so live liveness is offline for everything — including the row
   * whose status column says 'online'. That is the correct answer and the point of the assertion.
   */
  const { body } = await get('w1');
  assert.equal(body.screens.online, 0);
  assert.equal(body.screens.offline, 2);
});

test('storage is the TENANT\'s, and the tenant is the workspace', async () => {
  /*
   * THIS ASSERTION USED TO SAY THE OPPOSITE, and the change is the point.
   *
   * Storage was summed across the organisation, because the plan was held to belong to the
   * organisation. It does not: workspaces.plan_id is what the invoice has always been computed
   * from, and every other screen in the product (the Assinatura tab included, via
   * getWorkspaceStorageMB) already counted per workspace. So the same customer was shown two
   * different "used" figures on two pages, and this page was the one disagreeing with the bill.
   */
  db.prepare("INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type,file_size) VALUES ('c1','u1','w1','a.mp4','/x','video/mp4',100)").run();
  db.prepare("INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type,file_size) VALUES ('c2','u1','w2','b.mp4','/y','video/mp4',400)").run();

  const a = await get('w1');
  const b = await get('w2');
  assert.equal(a.body.storage.used_bytes, 100, 'only this tenant\'s own files');
  assert.equal(b.body.storage.used_bytes, 400, 'and the neighbour\'s do not pool into it');

  assert.equal(a.body.library.files, 1);
});

test('the plan comes from the workspace, never from the organisation', async () => {
  /*
   * The visible half of the three-resolver bug. o1 is on Corporativo and w1 is on Premium; this
   * page must say Premium, because Premium is what w1 is gated and invoiced on.
   */
  const { body } = await get('w1');
  assert.equal(body.storage.plan, 'Premium');
  assert.equal(body.storage.limit_mb, 15360);
});

test('an unlimited plan is passed through as -1, not turned into a number', async () => {
  /*
   * -1 is the plan's own way of saying unlimited. Resolving it here into some large figure would
   * make the page draw a progress bar against a fiction; passing it through lets the page say
   * "sem limite" instead.
   */
  /*
   * The fixture is made here rather than borrowed from a shipped tier. This used to point at
   * 'enterprise', which is not a plan this product sells — it came from upstream, priced in USD —
   * and the day it was removed from the seed this test failed on a foreign-key error, describing a
   * storage bug that did not exist.
   *
   * What is under test is the -1 sentinel, not any particular tier, so the fixture says so.
   */
  db.prepare(`INSERT OR IGNORE INTO plans (id, name, display_name, max_devices, max_storage_mb)
              VALUES ('unlimited-test', 'unlimited-test', 'Ilimitado', -1, -1)`).run();

  db.prepare("UPDATE workspaces SET plan_id = 'unlimited-test' WHERE id = 'w1'").run();
  const { body } = await get('w1');
  assert.equal(body.storage.limit_mb, -1);
  assert.equal(body.storage.plan, 'Ilimitado');
  db.prepare("UPDATE workspaces SET plan_id = 'premium' WHERE id = 'w1'").run();
});

test('no workspace context is refused rather than answered with everyone\'s numbers', async () => {
  const res = await get(null);
  assert.equal(res.status, 403);
});

/*
 * NEEDS ATTENTION — the filter that decides whether an offline screen is news.
 *
 * A bakery that closes at 19:00 has its panel offline every night. Reporting that every night is
 * how a warning list becomes wallpaper, and the night the panel actually dies its warning sits
 * among twelve identical ones.
 */
test('an offline screen is listed only while its own hours say it should be open', async () => {
  const { v4: uuid } = require('uuid');
  db.exec("DELETE FROM device_hours; DELETE FROM devices;");
  db.prepare("INSERT INTO devices (id,name,workspace_id,status,timezone) VALUES ('open','Padaria','w1','offline','America/Sao_Paulo')").run();
  db.prepare("INSERT INTO devices (id,name,workspace_id,status,timezone) VALUES ('shut','Bar','w1','offline','America/Sao_Paulo')").run();
  db.prepare("INSERT INTO devices (id,name,workspace_id,status) VALUES ('unset','Sem horario','w1','offline')").run();

  const ins = db.prepare('INSERT INTO device_hours (id,device_id,active_days,start_time,end_time,sort_order) VALUES (?,?,?,?,?,0)');
  ins.run(uuid(), 'open', '0,1,2,3,4,5,6', '00:00', '24:00');   // always open -> offline is a fault

  /*
   * The shut window is computed from the clock, not hardcoded. A literal '03:00'-'04:00' passes
   * twenty-three hours a day and fails during the twenty-fourth — the kind of test that goes red
   * once, gets re-run, goes green, and teaches everyone to re-run instead of read.
   *
   * Six hours from now, one hour wide, never wraps past the end of the day.
   */
  const spNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const shutStart = (spNow.getHours() + 6) % 18;   // <=17, so shutStart+1 is still today
  const pad = (n) => String(n).padStart(2, '0');
  ins.run(uuid(), 'shut', '0,1,2,3,4,5,6', `${pad(shutStart)}:00`, `${pad(shutStart + 1)}:00`);

  const { body } = await get('w1');
  assert.equal(body.screens.offline, 3);
  assert.deepEqual(
    body.attention.filter((d) => d.kind === 'offline').map((d) => d.name), ['Padaria'],
    'the shut bar must not appear, or the list becomes wallpaper');

  /*
   * The unconfigured screen is COUNTED, not listed and not hidden. Guessing its hours from when it
   * usually drops would be right most of the time and would silence the one alert that mattered
   * the rest of it — so the page says how many are unconfigured and lets the operator decide.
   */
  assert.equal(body.hours_unconfigured, 1);
});

test('a screen that is fine and showing nothing is listed', () => {
  /*
   * THE BLIND SPOT THIS CLOSES. Everything else on this page asks whether a screen is REACHABLE,
   * so a screen with no playlist never qualified: it is online, it answers, its state reads
   * "saudável" — and the shop window is black. Nothing was broken, so nothing warned, and the
   * shopkeeper phones days later.
   */
  db.exec("DELETE FROM device_hours; DELETE FROM devices;");
  db.prepare("INSERT INTO devices (id,name,workspace_id,status) VALUES ('bare','Sem lista','w1','online')").run();

  return get('w1').then(({ body }) => {
    const gaps = body.attention.filter((d) => d.kind === 'no_playlist');
    assert.deepEqual(gaps.map((d) => d.name), ['Sem lista']);
  });
});

test('a zone meant for a widget is not reported as missing a list', () => {
  /*
   * The false alarm this avoids. A layout can reserve a zone for a clock or the weather; those
   * zones legitimately have no playlist. Warning about them would put a permanent entry in the
   * attention list, and a warning that never clears is a warning nobody reads.
   *
   * Settled by zone_type rather than by a guess — the schema already records which zones were
   * meant to carry content.
   */
  db.exec("DELETE FROM device_hours; DELETE FROM devices; DELETE FROM layout_zones; DELETE FROM layouts;");
  db.prepare("INSERT INTO layouts (id,user_id,workspace_id,name) VALUES ('lay','u1','w1','Split')").run();
  db.prepare("INSERT INTO layout_zones (id,layout_id,name,zone_type,sort_order) VALUES ('zc','lay','Principal','content',0)").run();
  db.prepare("INSERT INTO layout_zones (id,layout_id,name,zone_type,sort_order) VALUES ('zw','lay','Relógio','widget',1)").run();
  db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name) VALUES ('pl1','u1','w1','Geral')").run();
  db.prepare("INSERT INTO devices (id,name,workspace_id,status,layout_id) VALUES ('zoned','Com zonas','w1','online','lay')").run();
  // The content zone HAS its list; only the widget zone is listless.
  db.prepare("INSERT INTO device_zone_playlists (device_id,zone_id,playlist_id) VALUES ('zoned','zc','pl1')").run();

  return get('w1').then(({ body }) => {
    assert.deepEqual(body.attention, [], 'a zona de widget não é uma falta de lista');
  });
});

test('one dark zone among several is reported as such, not as a dead screen', () => {
  /*
   * The distinction matters to whoever reads the list: a screen with NO list is showing nothing at
   * all, while a screen with one empty zone is still working and partly blank. Same urgency, very
   * different sentence — and calling both "sem lista" would send someone looking for a black
   * screen that is not black.
   */
  db.prepare("INSERT INTO layout_zones (id,layout_id,name,zone_type,sort_order) VALUES ('zc2','lay','Rodapé','content',2)").run();

  return get('w1').then(({ body }) => {
    const [gap] = body.attention;
    assert.ok(gap, 'a zona vazia tem de aparecer');
    assert.equal(gap.kind, 'zone_without_list');
    assert.deepEqual(gap.zones, ['Rodapé'], 'e diz QUAL zona está sem lista');
  });
});

test('cleanup', () => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
