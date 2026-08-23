'use strict';

/*
 * Reports by type: screens, files, playlists, groups.
 *
 * Two failure modes matter more than the arithmetic.
 *
 * The first is a cross-tenant leak. An aggregate is the easiest place in a product for one to
 * hide, because it surfaces as a slightly larger number rather than as somebody else's name — and
 * this very file once shipped an uptime report with no scope clause at all, readable by any
 * authenticated user for every device on the platform.
 *
 * The second is the CSV. These reports are made almost entirely of operator-supplied names, and a
 * file called "=cmd|..." is a formula the moment Excel opens it.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rep-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';

const express = require('express');
const { db } = require('../db/database');
const { csvCell } = require('../lib/reports');

let server, base;
let asWorkspace = 'ws-a';

const get = async (p) => {
  const res = await fetch(base + p);
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, ct, json: ct.includes('json') ? await res.json() : null, text: ct.includes('csv') ? await res.text() : null };
};

before(async () => {
  db.prepare("INSERT INTO users (id,email,password_hash,plan_id) VALUES ('u','u@t','x','corporate')").run();
  for (const [org, ws] of [['org-a', 'ws-a'], ['org-b', 'ws-b']]) {
    db.prepare('INSERT INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(org, org, 'u');
    db.prepare('INSERT INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(ws, org, ws);
  }

  // Tenant A: one group, two screens, a playlist with two files.
  db.prepare("INSERT INTO device_groups (id,user_id,workspace_id,name) VALUES ('g-a','u','ws-a','Padaria')").run();
  db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name,status) VALUES ('p-a','u','ws-a','Manhã','published')").run();
  for (const [id, name] of [['c-1', 'promo.mp4'], ['c-2', '=SOMA(1;1).mp4']]) {
    db.prepare("INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type,duration_sec) VALUES (?,'u','ws-a',?,?,'video/mp4',10)").run(id, name, id);
    db.prepare("INSERT INTO playlist_items (playlist_id,content_id,sort_order,duration_sec) VALUES ('p-a',?,0,10)").run(id);
  }
  db.prepare("INSERT INTO devices (id,user_id,workspace_id,name,playlist_id,status) VALUES ('d-1','u','ws-a','Tela 1','p-a','online')").run();
  // Group membership is a join table, not a column on devices — a screen can be in several.
  db.prepare("INSERT INTO device_group_members (device_id,group_id) VALUES ('d-1','g-a')").run();
  db.prepare("INSERT INTO devices (id,user_id,workspace_id,name,status) VALUES ('d-2','u','ws-a','Tela sem lista','offline')").run();

  // Tenant B: its own screen, file and plays. None of it may ever appear in A's reports.
  db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name) VALUES ('p-b','u','ws-b','SEGREDO')").run();
  db.prepare("INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type) VALUES ('c-b','u','ws-b','SEGREDO.mp4','cb','video/mp4')").run();
  db.prepare("INSERT INTO devices (id,user_id,workspace_id,name,playlist_id,status) VALUES ('d-b','u','ws-b','TELA SEGREDO','p-b','online')").run();

  const now = Math.floor(Date.now() / 1000);
  const play = db.prepare('INSERT INTO play_logs (device_id,content_id,content_name,started_at,duration_sec,completed) VALUES (?,?,?,?,?,1)');
  for (let i = 0; i < 5; i++) play.run('d-1', 'c-1', 'promo.mp4', now - 3600 - i, 10);
  for (let i = 0; i < 2; i++) play.run('d-1', 'c-2', 'formula.mp4', now - 7200 - i, 10);
  for (let i = 0; i < 99; i++) play.run('d-b', 'c-b', 'SEGREDO.mp4', now - 100 - i, 30);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'u', role: 'platform_admin' };
    req.workspaceId = asWorkspace;
    next();
  });
  app.use('/reports', require('../routes/reports'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

// ---- the boundary ------------------------------------------------------------------------------

for (const type of ['screens', 'files', 'playlists', 'groups']) {
  test(`${type}: nothing from another tenant appears`, async () => {
    asWorkspace = 'ws-a';
    const body = JSON.stringify((await get(`/reports/by/${type}`)).json);
    assert.ok(!body.includes('SEGREDO'), `${type} leaked tenant B's data`);
  });
}

test('the other tenant sees only its own, and the counts do not bleed', async () => {
  asWorkspace = 'ws-b';
  const rows = (await get('/reports/by/screens')).json.rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'TELA SEGREDO');
  assert.equal(rows[0].plays, 99);
  asWorkspace = 'ws-a';
});

test('no workspace means no rows, not every row', async () => {
  // The dangerous default. A missing filter that resolves to "unscoped" returns the platform.
  asWorkspace = null;
  for (const type of ['screens', 'files', 'playlists', 'groups']) {
    assert.deepEqual((await get(`/reports/by/${type}`)).json.rows, [], type);
  }
  asWorkspace = 'ws-a';
});

// ---- what the reports actually say ---------------------------------------------------------------

test('screens: a screen that played nothing is still listed', async () => {
  /*
   * The panel that has shown nothing all week is the single most interesting row in a report about
   * screens. An INNER JOIN on play_logs would hide exactly that one.
   */
  const rows = (await get('/reports/by/screens')).json.rows;
  const names = rows.map((r) => r.name);
  assert.ok(names.includes('Tela 1'));
  assert.ok(names.includes('Tela sem lista'), 'a screen with no plays must still appear');
  assert.equal(rows.find((r) => r.name === 'Tela sem lista').plays, 0);
  assert.equal(rows.find((r) => r.name === 'Tela 1').plays, 7);
  assert.equal(rows.find((r) => r.name === 'Tela 1').group_names, 'Padaria');
});

