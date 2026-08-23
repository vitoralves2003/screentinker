'use strict';

/*
 * The library listing has to actually carry the clock, over HTTP, the way the panel asks for it.
 *
 * lib/schedule-state.js decides the state and has its own tests; this checks the part between
 * that and the screen — that the listing stamps every row, that it does so with ONE query rather
 * than one per file, and that a timezone from the query string cannot take the page down.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sstate-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';

const express = require('express');
const { db } = require('../db/database');

const USER = 'u-state';
const UUID = () => crypto.randomUUID();
let server, base;

function mkContent(id, filename) {
  db.prepare("INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type) VALUES (?, ?, 'ws-state', ?, ?, 'video/mp4')")
    .run(id, USER, filename, id + '.mp4');
}

function setRules(contentId, rules) {
  const ins = db.prepare('INSERT INTO content_schedule_rules (id,content_id,type,params,sort_order) VALUES (?,?,?,?,?)');
  rules.forEach((r, i) => {
    const { type, ...params } = r;
    ins.run(UUID(), contentId, type, JSON.stringify(params), i);
  });
}

const get = async (p) => {
  const res = await fetch(base + p);
  return { status: res.status, json: await res.json().catch(() => null) };
};

before(async () => {
  db.prepare("INSERT INTO users (id, email, password_hash, plan_id) VALUES (?, ?, 'x', 'free')").run(USER, USER + '@t.local');
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-state', 'Org', ?)").run(USER);
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-state', 'org-state', 'WS')").run();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.workspaceId = 'ws-state'; req.user = { id: USER, role: 'platform_admin' }; next(); });
  app.use('/content', require('../routes/content'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

test('every row carries a schedule_state, and an unscheduled file carries none', async () => {
  const plain = UUID(), scheduled = UUID();
  mkContent(plain, 'sempre.mp4');
  mkContent(scheduled, 'natal.mp4');
  setRules(scheduled, [{ type: 'datetime_range', from: '2020-12-01T00:00', to: '2020-12-24T23:59' }]);

  const res = await get('/content?tz=America/Sao_Paulo');
  assert.equal(res.status, 200);
  const byId = Object.fromEntries(res.json.map((r) => [r.id, r]));

  assert.ok('schedule_state' in byId[plain], 'the field must be present even when empty');
  assert.equal(byId[plain].schedule_state, null, 'no schedule means no clock');
  assert.equal(byId[scheduled].schedule_state, 'expired', 'a 2020 campaign is over');
});

test('a timezone the runtime does not know degrades instead of taking the page down', async () => {
  /*
   * The query string is caller-controlled and Intl.DateTimeFormat THROWS on an unknown zone, deep
   * inside the evaluator with nothing catching it — so this would have been a 500 on the whole
   * library, not one wrong badge. A pattern match would not be enough: "Foo/Bar" is well formed
   * and still not a zone.
   */
  for (const tz of ['Foo/Bar', 'not a zone', '../../etc', 'A'.repeat(200)]) {
    const res = await get('/content?tz=' + encodeURIComponent(tz));
    assert.equal(res.status, 200, `tz=${tz} must not break the listing`);
    assert.ok(Array.isArray(res.json));
  }
});

test('the listing reads the rules in one query, not one per file', async () => {
  /*
   * A per-row lookup is invisible on a library of twelve and makes the page unusable on a library
   * of five hundred, which is the size at which nobody is willing to wait for a fix.
   */
  const ids = [];
  for (let i = 0; i < 40; i++) {
    const id = UUID();
    ids.push(id);
    mkContent(id, `f${i}.mp4`);
    setRules(id, [{ type: 'weekday', day: i % 7 }]);
  }

  /*
   * Counting EXECUTIONS, not prepares. Counting prepares would be satisfied by hoisting the
   * statement to module scope and still calling it once per row — which is the same N+1 with the
   * evidence hidden.
   */
  const realPrepare = db.prepare.bind(db);
  let ruleReads = 0;
  db.prepare = (sql) => {
    const stmt = realPrepare(sql);
    if (!/FROM content_schedule_rules/.test(sql)) return stmt;
    const realAll = stmt.all.bind(stmt);
    stmt.all = (...args) => { ruleReads++; return realAll(...args); };
    return stmt;
  };
  try {
    const res = await get('/content?tz=UTC');
    assert.equal(res.status, 200);
    assert.ok(res.json.length >= 40, 'the page must actually contain the rows');
    assert.equal(ruleReads, 1, `expected one rules read for the whole page, saw ${ruleReads}`);
  } finally {
    db.prepare = realPrepare;
  }
});

test('the timezone actually changes the answer', async () => {
  /*
   * If the parameter were ignored, every test above would still pass while the badge was wrong
   * for three hours a day in Brazil. This pins that it reaches the evaluator.
   *
   * A HALF-DAY window across the whole offset range, which makes the result independent of when
   * the suite runs. The first version used a three-hour window and three zones, and passed or
   * failed depending on the hour — at 04:00 UTC all three agreed and the assertion had nothing to
   * catch. Local times from UTC-11 to UTC+14 span 25 hours, so with a 00:00-12:00 window some zone
   * is always inside it and some always outside.
   */
  const id = UUID();
  mkContent(id, 'horario.mp4');
  setRules(id, [{ type: 'time_range', start: '00:00', end: '12:00' }]);

  const zones = ['Pacific/Midway', 'America/Los_Angeles', 'America/Sao_Paulo', 'UTC',
    'Europe/Moscow', 'Asia/Karachi', 'Asia/Shanghai', 'Pacific/Kiritimati'];
  const states = new Set();
  for (const tz of zones) {
    const rows = (await get('/content?tz=' + encodeURIComponent(tz))).json;
    states.add(rows.find((r) => r.id === id).schedule_state);
  }
  assert.ok(states.has('active'), `some zone must be inside the window, got ${[...states].join(',')}`);
  assert.ok(states.has('pending'), `and some outside it, got ${[...states].join(',')}`);
});
