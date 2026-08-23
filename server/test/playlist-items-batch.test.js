'use strict';

/*
 * Adding the library's selected files to a playlist, in one request.
 *
 * The interesting cases are the failure ones. A bulk action that half-succeeds leaves the operator
 * reading a list to work out what landed, and a bulk action that silently does less than asked
 * (skipping duplicates without saying so) is the same problem wearing a success toast.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plbatch-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';

const express = require('express');
const { db } = require('../db/database');

const USER = 'u-batch2';
const UUID = () => crypto.randomUUID();
let server, base;

function mkContent(id, ws = 'ws-b') {
  db.prepare("INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, duration_sec) VALUES (?,?,?,?,?, 'video/mp4', 12)")
    .run(id, USER, ws, id + '.mp4', id + '.mp4');
}

function mkPlaylist(id, status = 'draft') {
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name, status) VALUES (?,?, 'ws-b', ?, ?)")
    .run(id, USER, 'Lista ' + id.slice(0, 4), status);
}

const items = (pid) => db.prepare('SELECT content_id, sort_order, duration_sec FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order').all(pid);

async function post(p, body) {
  const res = await fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

before(async () => {
  db.prepare("INSERT INTO users (id, email, password_hash, plan_id) VALUES (?,?, 'x', 'free')").run(USER, USER + '@t.local');
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-b', 'Org', ?)").run(USER);
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-b', 'org-b', 'WS')").run();
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-alheio', 'org-b', 'Other')").run();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.workspaceId = 'ws-b'; req.user = { id: USER, role: 'platform_admin' }; next(); });
  app.use('/playlists', require('../routes/playlists'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

test('the selected files land in one call, in the order they were given', async () => {
  const pl = UUID(); mkPlaylist(pl);
  const a = UUID(), b = UUID(), c = UUID();
  [a, b, c].forEach((id) => mkContent(id));

  const res = await post(`/playlists/${pl}/items/batch`, { content_ids: [c, a, b] });
  assert.equal(res.status, 201);
  assert.equal(res.json.added, 3);
  assert.equal(res.json.skipped, 0);
  assert.deepEqual(items(pl).map((i) => i.content_id), [c, a, b], 'order must be the selection order');
});

test('duplicates are skipped and counted, not appended in silence', async () => {
  /*
   * The same clip twice in a rotation is legitimate, but that is arranged in the playlist editor
   * where the order is visible. From the library the sentence is "put these in that list", and
   * the likelier cause of a repeat is a second click. Either way the count has to be honest.
   */
  const pl = UUID(); mkPlaylist(pl);
  const a = UUID(), b = UUID();
  [a, b].forEach((id) => mkContent(id));

  await post(`/playlists/${pl}/items/batch`, { content_ids: [a] });
  const res = await post(`/playlists/${pl}/items/batch`, { content_ids: [a, b] });
  assert.equal(res.json.added, 1);
  assert.equal(res.json.skipped, 1);
  assert.deepEqual(items(pl).map((i) => i.content_id), [a, b]);
});

test('an unknown id rejects the whole batch, leaving nothing behind', async () => {
  // Partial application is the state nobody can reason about afterwards.
  const pl = UUID(); mkPlaylist(pl);
  const a = UUID(); mkContent(a);

  const res = await post(`/playlists/${pl}/items/batch`, { content_ids: [a, UUID()] });
  assert.equal(res.status, 404);
  assert.deepEqual(items(pl), [], 'the valid half must not have landed');
});

test('a file from another workspace is refused, and nothing lands', async () => {
  const pl = UUID(); mkPlaylist(pl);
  const mine = UUID(); mkContent(mine);
  const theirs = UUID(); mkContent(theirs, 'ws-alheio');

  const res = await post(`/playlists/${pl}/items/batch`, { content_ids: [mine, theirs] });
  assert.equal(res.status, 403);
  assert.deepEqual(items(pl), []);
});

test('a published playlist goes back to draft, because the screens have the old snapshot', async () => {
  /*
   * The files are in the list and not yet on any screen. The panel says so in the toast; if this
   * ever stopped happening the list would claim to be published while its snapshot lacked the
   * items that were just added.
   */
  const pl = UUID(); mkPlaylist(pl, 'published');
  const a = UUID(); mkContent(a);

  await post(`/playlists/${pl}/items/batch`, { content_ids: [a] });
  assert.equal(db.prepare('SELECT status FROM playlists WHERE id = ?').get(pl).status, 'draft');
});

test('items keep appending after what is already there', async () => {
  const pl = UUID(); mkPlaylist(pl);
  const a = UUID(), b = UUID();
  [a, b].forEach((id) => mkContent(id));

  await post(`/playlists/${pl}/items/batch`, { content_ids: [a] });
  await post(`/playlists/${pl}/items/batch`, { content_ids: [b] });
  const rows = items(pl);
  assert.deepEqual(rows.map((i) => i.content_id), [a, b]);
  assert.ok(rows[1].sort_order > rows[0].sort_order, 'the second add must sort after the first');
});

test('the duration comes from the file, so an added item is not zero-length', async () => {
  // resolveItemDuration is what the single-add path uses; a batch that skipped it would put items
  // on screen for the fallback duration instead of the clip's own length.
  const pl = UUID(); mkPlaylist(pl);
  const a = UUID(); mkContent(a);
  await post(`/playlists/${pl}/items/batch`, { content_ids: [a] });
  assert.equal(items(pl)[0].duration_sec, 12);
});

test('an empty or oversized batch is refused rather than half-handled', async () => {
  const pl = UUID(); mkPlaylist(pl);
  assert.equal((await post(`/playlists/${pl}/items/batch`, { content_ids: [] })).status, 400);
  assert.equal((await post(`/playlists/${pl}/items/batch`, {})).status, 400);
  assert.equal((await post(`/playlists/${pl}/items/batch`, { content_ids: new Array(201).fill(UUID()) })).status, 400);
});
