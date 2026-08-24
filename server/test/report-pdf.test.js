'use strict';

/*
 * The PDF, and the code printed on it.
 *
 * A proof-of-play document exists to be BELIEVED by somebody outside this system — the advertiser
 * who paid for the slot. So the two things pinned here are that it renders at all (a PDF that
 * throws halfway through streams a truncated file that opens as a corrupt document, not as an
 * error), and that the code on it keeps resolving to the numbers the paper claims.
 *
 * Rendering is checked by producing real bytes and reading them back, not by inspecting the
 * builder's source: PDFKit fails at draw time, on the values, in ways no text match would see.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';
process.env.APP_URL = 'https://player.loopplayer.com.br';

const express = require('express');
const { db } = require('../db/database');
const { screenPdf, filePdf, playlistPdf } = require('../lib/report-pdf');
const { deviceSummary } = require('../lib/device-summary');
const { fileReport } = require('../lib/file-report');
const { playlistSummary } = require('../lib/playlist-summary');
const { recordExport, lookup, newCode, ALPHABET } = require('../lib/report-verify');

let server, base;

/* Collect a PDFKit stream into a Buffer — the same bytes the route would send. */
function render(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

/*
 * The text a PDF actually carries, decoded.
 *
 * PDFKit writes hex strings inside TJ arrays, encoded as WinAnsi — where ó, ç, õ and the em dash
 * live at 0xF3, 0xE7, 0xF5 and 0x97. Read as latin1 they would be something else entirely, so the
 * decode is part of the check: a lost accent is exactly the failure this is looking for.
 */
const CP1252 = { 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x96: '–', 0x97: '—', 0x85: '…' };

function pdfText(buf) {
  const s = buf.toString('latin1');
  const lines = [];
  let i = 0;
  while (true) {
    const a = s.indexOf('stream', i);
    if (a < 0) break;
    const b = s.indexOf('endstream', a);
    if (b < 0) break;
    let body = buf.subarray(a + 6, b);
    while (body.length && (body[0] === 13 || body[0] === 10)) body = body.subarray(1);
    try {
      const t = require('node:zlib').inflateSync(body).toString('latin1');
      for (const m of t.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
        const parts = [...m[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => {
          let out = '';
          for (let k = 0; k + 1 < h[1].length; k += 2) {
            const c = parseInt(h[1].slice(k, k + 2), 16);
            out += CP1252[c] || String.fromCharCode(c);
          }
          return out;
        });
        if (parts.join('').trim()) lines.push(parts.join(''));
      }
    } catch { /* an image or a font, not a content stream */ }
    i = b + 9;
  }
  return lines.join('\n');
}

const META = { tenant: 'Loop Mídia', code: 'ABC-DEF-GHJ', generatedAt: 1756000000, url: 'https://x/verificar/ABC-DEF-GHJ' };

before(async () => {
  db.prepare("INSERT INTO users (id,email,password_hash,plan_id) VALUES ('u','u@t','x','corporate')").run();
  db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('o','O','u')").run();
  db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('ws','o','Loop Mídia')").run();
  db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name) VALUES ('p1','u','ws','Montanha Geral')").run();
  db.prepare("INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type) VALUES ('c1','u','ws','151 IDEIA 3 GLAMOUR INTENSE — açaí, ñ, ção.mp4','a','video/mp4')").run();
  db.prepare("INSERT INTO widgets (id,user_id,workspace_id,name,widget_type) VALUES ('w1','u','ws','Relógio','clock')").run();
  db.prepare("INSERT INTO devices (id,user_id,workspace_id,name,playlist_id,timezone,status) VALUES ('d1','u','ws','Pro Eletronic','p1','America/Sao_Paulo','online')").run();
  db.prepare("INSERT INTO playlist_items (playlist_id, content_id) VALUES ('p1','c1')").run();

  const at = (h) => Math.floor(Date.UTC(2026, 8, 10, h + 3, 0, 0) / 1000);
  const ins = db.prepare(`INSERT INTO play_logs (device_id,content_id,widget_id,playlist_id,playlist_name,content_name,started_at,duration_sec)
                          VALUES ('d1',?,?,'p1','Montanha Geral',?,?,15)`);
  for (const h of [8, 9, 10, 11, 11, 20]) ins.run('c1', null, 'promo.mp4', at(h));
  ins.run(null, 'w1', 'Relógio', at(11));

  const app = express();
  app.use((req, _res, next) => { req.user = { id: 'u' }; req.workspaceId = 'ws'; next(); });
  app.use('/reports', require('../routes/reports'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

/* ---------------------------------------------------------------- rendering */

test('a screen report renders to real PDF bytes', async () => {
  const data = deviceSummary({ workspaceId: 'ws', deviceId: 'd1', start: '2026-09-10', end: '2026-09-10' });
  const bytes = await render(screenPdf(data, META));

  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-', 'a PDF, not an error page with a .pdf name');
  assert.ok(bytes.includes(Buffer.from('%%EOF')), 'and a COMPLETE one — a stream that threw halfway opens as corrupt');
  assert.ok(bytes.length > 3000, 'with the logo and the grid in it');
});

test('accented names do not break the built-in fonts', async () => {
  /*
   * PDFKit's standard fonts are WinAnsi-encoded. Portuguese is inside that set, but a character
   * outside it throws at draw time — which reaches the operator as a truncated download rather
   * than as an error. The file name in this fixture carries ç, ã, ñ and an em dash on purpose.
   */
  const data = fileReport({ workspaceId: 'ws', contentId: 'c1', start: '2026-09-10', end: '2026-09-10' });
  const bytes = await render(filePdf(data, META));
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.ok(bytes.includes(Buffer.from('%%EOF')));
});

test('a report with nothing in it still produces a document', async () => {
  // An empty period is a legitimate answer — "this screen showed nothing last Tuesday" is exactly
  // what somebody opens the report to find out — and it must not be a failed download.
  const data = deviceSummary({ workspaceId: 'ws', deviceId: 'd1', start: '2020-01-01', end: '2020-01-01' });
  const bytes = await render(screenPdf(data, META));
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.ok(bytes.includes(Buffer.from('%%EOF')));
});

test('a list report renders even when no screen runs the list', async () => {
  db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name) VALUES ('p-nova','u','ws','Recém-criada')").run();
  const data = playlistSummary({ workspaceId: 'ws', playlistId: 'p-nova', start: '2026-09-10', end: '2026-09-10' });
  const bytes = await render(playlistPdf(data, META));
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
});

/* ---------------------------------------------------------------- the code */

test('the code avoids the characters that get misheard', () => {
  /*
   * It is read aloud over the phone and typed back by somebody who did not generate it. O/0 and
   * I/1 are simply absent rather than corrected after the fact.
   */
  for (const c of 'O0I1') assert.ok(!ALPHABET.includes(c), `${c} must not be in the alphabet`);
  const code = newCode();
  assert.match(code, /^[A-Z2-9]{3}-[A-Z2-9]{3}-[A-Z2-9]{3}$/);
});

test('a code resolves to the numbers the paper claimed, not to a fresh query', () => {
  /*
   * THE WHOLE POINT. Re-running the report next month returns different numbers — the log is
   * pruned at 90 days and a screen may have been reassigned since. Checking a receipt against a
   * number that has moved is not checking anything, so what was claimed is frozen.
   */
  const code = recordExport({
    workspaceId: 'ws',
    userId: 'u',
    type: 'screen',
    subjectId: 'd1',
    subjectName: 'Pro Eletronic',
    window: { start: '2026-09-10', end: '2026-09-10' },
    summary: { plays: 7, seconds: 105 },
  });

  // The history moves underneath it.
  db.prepare("DELETE FROM play_logs WHERE device_id = 'd1'").run();

  const found = lookup(code);
  assert.equal(found.summary.plays, 7, 'the receipt still says what it said');
  assert.equal(found.subject, 'Pro Eletronic');
  assert.equal(found.tenant, 'Loop Mídia');
  assert.equal(found.period.start, '2026-09-10');

  // Put it back for the tests that follow.
  const at = Math.floor(Date.UTC(2026, 8, 10, 11, 0, 0) / 1000);
  db.prepare(`INSERT INTO play_logs (device_id,content_id,playlist_id,playlist_name,content_name,started_at,duration_sec)
              VALUES ('d1','c1','p1','Montanha Geral','promo.mp4',?,15)`).run(at);
});

test('a receipt keeps naming its subject after the subject is gone', () => {
  // Same reasoning as play_logs.content_name: a customer checking a month later must not be shown
  // a blank where their advertisement used to be.
  const code = recordExport({
    workspaceId: 'ws',
    userId: 'u',
    type: 'file',
    subjectId: 'c-some-file',
    subjectName: 'Campanha de Natal.mp4',
    window: { start: '2026-09-01', end: '2026-09-30' },
    summary: { plays: 900 },
  });
  assert.equal(lookup(code).subject, 'Campanha de Natal.mp4');
});

test('an unknown code is not found, and case does not decide that', () => {
  assert.equal(lookup('ZZZ-ZZZ-ZZZ'), null);
  const code = recordExport({
    workspaceId: 'ws', userId: 'u', type: 'screen', subjectId: 'd1', subjectName: 'X',
    window: { start: '2026-09-10', end: '2026-09-10' }, summary: {},
  });
  assert.ok(lookup(code.toLowerCase()), 'typed back in lower case by a human, and still found');
  assert.ok(lookup(` ${code} `), 'and pasted with the spaces an email client added');
});

/* ---------------------------------------------------------------- the route */

test('the route streams a PDF and records the handover', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM report_exports').get().n;

  const res = await fetch(`${base}/reports/pdf/screen/d1?start=2026-09-10&end=2026-09-10`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/pdf/);
  assert.match(res.headers.get('content-disposition'), /filename=relatorio-Pro-Eletronic-2026-09-10_2026-09-10\.pdf/);

  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');

  const after = db.prepare('SELECT COUNT(*) n FROM report_exports').get().n;
  assert.equal(after, before + 1, 'a PDF handed over is a PDF recorded');

  const row = db.prepare('SELECT * FROM report_exports ORDER BY rowid DESC LIMIT 1').get();
  assert.equal(row.type, 'screen');
  assert.equal(row.subject_name, 'Pro Eletronic');
  assert.equal(JSON.parse(row.summary_json).plays, deviceSummary({
    workspaceId: 'ws', deviceId: 'd1', start: '2026-09-10', end: '2026-09-10',
  }).totals.plays, 'and it records what the document actually printed');
});

test('another workspace gets a 404 from the PDF route too', async () => {
  // A third door to the same room, and the easiest one to leave unlocked.
  const app = express();
  app.use((req, _res, next) => { req.user = { id: 'u' }; req.workspaceId = 'ws-outra'; next(); });
  app.use('/reports', require('../routes/reports'));
  const s2 = http.createServer(app);
  await new Promise((r) => s2.listen(0, r));
  const res = await fetch(`http://127.0.0.1:${s2.address().port}/reports/pdf/screen/d1`);
  assert.equal(res.status, 404);
  await new Promise((r) => s2.close(r));
});

test('an unknown report type is refused before anything is recorded', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM report_exports').get().n;
  const res = await fetch(`${base}/reports/pdf/nonsense/d1`);
  assert.equal(res.status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM report_exports').get().n, before,
    'a refused request must not leave a receipt behind');
});

test('the document is in Portuguese, including the kinds', async () => {
  /*
   * It is read by a customer, not by an operator. "file" or "clock" in a column headed "Tipo" reads
   * as an untranslated string that escaped — which is exactly what it would be. Checked by decoding
   * the text out of the PDF rather than by reading the builder, because the encoding step is where
   * an accent would be lost.
   */
  /*
   * Its own clock play, rather than the one in before(). A test above deletes this screen's history
   * to prove a receipt survives it, so anything relying on the fixture being intact reads whatever
   * that test left behind — and passes or fails by position in the file.
   */
  db.prepare(`INSERT INTO play_logs (device_id,widget_id,playlist_id,playlist_name,content_name,started_at,duration_sec)
              VALUES ('d1','w1','p1','Montanha Geral','Relógio',?,12)`)
    .run(Math.floor(Date.UTC(2026, 8, 10, 17, 0, 0) / 1000));

  const data = deviceSummary({ workspaceId: 'ws', deviceId: 'd1', start: '2026-09-10', end: '2026-09-10' });
  const text = pdfText(await render(screenPdf(data, META)));

  assert.match(text, /Relatório de exibições/);
  assert.match(text, /Total de exibições/);
  assert.match(text, /Período/);
  assert.match(text, /Código/);
  assert.match(text, /Relógio/, 'the clock widget, named in Portuguese');
  assert.doesNotMatch(text, /\bclock\b/, 'and not by its slug');
  assert.match(text, /Horários na hora da tela/, 'the footnote that says whose clock these are');
});

test('the grid in the document adds up to the total printed above it', async () => {
  // The numbers on the page and the numbers in the grid are drawn from the same cells, and a
  // customer WILL add up a column.
  const data = deviceSummary({ workspaceId: 'ws', deviceId: 'd1', start: '2026-09-10', end: '2026-09-10' });
  const text = pdfText(await render(screenPdf(data, META)));
  assert.ok(text.includes(String(data.totals.plays)), 'the total is on the page');
  assert.equal(data.matrix.col_totals.reduce((a, b) => a + b, 0), data.totals.plays);
});

test('the footer knows how many pages there are', async () => {
  /*
   * Stamped after the body is laid out, because the count is not knowable while it is still being
   * written. A document that says "1 / 1" on page four is the kind of small lie that makes a reader
   * doubt the numbers above it.
   */
  const data = deviceSummary({ workspaceId: 'ws', deviceId: 'd1', start: '2026-09-10', end: '2026-09-10' });
  const text = pdfText(await render(screenPdf(data, META)));
  assert.match(text, /\d+ \/ \d+/);
});

test('the code on the page points somewhere permanent', async () => {
  // Not "válidas até" two minutes from now. A receipt that expires while it is being read proves
  // nothing — see lib/report-verify.js.
  const data = deviceSummary({ workspaceId: 'ws', deviceId: 'd1', start: '2026-09-10', end: '2026-09-10' });
  const text = pdfText(await render(screenPdf(data, META)));
  assert.match(text, /ABC-DEF-GHJ/);
  assert.match(text, /verificar/);
  assert.doesNotMatch(text, /válid/i, 'nothing on this document expires');
});
