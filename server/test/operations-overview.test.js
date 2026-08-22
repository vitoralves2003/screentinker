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
db.prepare("INSERT INTO organizations (id,name,owner_user_id,plan_id) VALUES ('o1','Org','u1','premium')").run();
db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('w1','o1','WS-A')").run();
// A SECOND workspace in the same organisation. This is the whole reason storage is summed by org.
db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('w2','o1','WS-B')").run();

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

test('storage is the ORGANISATION\'s, not the workspace\'s', async () => {
  /*
   * The quota belongs to the plan, and the plan belongs to the organisation. Counting per
   * workspace would let a customer with two workspaces use the full quota twice — and the number
   * shown here would then disagree with the limit checkStorageLimit enforces.
   */
  db.prepare("INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type,file_size) VALUES ('c1','u1','w1','a.mp4','/x','video/mp4',100)").run();
  db.prepare("INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type,file_size) VALUES ('c2','u1','w2','b.mp4','/y','video/mp4',400)").run();

  const a = await get('w1');
  const b = await get('w2');
  assert.equal(a.body.storage.used_bytes, 500, 'both workspaces of the org count toward the same quota');
  assert.equal(a.body.storage.used_bytes, b.body.storage.used_bytes,
    'and each workspace sees the same total, because the contract is one');

  // The library counts, by contrast, ARE per workspace: that is what this operator manages.
  assert.equal(a.body.library.files, 1);
});

test('an unlimited plan is passed through as -1, not turned into a number', async () => {
  /*
   * -1 is the plan's own way of saying unlimited. Resolving it here into some large figure would
   * make the page draw a progress bar against a fiction; passing it through lets the page say
   * "sem limite" instead.
   */
  db.prepare("UPDATE organizations SET plan_id = 'enterprise' WHERE id = 'o1'").run();
  const { body } = await get('w1');
  assert.equal(body.storage.limit_mb, -1);
  assert.equal(body.storage.plan, 'Enterprise');
  db.prepare("UPDATE organizations SET plan_id = 'premium' WHERE id = 'o1'").run();
});

test('no workspace context is refused rather than answered with everyone\'s numbers', async () => {
  const res = await get(null);
  assert.equal(res.status, 403);
});

test('cleanup', () => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
