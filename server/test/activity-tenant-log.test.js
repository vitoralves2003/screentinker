'use strict';

/*
 * The tenant activity log.
 *
 * Two things can go wrong here and only one of them is visible. The obvious one is refusing
 * somebody who should see the log. The other is showing one customer another customer's activity —
 * every device paired, every file deleted, every member's name — and that failure looks exactly
 * like the feature working.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'act-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';

const express = require('express');
const { db } = require('../db/database');
const { logActivity } = require('../services/activity');

let server, base;
// Who the fake auth layer says is calling, and into which workspace.
let asUser = 'u-owner-a';
let asWorkspace = 'ws-a';

const get = async (p) => {
  const res = await fetch(base + p);
  return { status: res.status, json: await res.json().catch(() => null) };
};

before(async () => {
  const mkUser = (id, name) => db.prepare(
    "INSERT INTO users (id, email, password_hash, name, plan_id) VALUES (?,?, 'x', ?, 'free')"
  ).run(id, id + '@t.local', name);
  mkUser('u-owner-a', 'Dona A');
  mkUser('u-member-a', 'Membro A');
  mkUser('u-owner-b', 'Dono B');

  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-a', 'A', 'u-owner-a')").run();
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-b', 'B', 'u-owner-b')").run();
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-a', 'org-a', 'WS A')").run();
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-b', 'org-b', 'WS B')").run();
  db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES ('org-a', 'u-owner-a', 'org_owner')").run();
  db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES ('org-b', 'u-owner-b', 'org_owner')").run();
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-a', 'u-member-a', 'workspace_admin')").run();

  logActivity('u-owner-a', 'POST /api/content', 'a subiu um arquivo', null, '1.1.1.1', 'ws-a');
  logActivity('u-member-a', 'DELETE /api/content', 'membro apagou um arquivo', null, '1.1.1.1', 'ws-a');
  logActivity('u-owner-b', 'POST /api/content', 'SEGREDO DO OUTRO CLIENTE', null, '2.2.2.2', 'ws-b');
  // A row from before the column existed. It belongs to nobody, so it must reach nobody.
  db.prepare("INSERT INTO activity_log (user_id, action, details, workspace_id) VALUES ('u-owner-a', 'POST /api/legacy', 'linha antiga sem workspace', NULL)").run();

  const app = express();
  app.use(express.json());
  // Stands in for requireAuth + resolveTenancy, setting exactly the fields the route reads.
  app.use((req, _res, next) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(asUser);
    req.user = { id: user.id, role: user.role || 'user' };
    req.workspaceId = asWorkspace;
    const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(asWorkspace);
    req.organizationId = ws ? ws.organization_id : null;
    const om = ws && db.prepare('SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?')
      .get(ws.organization_id, asUser);
    req.orgRole = om ? om.role : null;
    req.isPlatformAdmin = req.user.role === 'platform_admin';
    next();
  });
  app.use('/activity', require('../routes/activity'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

test('the owner sees their own tenant, and every member in it', async () => {
  asUser = 'u-owner-a'; asWorkspace = 'ws-a';
  const res = await get('/activity');
  assert.equal(res.status, 200);
  const details = res.json.map((r) => r.details);
  assert.ok(details.includes('a subiu um arquivo'));
  assert.ok(details.includes('membro apagou um arquivo'), 'the log is about the team, not just the reader');
  assert.ok(res.json.some((r) => r.user_name === 'Membro A'), 'and it names them');
});

test('NOTHING from another tenant comes back', async () => {
  /*
   * The failure that looks like success. getActivity had no workspace filter at all, so this is
   * the assertion the whole change turns on.
   */
  asUser = 'u-owner-a'; asWorkspace = 'ws-a';
  const res = await get('/activity');
  for (const row of res.json) {
    assert.notEqual(row.details, 'SEGREDO DO OUTRO CLIENTE');
    assert.notEqual(row.user_name, 'Dono B');
  }
});

test('a row with no workspace belongs to nobody and reaches nobody', async () => {
  // Treating NULL as "everyone's" is the same leak by another route.
  asUser = 'u-owner-a'; asWorkspace = 'ws-a';
  const res = await get('/activity');
  assert.ok(!res.json.some((r) => r.details === 'linha antiga sem workspace'));
});

test('a member of the workspace is refused, not shown a smaller list', async () => {
  /*
   * workspace_admin is enough to run the workspace and NOT enough to read a record of what every
   * colleague did. A filtered subset would also be worse than a refusal: a page that silently
   * shows less is a page nobody can trust the emptiness of.
   */
  asUser = 'u-member-a'; asWorkspace = 'ws-a';
  const res = await get('/activity');
  assert.equal(res.status, 403);
});

test('the other tenant owner sees only their own tenant', async () => {
  asUser = 'u-owner-b'; asWorkspace = 'ws-b';
  const res = await get('/activity');
  assert.equal(res.status, 200);
  assert.equal(res.json.length, 1);
  assert.equal(res.json[0].details, 'SEGREDO DO OUTRO CLIENTE');
});

test('the page asks whether to draw the section at all', async () => {
  // So a member never meets a panel that exists only to refuse them.
  asUser = 'u-owner-a'; asWorkspace = 'ws-a';
  assert.equal((await get('/activity/available')).json.available, true);
  asUser = 'u-member-a';
  assert.equal((await get('/activity/available')).json.available, false);
});

test('filtering by person narrows to that person, still inside the tenant', async () => {
  asUser = 'u-owner-a'; asWorkspace = 'ws-a';
  const res = await get('/activity?user_id=u-member-a');
  assert.equal(res.json.length, 1);
  assert.equal(res.json[0].user_name, 'Membro A');

  // And the filter cannot be used to reach across the boundary.
  const across = await get('/activity?user_id=u-owner-b');
  assert.deepEqual(across.json, []);
});

test('the people filter lists only this tenant', async () => {
  asUser = 'u-owner-a'; asWorkspace = 'ws-a';
  const names = (await get('/activity/users')).json.map((u) => u.name);
  assert.deepEqual(names.sort(), ['Dona A', 'Membro A']);
});
