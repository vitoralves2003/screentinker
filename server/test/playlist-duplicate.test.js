'use strict';

/*
 * Duplicating a playlist.
 *
 * What a copy must NOT carry is the interesting half. A duplicate that arrived published, or that
 * inherited the original's screens, would be on real panels the moment it was created — and the
 * first thing anybody does with a copy is edit it. Neither of those failures raises an error or
 * shows up in the copy's own page; they show up on a wall somewhere.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pldup-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';

const express = require('express');
const { db } = require('../db/database');
const { publishPlaylist } = require('../routes/playlists');

const USER = 'u-dup';
const UUID = () => crypto.randomUUID();
let server, base;

function mkContent(id) {
  db.prepare("INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, duration_sec) VALUES (?,?, 'ws-d', ?, ?, 'video/mp4', 9)")
    .run(id, USER, id + '.mp4', id + '.mp4');
}

function mkPlaylist(id, name = 'Lista', status = 'draft') {
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name, status) VALUES (?,?, 'ws-d', ?, ?)")
    .run(id, USER, name, status);
}

const addItem = (pid, cid, opts = {}) => db.prepare(
  'INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec, muted, zone_id) VALUES (?,?,?,?,?,?)')
  .run(pid, cid, opts.sort ?? 0, opts.duration ?? 9, opts.muted ?? 0, opts.zone ?? null).lastInsertRowid;

const items = (pid) => db.prepare('SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order').all(pid);
const row = (pid) => db.prepare('SELECT * FROM playlists WHERE id = ?').get(pid);

async function post(p) {
  const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' } });
  return { status: res.status, json: await res.json().catch(() => null) };
}

before(async () => {
  db.prepare("INSERT INTO users (id, email, password_hash, plan_id) VALUES (?,?, 'x', 'free')").run(USER, USER + '@t.local');
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-d', 'Org', ?)").run(USER);
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-d', 'org-d', 'WS')").run();

  /*
   * A real layout and zone. playlist_items.zone_id carries a foreign key, so a made-up id fails
   * the fixture insert and the test reports a copy bug that is really a fixture bug.
   */
  db.prepare("INSERT INTO layouts (id, user_id, workspace_id, name, width, height, is_template) VALUES ('lay-d', ?, 'ws-d', 'Layout', 1920, 1080, 0)").run(USER);
  db.prepare("INSERT INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, z_index, zone_type, fit_mode, sort_order) VALUES ('zona-x', 'lay-d', 'Principal', 0, 0, 100, 100, 0, 'content', 'contain', 0)").run();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.workspaceId = 'ws-d'; req.user = { id: USER, role: 'platform_admin' }; next(); });
  app.use('/playlists', require('../routes/playlists'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

test('the copy carries the items, in order, with their durations', async () => {
  const pl = UUID(); mkPlaylist(pl, 'Manhã');
  const a = UUID(), b = UUID(); [a, b].forEach(mkContent);
  addItem(pl, a, { sort: 0, duration: 15 });
  addItem(pl, b, { sort: 1, duration: 30 });

  const res = await post(`/playlists/${pl}/duplicate`);
  assert.equal(res.status, 201);
  const copied = items(res.json.id);
  assert.deepEqual(copied.map((i) => i.content_id), [a, b]);
  assert.deepEqual(copied.map((i) => i.duration_sec), [15, 30]);
  assert.equal(res.json.item_count, 2);
});

test('muted and zone_id come across', async () => {
  /*
   * Both are easy to leave out of a copy and impossible to notice afterwards: the duplicate plays
   * at full volume in the wrong zone, and it reads as a player bug rather than a copy bug.
   */
  const pl = UUID(); mkPlaylist(pl, 'Com som');
  const c = UUID(); mkContent(c);
  addItem(pl, c, { muted: 1, zone: 'zona-x' });

  const res = await post(`/playlists/${pl}/duplicate`);
  const it = items(res.json.id)[0];
  assert.equal(it.muted, 1, 'a muted item must stay muted');
  assert.equal(it.zone_id, 'zona-x', 'and stay in its zone');
});

test('per-item schedules are copied, with new ids of their own', async () => {
  const pl = UUID(); mkPlaylist(pl, 'Agendada');
  const c = UUID(); mkContent(c);
  const itemId = addItem(pl, c);
  db.prepare('INSERT INTO playlist_item_schedules (id, playlist_item_id, active_days, start_time, end_time, sort_order) VALUES (?,?,?,?,?,?)')
    .run(UUID(), itemId, '1,2,3', '09:00', '18:00', 0);

  const res = await post(`/playlists/${pl}/duplicate`);
  const newItem = items(res.json.id)[0];
  const scheds = db.prepare('SELECT * FROM playlist_item_schedules WHERE playlist_item_id = ?').all(newItem.id);
  assert.equal(scheds.length, 1);
  assert.equal(scheds[0].active_days, '1,2,3');
  assert.equal(scheds[0].start_time, '09:00');

  // The original's blocks must be untouched — a shared id would make editing one edit both.
  const original = db.prepare('SELECT * FROM playlist_item_schedules WHERE playlist_item_id = ?').all(itemId);
  assert.equal(original.length, 1);
  assert.notEqual(original[0].id, scheds[0].id);
});

test('a copy of a published playlist is a DRAFT, carrying no snapshot', async () => {
  /*
   * The safety of the whole feature. A published row is one with a snapshot devices can fetch;
   * copying that across would produce a second list claiming to be live, and the copy is the thing
   * somebody is about to start editing.
   */
  const pl = UUID(); mkPlaylist(pl, 'No ar');
  const c = UUID(); mkContent(c);
  addItem(pl, c);
  publishPlaylist(pl);
  assert.equal(row(pl).status, 'published', 'the original really is published');
  assert.ok(row(pl).published_snapshot, 'and really has a snapshot');

  const res = await post(`/playlists/${pl}/duplicate`);
  const copy = row(res.json.id);
  assert.equal(copy.status, 'draft');
  assert.equal(copy.published_snapshot, null, 'no snapshot for a list nobody has published');
  assert.equal(copy.published_draft, null);
});

test('the copy inherits no screens', async () => {
  /*
   * devices.playlist_id is the assignment. Copying it would put the new list on real panels the
   * instant it was created — the opposite of what "duplicate" means to whoever clicked it.
   */
  const pl = UUID(); mkPlaylist(pl, 'Atribuída');
  const c = UUID(); mkContent(c);
  addItem(pl, c);
  const dev = UUID();
  db.prepare("INSERT INTO devices (id, user_id, workspace_id, name, playlist_id) VALUES (?,?, 'ws-d', 'Tela 1', ?)").run(dev, USER, pl);

  const res = await post(`/playlists/${pl}/duplicate`);
  const onCopy = db.prepare('SELECT COUNT(*) n FROM devices WHERE playlist_id = ?').get(res.json.id).n;
  assert.equal(onCopy, 0, 'the copy must be on no screen');
  assert.equal(db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(dev).playlist_id, pl,
    'and the original screen must keep the original list');
});

test('a sub-list item copies the reference, not the sub-list', async () => {
  /*
   * Sub-lists are shared. Deep-copying one would silently create a second rotation nobody asked
   * for, and then editing "the" sub-list would only change one of the two.
   */
  const sub = UUID(); mkPlaylist(sub, 'Rotativa');
  const pl = UUID(); mkPlaylist(pl, 'Principal');
  db.prepare('INSERT INTO playlist_items (playlist_id, sub_playlist_id, sort_order) VALUES (?,?,0)').run(pl, sub);

  const before = db.prepare('SELECT COUNT(*) n FROM playlists').get().n;
  const res = await post(`/playlists/${pl}/duplicate`);
  assert.equal(items(res.json.id)[0].sub_playlist_id, sub, 'same sub-list, not a copy of it');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM playlists').get().n, before + 1, 'exactly one new playlist');
});

test('editing the copy does not touch the original', async () => {
  // The point of a duplicate. A shared item row would make this silently false.
  const pl = UUID(); mkPlaylist(pl, 'Base');
  const c = UUID(); mkContent(c);
  addItem(pl, c);

  const res = await post(`/playlists/${pl}/duplicate`);
  db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(res.json.id);
  assert.equal(items(pl).length, 1, 'the original keeps its item');
});

test('the copy is named so the two can be told apart in the index', async () => {
  const pl = UUID(); mkPlaylist(pl, 'Vitrine');
  const first = await post(`/playlists/${pl}/duplicate`);
  assert.equal(first.json.name, 'Vitrine (cópia)');

  // Duplicating again must not produce a second row with the same name.
  const second = await post(`/playlists/${pl}/duplicate`);
  assert.equal(second.json.name, 'Vitrine (cópia 2)');
});

test('an empty playlist duplicates to an empty playlist rather than failing', async () => {
  const pl = UUID(); mkPlaylist(pl, 'Vazia');
  const res = await post(`/playlists/${pl}/duplicate`);
  assert.equal(res.status, 201);
  assert.equal(res.json.item_count, 0);
  assert.deepEqual(items(res.json.id), []);
});

test('duplicating a playlist that does not exist is a 404, not a blank copy', async () => {
  const res = await post(`/playlists/${UUID()}/duplicate`);
  assert.equal(res.status, 404);
});