test('files: the structural counts are the ones that were asked for', async () => {
  const rows = (await get('/reports/by/files')).json.rows;
  const promo = rows.find((r) => r.filename === 'promo.mp4');
  assert.equal(promo.plays, 5);
  assert.equal(promo.in_playlists, 1, 'in how many playlists');
  assert.equal(promo.on_screens, 1, 'and on how many screens it therefore reaches');
});

test('files: a file in two lists on one screen counts that screen once', async () => {
  /*
   * DISTINCT across the join. Counting rows instead would report three screens for a file in
   * three lists that all run on the same panel — overstating every file in a small network.
   */
  db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name) VALUES ('p-a2','u','ws-a','Tarde')").run();
  db.prepare("INSERT INTO playlist_items (playlist_id,content_id,sort_order,duration_sec) VALUES ('p-a2','c-1',0,10)").run();
  db.prepare("UPDATE devices SET playlist_id = 'p-a2' WHERE id = 'd-2'").run();
  db.prepare("INSERT INTO playlist_items (playlist_id,content_id,sort_order,duration_sec) VALUES ('p-a2','c-2',1,10)").run();

  const promo = (await get('/reports/by/files')).json.rows.find((r) => r.filename === 'promo.mp4');
  assert.equal(promo.in_playlists, 2);
  assert.equal(promo.on_screens, 2, 'two screens, each running one of the two lists');

  db.prepare("UPDATE devices SET playlist_id = NULL WHERE id = 'd-2'").run();
  db.prepare("DELETE FROM playlist_items WHERE playlist_id = 'p-a2'").run();
  db.prepare("DELETE FROM playlists WHERE id = 'p-a2'").run();
});

test('playlists: how many screens run it, and how big it is', async () => {
  const rows = (await get('/reports/by/playlists')).json.rows;
  const manha = rows.find((r) => r.name === 'Manhã');
  assert.equal(manha.on_screens, 1);
  assert.equal(manha.items, 2);
  assert.equal(manha.plays, 7, 'attributed through the screens running it');
});

test('groups: how many screens the group has', async () => {
  const rows = (await get('/reports/by/groups')).json.rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Padaria');
  assert.equal(rows[0].screens, 1);
  assert.equal(rows[0].online, 1);
});

test('the answer carries its own window and the retention limit', async () => {
  /*
   * play_logs is pruned at 90 days, so an empty report means either "nothing played" or "it played
   * before the window". The page cannot tell the reader which unless the answer says what it asked.
   */
  const body = (await get('/reports/by/screens?start=2026-01-01&end=2026-01-31')).json;
  assert.equal(body.start, '2026-01-01');
  assert.equal(body.end, '2026-01-31');
  assert.equal(body.retention_days, 90);
});

test('an unknown report type is refused, not silently empty', async () => {
  assert.equal((await get('/reports/by/telepathy')).status, 404);
  assert.equal((await get('/reports/by/telepathy/export')).status, 404);
});

// ---- the CSV ---------------------------------------------------------------------------------------

test('every type exports, with a header and the rows', async () => {
  for (const type of ['screens', 'files', 'playlists', 'groups']) {
    const res = await get(`/reports/by/${type}/export`);
    assert.equal(res.status, 200, type);
    assert.match(res.ct, /text\/csv/, type);
    assert.ok(res.text.split('\r\n').length >= 2, `${type} must have a header and at least one row`);
  }
});

test('a filename that looks like a formula cannot execute in a spreadsheet', async () => {
  /*
   * "=SOMA(1;1).mp4" is a legitimate filename and a live formula the moment Excel opens the CSV.
   * The single-quote prefix is the standard defence and is invisible in the cell.
   */
  const csv = (await get('/reports/by/files/export')).text;
  assert.ok(csv.includes('"\'=SOMA(1;1).mp4"'), `the formula cell must be quoted-and-escaped; got: ${csv.slice(0, 400)}`);
  assert.ok(!/,"=SOMA/.test(csv), 'a bare = at the start of a cell is executable');
});

test('csvCell neutralises every character a spreadsheet treats as a formula', () => {
  for (const lead of ['=', '+', '-', '@']) {
    assert.equal(csvCell(`${lead}x`), `"'${lead}x"`, `${lead} must be escaped`);
  }
  assert.equal(csvCell('normal'), '"normal"', 'ordinary text is left alone');
  assert.equal(csvCell('a"b'), '"a""b"', 'quotes are doubled');
});

test('the CSV opens as UTF-8 in Excel', () => {
  // Without a BOM, Excel on a Portuguese Windows reads it as Latin-1 and every accented filename
  // arrives mangled — which looks like the export is broken rather than the encoding.
  const { toCsv } = require('../lib/reports');
  assert.ok(toCsv([{ label: 'Ação', get: () => 'ação' }], [{}]).startsWith('﻿'));
});
