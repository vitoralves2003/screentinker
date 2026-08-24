'use strict';

/*
 * The two exhibition endpoints, over HTTP.
 *
 * The builder is tested directly elsewhere; what is checked here is the wiring, because the way a
 * report leaks is never a clever attack. It is a route that reads a device id from the URL and
 * forgets to pass the workspace, and the result looks like the feature working — for somebody
 * else's screen.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exhr-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';

const express = require('express');
const { db } = require('../db/database');

let server, base;
let asWorkspace = 'ws-a';

const get = async (p) => {
  const res = await fetch(base + p);
  /*
   * Read as BYTES first. res.text() decodes UTF-8 and removes the BOM on the way through, so a
   * string can never prove one was sent — and the BOM is the whole reason Excel reads "Manhã"
   * correctly rather than as mojibake.
   */
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder('utf-8').decode(bytes);
  let json = null;
  try { json = JSON.parse(text); } catch { /* CSV, or an error page */ }
  return { status: res.status, bytes, text, json, headers: res.headers };
};

before(async () => {
  db.prepare("INSERT INTO users (id,email,password_hash,plan_id) VALUES ('u','u@t','x','corporate')").run();
  db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('org','O','u')").run();
  db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('ws-a','org','A')").run();
  db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('ws-b','org','B')").run();

  db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name) VALUES ('p1','u','ws-a','Manhã')").run();
  db.prepare("INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type) VALUES ('c1','u','ws-a','a.mp4','a','video/mp4')").run();
  db.prepare("INSERT INTO devices (id,user_id,workspace_id,name,playlist_id,timezone) VALUES ('d1','u','ws-a','Loja Centro','p1','America/Sao_Paulo')").run();
  db.prepare("INSERT INTO devices (id,user_id,workspace_id,name) VALUES ('d2','u','ws-b','Tela do outro cliente')").run();

  // Two plays on 2026-06-10, São Paulo time (UTC-3): 08:00 and 08:01 local.
  const at = Math.floor(Date.UTC(2026, 5, 10, 11, 0, 0) / 1000);
  const ins = db.prepare(`INSERT INTO play_logs (device_id,content_id,playlist_id,playlist_name,content_name,started_at,duration_sec,completed)
                          VALUES (?,?,?,?,?,?,?,1)`);
  ins.run('d1', 'c1', 'p1', 'Manhã', 'a.mp4', at, 15);
  // A file name that IS a formula. Excel executes a cell starting with = + - or @, and this CSV
  // is opened by the customer the report is for.
  ins.run('d1', 'c1', 'p1', 'Manhã', '=HYPERLINK("http://x","clique")', at + 60, 15);
  ins.run('d2', null, null, '', 'segredo-do-outro.mp4', at, 15);

  const app = express();
  // Stands in for requireAuth + resolveTenancy, setting exactly what the routes read.
  app.use((req, _res, next) => {
    req.user = { id: 'u', role: 'user' };
    req.workspaceId = asWorkspace;
    next();
  });
  app.use('/reports', require('../routes/reports'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

test('the timeline comes back grouped into the screen\'s days', async () => {
  asWorkspace = 'ws-a';
  const res = await get('/reports/device/d1/timeline?start=2026-06-10&end=2026-06-10');
  assert.equal(res.status, 200);
  assert.equal(res.json.timezone, 'America/Sao_Paulo');
  assert.equal(res.json.totals.plays, 2);
  assert.equal(res.json.days[0].date, '2026-06-10');
  assert.equal(res.json.days[0].items.at(-1).time, '08:00', 'UTC-3, and told in the screen\'s clock');
  assert.equal(res.json.retention_days, 90, 'an empty week must be readable as pruned, not as quiet');
});

test('another workspace gets a 404, not a smaller number', async () => {
  /*
   * The failure that looks like success. Answering 200 with someone else's plays is indisting-
   * uishable from working; answering 403 would confirm the device id exists.
   */
  asWorkspace = 'ws-b';
  const res = await get('/reports/device/d1/timeline');
  assert.equal(res.status, 404);
  assert.ok(!res.text.includes('Manhã'), 'not one row of it');

  const other = await get('/reports/device/d1/timeline/export');
  assert.equal(other.status, 404, 'and the export is a second door to the same room');
});

test('a device that does not exist is answered the same way as one that is not yours', async () => {
  asWorkspace = 'ws-a';
  assert.equal((await get('/reports/device/nope/timeline')).status, 404);
});

test('the export is a CSV that Excel opens and cannot be talked into running a formula', async () => {
  asWorkspace = 'ws-a';
  const res = await get('/reports/device/d1/timeline/export?start=2026-06-10&end=2026-06-10');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /filename=exibicoes-Loja-Centro-2026-06-10_2026-06-10\.csv/);

  assert.deepEqual([...res.bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF],
    'without the BOM Excel renders accented names as mojibake');

  /*
   * A file name beginning with = + - or @ is a formula to Excel, and the CSV is opened by the
   * person the report is FOR. The cell is prefixed so it stays text.
   */
  assert.ok(res.text.includes(`"'=HYPERLINK(""http://x"",""clique"")"`),
    'prefixed so it stays text, and every quote doubled so it stays one cell');
});

test('the export carries the zone in the file, not only on the page that offered it', async () => {
  asWorkspace = 'ws-a';
  const res = await get('/reports/device/d1/timeline/export?start=2026-06-10&end=2026-06-10');
  // A column of times with no zone beside it will eventually be read in the wrong one, by which
  // point nothing in the file can settle the argument.
  assert.match(res.text, /America\/Sao_Paulo/);
  assert.match(res.text, /Loja Centro/);
  assert.match(res.text, /2026-06-10/);
});

test('the export reads forwards, the page reads backwards', async () => {
  asWorkspace = 'ws-a';
  const csv = (await get('/reports/device/d1/timeline/export?start=2026-06-10&end=2026-06-10')).text;
  // Data rows only: the note line above the header names the period, so it contains the date too.
  const rows = csv.split('\r\n').filter((l) => l.startsWith('"2026-06-10"'));
  assert.equal(rows.length, 2, 'both plays, and neither the note nor the header');
  assert.ok(rows[0].includes('08:00'), 'proof of play reads in the order it happened');

  const page = (await get('/reports/device/d1/timeline?start=2026-06-10&end=2026-06-10')).json;
  assert.equal(page.days[0].items[0].time, '08:01', 'the page opens on the most recent');
});

test('no workspace at all returns nothing, not everything', async () => {
  // req.workspaceId is absent for a user who is between workspaces. The report must fail closed.
  asWorkspace = undefined;
  assert.equal((await get('/reports/device/d1/timeline')).status, 404);
});

test('the file report is scoped the same way, through its own route', async () => {
  // A second route to the same data is a second place for the workspace to be forgotten.
  asWorkspace = 'ws-b';
  assert.equal((await get('/reports/file/c1')).status, 404);
  assert.equal((await get('/reports/file/c1/export')).status, 404);

  asWorkspace = 'ws-a';
  const ok = await get('/reports/file/c1?start=2026-06-10&end=2026-06-10');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.file.filename, 'a.mp4');
  assert.equal(ok.json.totals.plays, 2);
});

test('the file export carries all three tables in one file, with one BOM', async () => {
  /*
   * Three downloads would be three attachments that have to be kept together to mean anything.
   * And exactly one BOM: toCsv puts one at the top of every section it builds, so the ones in the
   * middle are stripped — a BOM inside a file is a visible glyph, not an encoding.
   */
  asWorkspace = 'ws-a';
  const res = await get('/reports/file/c1/export?start=2026-06-10&end=2026-06-10');
  assert.equal(res.status, 200);
  assert.deepEqual([...res.bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF]);
  // Counted in BYTES: TextDecoder consumes a leading BOM, so the decoded string cannot see the
  // one at the front and would report the interior ones as the only ones.
  let boms = 0;
  for (let i = 0; i + 2 < res.bytes.length; i++) {
    if (res.bytes[i] === 0xEF && res.bytes[i + 1] === 0xBB && res.bytes[i + 2] === 0xBF) boms++;
  }
  assert.equal(boms, 1, 'one BOM, at the front — the ones between sections are stripped');

  // One header per section, and the note that says what the file is about.
  assert.match(res.text, /"Tela","Situacao"/);
  assert.match(res.text, /"Lista","Excluida"/);
  assert.match(res.text, /"Dia","Exibicoes"/);
  assert.match(res.text, /Arquivo: a\.mp4/);
});
