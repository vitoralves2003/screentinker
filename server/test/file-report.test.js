'use strict';

/*
 * The report for one file.
 *
 * "In how many lists is this file, and on how many screens does it appear" is the question that
 * was asked by name, and it is the one where a wrong answer is invisible: an under-count looks
 * exactly like a file that is simply used less. So most of this file is about reach, not plays.
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frep-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';

const { db } = require('../db/database');
const { fileReport } = require('../lib/file-report');

const WS = 'ws-a';
const OTHER = 'ws-b';

const mkList = (id, name, ws = WS) =>
  db.prepare('INSERT INTO playlists (id,user_id,workspace_id,name) VALUES (?,?,?,?)').run(id, 'u', ws, name);
const mkFile = (id, name, ws = WS) =>
  db.prepare('INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type) VALUES (?,?,?,?,?,?)')
    .run(id, 'u', ws, name, name, 'video/mp4');
const mkScreen = (id, name, listId, ws = WS, tz = 'America/Sao_Paulo', layoutId = null) =>
  db.prepare('INSERT INTO devices (id,user_id,workspace_id,name,playlist_id,timezone,status,layout_id) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, 'u', ws, name, listId, tz, 'online', layoutId);
const addItem = (listId, { content_id = null, sub = null }) =>
  db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sub_playlist_id) VALUES (?,?,?)')
    .run(listId, content_id, sub);

before(() => {
  db.prepare("INSERT INTO users (id,email,password_hash,plan_id) VALUES ('u','u@t','x','corporate')").run();
  db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('o','O','u')").run();
  db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES (?,'o','A')").run(WS);
  db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES (?,'o','B')").run(OTHER);

  mkFile('f1', 'promo.mp4');
  mkFile('f-alheio', 'do-outro.mp4', OTHER);

  // f1 sits in "Promoções". "Principal" rotates through Promoções as a sub-list. "Vitrine" is
  // assigned to a zone rather than to a whole screen.
  mkList('l-promo', 'Promoções');
  mkList('l-main', 'Principal');
  mkList('l-vitrine', 'Vitrine');
  mkList('l-sem', 'Lista sem o arquivo');
  addItem('l-promo', { content_id: 'f1' });
  addItem('l-main', { sub: 'l-promo' });
  addItem('l-vitrine', { content_id: 'f1' });
  addItem('l-sem', { content_id: 'f-alheio' });

  mkScreen('d-direct', 'Direta', 'l-promo');
  mkScreen('d-sub', 'Via sub-lista', 'l-main');
  mkScreen('d-none', 'Nao mostra', 'l-sem');

  /*
   * A real two-zone screen: a layout that exists, and zones that belong to it. The earlier version
   * of this fixture wrote zone rows with no layout behind them — a shape production does produce,
   * but only as leftovers, and testing against it hid the bug in the test below.
   */
  db.prepare("INSERT INTO layouts (id,user_id,name) VALUES ('lay-2z','u','Duas zonas')").run();
  db.prepare("INSERT INTO layout_zones (id,layout_id,name) VALUES ('z1','lay-2z','Esquerda')").run();
  db.prepare("INSERT INTO layout_zones (id,layout_id,name) VALUES ('z2','lay-2z','Direita')").run();
  mkScreen('d-zone', 'Por zona', 'l-sem', WS, 'America/Sao_Paulo', 'lay-2z');
  db.prepare("INSERT INTO device_zone_playlists (device_id, zone_id, playlist_id) VALUES ('d-zone','z1','l-vitrine')").run();

  // The same screen showing it in TWO zones is still one screen.
  db.prepare("INSERT INTO device_zone_playlists (device_id, zone_id, playlist_id) VALUES ('d-zone','z2','l-promo')").run();

  /*
   * And a screen carrying a zone row for a layout it no longer runs. Found in production: a panel
   * back on fullscreen (layout_id NULL) still had two device_zone_playlists rows from a layout
   * since deleted.
   */
  mkScreen('d-fantasma', 'Zona fantasma', 'l-sem');
  db.prepare("INSERT INTO device_zone_playlists (device_id, zone_id, playlist_id) VALUES ('d-fantasma','z-sumida','l-vitrine')").run();
});

test('a file in a list reached through a SUB-LIST still counts', () => {
  /*
   * The screen "Via sub-lista" runs Principal, which contains no files at all — it rotates through
   * Promoções. A reach query that only matches devices.playlist_id against lists holding the file
   * reports this screen as not showing it, which is how a rotation makes a file look unused.
   */
  const r = fileReport({ workspaceId: WS, contentId: 'f1' });
  const names = r.reach.screens.map((s) => s.name).sort();
  assert.deepEqual(names, ['Direta', 'Por zona', 'Via sub-lista']);
  assert.equal(r.reach.screen_count, 3);
  assert.ok(!names.includes('Nao mostra'));
});

test('a file assigned to a ZONE counts, and a screen showing it twice counts once', () => {
  /*
   * Multi-zone layouts assign a whole list per zone. "Por zona" runs a list without the file as
   * its main list and reaches it through two zones — one screen, however many zones.
   */
  const r = fileReport({ workspaceId: WS, contentId: 'f1' });
  const zone = r.reach.screens.find((s) => s.name === 'Por zona');
  assert.ok(zone, 'a zone assignment is a way of being on screen');
  assert.equal(r.reach.screens.filter((s) => s.name === 'Por zona').length, 1,
    'counting it twice overstates the reach of every file in a multi-zone layout');
  assert.ok(zone.hows.includes('zone'));
});

test('a zone assignment left over from a layout the screen no longer runs does NOT count', () => {
  /*
   * THE OVER-COUNT, and the mirror of the sub-list under-count above. device_zone_playlists rows
   * outlive the layout that created them: switching a screen back to fullscreen leaves them
   * pointing at zones that are nowhere on it any more. A file living only in such a list would be
   * reported as reaching a screen that has not shown it since — and "reaches 12 screens" is the
   * number a customer is quoted.
   *
   * Nothing about the stale row looks wrong on its own, which is why the join has to exclude it:
   * the zone must still belong to the layout the screen is actually running.
   */
  const r = fileReport({ workspaceId: WS, contentId: 'f1' });
  const names = r.reach.screens.map((s) => s.name);
  assert.ok(!names.includes('Zona fantasma'),
    'the row exists, the zone does not, and the screen is not showing the file');
  assert.ok(names.includes('Por zona'), 'a LIVE zone assignment still counts');
});

test('the lists say which hold the file and which only rotate through one that does', () => {
  const r = fileReport({ workspaceId: WS, contentId: 'f1' });
  const byName = Object.fromEntries(r.reach.playlists.map((p) => [p.name, p]));

  assert.equal(byName['Promoções'].via, null, 'this one actually contains it');
  assert.equal(byName['Vitrine'].via, null);
  assert.equal(byName['Principal'].via, 'Promoções',
    'saying "Principal" without saying how implies somebody added the file to it');
  assert.equal(r.reach.playlist_count, 3);
});

test('the count and the list it expands into cannot disagree', () => {
  // Two places counting the same thing is how a tile says 4 and the panel under it shows 3.
  const r = fileReport({ workspaceId: WS, contentId: 'f1' });
  assert.equal(r.reach.screen_count, r.reach.screens.length);
  assert.equal(r.reach.playlist_count, r.reach.playlists.length);
});

test('another workspace cannot read the file, and is not told it exists', () => {
  assert.equal(fileReport({ workspaceId: OTHER, contentId: 'f1' }), null);
  assert.equal(fileReport({ workspaceId: WS, contentId: 'f-alheio' }), null);
  assert.equal(fileReport({ workspaceId: null, contentId: 'f1' }), null);
});

test('reach is answered even with no play history at all', () => {
  /*
   * The half of this report that works on day one. Structural answers do not decay and do not wait
   * for ninety days of logs — which is why they are the ones on the tiles.
   */
  const r = fileReport({ workspaceId: WS, contentId: 'f1' });
  assert.equal(r.totals.plays, 0);
  assert.equal(r.reach.screen_count, 3, 'a file nobody has logged yet is still ON three screens');
});

test('days on air counts DAYS, not the span between the first and the last', () => {
  /*
   * A file that ran once in June and once in July has two days on air, not thirty-one. The span
   * reads as a much bigger number and would be the flattering one to report.
   */
  const june = Math.floor(Date.UTC(2026, 5, 10, 15, 0, 0) / 1000);  // 12:00 in São Paulo
  const july = Math.floor(Date.UTC(2026, 6, 10, 15, 0, 0) / 1000);
  const ins = db.prepare(`INSERT INTO play_logs (device_id,content_id,playlist_id,playlist_name,content_name,started_at,duration_sec)
                          VALUES (?,?,?,?,?,?,?)`);
  ins.run('d-direct', 'f1', 'l-promo', 'Promoções', 'promo.mp4', june, 10);
  ins.run('d-direct', 'f1', 'l-promo', 'Promoções', 'promo.mp4', june + 3600, 10);
  ins.run('d-direct', 'f1', 'l-promo', 'Promoções', 'promo.mp4', july, 10);

  const r = fileReport({ workspaceId: WS, contentId: 'f1', start: '2026-06-01', end: '2026-07-31' });
  assert.equal(r.totals.plays, 3);
  assert.equal(r.totals.days_on_air, 2);
  assert.deepEqual(r.by_day, [{ date: '2026-06-10', plays: 2 }, { date: '2026-07-10', plays: 1 }]);
});

test('each play is filed under the day the SCREEN was having', () => {
  /*
   * A fleet across timezones has no single calendar. This play is 2026-06-15T02:00Z — still the
   * 14th in São Paulo (UTC-3) and already the 15th in Kiritimati (UTC+14). Both are correct for
   * their own screen, and the series must not pick one clock for both.
   */
  mkScreen('d-kir', 'Kiritimati', 'l-promo', WS, 'Pacific/Kiritimati');
  const at = Math.floor(Date.UTC(2026, 5, 15, 2, 0, 0) / 1000);
  const ins = db.prepare(`INSERT INTO play_logs (device_id,content_id,playlist_id,playlist_name,content_name,started_at,duration_sec)
                          VALUES (?,?,?,?,?,?,?)`);
  ins.run('d-direct', 'f1', 'l-promo', 'Promoções', 'promo.mp4', at, 10);
  ins.run('d-kir', 'f1', 'l-promo', 'Promoções', 'promo.mp4', at, 10);

  const r = fileReport({ workspaceId: WS, contentId: 'f1', start: '2026-06-14', end: '2026-06-15' });
  const days = Object.fromEntries(r.by_day.map((d) => [d.date, d.plays]));
  assert.equal(days['2026-06-14'], 1, 'São Paulo was still on the 14th');
  assert.equal(days['2026-06-15'], 1, 'Kiritimati was already on the 15th');
});

test('the window is not cut short by the UTC edges of the days asked for', () => {
  /*
   * The reason the query over-fetches a day on each side and trims in JS. A Kiritimati screen's
   * 2026-06-15 begins at 2026-06-14T10:00Z — before the UTC day of the same name — so a query
   * bounded by UTC midnight silently loses the first fourteen hours of it.
   */
  const early = Math.floor(Date.UTC(2026, 5, 14, 11, 0, 0) / 1000); // 01:00 on the 15th in Kiritimati
  db.prepare(`INSERT INTO play_logs (device_id,content_id,playlist_id,playlist_name,content_name,started_at,duration_sec)
              VALUES ('d-kir','f1','l-promo','Promoções','promo.mp4',?,10)`).run(early);

  const r = fileReport({ workspaceId: WS, contentId: 'f1', start: '2026-06-15', end: '2026-06-15' });
  const days = Object.fromEntries(r.by_day.map((d) => [d.date, d.plays]));
  assert.equal(days['2026-06-15'], 2, 'both Kiritimati plays belong to its own 15th');
  assert.ok(!days['2026-06-14'], 'and the slack day is trimmed off again');
});

test('plays are attributed to the list they were RECORDED against, not where the file sits now', () => {
  /*
   * The two differ the moment a file is removed from a list, and the history of what it did there
   * is exactly what a report about the past is for.
   */
  mkList('l-antiga', 'Lista antiga');
  const at = Math.floor(Date.UTC(2026, 7, 1, 15, 0, 0) / 1000);
  db.prepare(`INSERT INTO play_logs (device_id,content_id,playlist_id,playlist_name,content_name,started_at,duration_sec)
              VALUES ('d-direct','f1','l-antiga','Lista antiga','promo.mp4',?,10)`).run(at);

  const r = fileReport({ workspaceId: WS, contentId: 'f1', start: '2026-08-01', end: '2026-08-01' });
  assert.deepEqual(r.by_list.map((l) => l.name), ['Lista antiga']);
  assert.ok(!r.reach.playlists.some((p) => p.name === 'Lista antiga'),
    'it is not in that list today, and reach says so — the two answers are about different times');
});

test('a deleted list still names itself in the play history', () => {
  const at = Math.floor(Date.UTC(2026, 7, 2, 15, 0, 0) / 1000);
  mkList('l-morta', 'Lista morta');
  db.prepare(`INSERT INTO play_logs (device_id,content_id,playlist_id,playlist_name,content_name,started_at,duration_sec)
              VALUES ('d-direct','f1','l-morta','Lista morta','promo.mp4',?,10)`).run(at);
  db.prepare("DELETE FROM playlists WHERE id = 'l-morta'").run();

  const r = fileReport({ workspaceId: WS, contentId: 'f1', start: '2026-08-02', end: '2026-08-02' });
  assert.deepEqual(r.by_list.map((l) => [l.name, l.deleted]), [['Lista morta', true]]);
});

test('the tiles, the chart and the tables all count the same window', () => {
  /*
   * THE BUG THIS PINS. The first version ran four queries and only the daily series trimmed the
   * window to the screens' own days — so the tiles counted a play from a day the operator had not
   * asked for while the chart below them did not. Nothing looked wrong: every number was plausible
   * on its own, and only adding them up disagreed.
   */
  const r = fileReport({ workspaceId: WS, contentId: 'f1', start: '2026-06-01', end: '2026-08-31' });
  const sum = (rows) => rows.reduce((n, x) => n + x.plays, 0);

  assert.equal(sum(r.by_day), r.totals.plays, 'the chart must add up to the tile above it');
  assert.equal(sum(r.by_screen), r.totals.plays, 'and so must the screens');
  assert.equal(sum(r.by_list), r.totals.plays, 'and the lists');
});

test('a window with nothing in it is empty everywhere, not just in one place', () => {
  const r = fileReport({ workspaceId: WS, contentId: 'f1', start: '2020-01-01', end: '2020-01-02' });
  assert.equal(r.totals.plays, 0);
  assert.equal(r.totals.days_on_air, 0);
  assert.deepEqual(r.by_day, []);
  assert.deepEqual(r.by_screen, []);
  assert.deepEqual(r.by_list, []);
  assert.equal(r.totals.first_play, null, 'no plays means no first play, not epoch zero');
  assert.equal(r.reach.screen_count, 4, 'but the file is still on the screens it is on');
});

test('the grid puts each play in ITS OWN screen\'s hour', () => {
  /*
   * A file on a screen in São Paulo and one in Kiritimati plays at 11h on both — sixteen hours
   * apart in real time. Both belong in the 11h column, because the hour an advertiser is asking
   * about is the hour on the screen in front of their customer. Building the grid with one
   * timezone for the whole thing would file one of these screens under an hour it never played.
   */
  const spNoon = Math.floor(Date.UTC(2026, 8, 1, 14, 0, 0) / 1000);   // 11:00 in São Paulo (UTC-3)
  const kirNoon = Math.floor(Date.UTC(2026, 7, 31, 21, 0, 0) / 1000); // 11:00 on 01/09 in Kiritimati (UTC+14)
  const ins = db.prepare(`INSERT INTO play_logs (device_id,content_id,playlist_id,playlist_name,content_name,started_at,duration_sec)
                          VALUES (?,'f1','l-promo','Promoções','promo.mp4',?,10)`);
  ins.run('d-direct', spNoon);
  ins.run('d-kir', kirNoon);

  const r = fileReport({ workspaceId: WS, contentId: 'f1', start: '2026-09-01', end: '2026-09-01' });
  assert.equal(r.matrix.kind, 'hour', 'one day is told in hours');
  assert.equal(r.matrix.columns.length, 24);

  const at11 = r.matrix.column_keys.indexOf('11');
  const rows = Object.fromEntries(r.matrix.rows.map((x) => [x.name, x.cells[at11]]));
  assert.equal(rows['Direta'], 1, 'São Paulo played at its own 11h');
  assert.equal(rows['Kiritimati'], 1, 'and Kiritimati at its own, sixteen hours away');
  assert.equal(r.matrix.col_totals[at11], 2);
});

test('the grid and the tiles above it cannot disagree', () => {
  // Row totals, column totals and the grand total all come from the same cells, so the grid can
  // never add up to something other than the number printed above it.
  const r = fileReport({ workspaceId: WS, contentId: 'f1', start: '2026-06-01', end: '2026-09-01' });
  if (r.matrix.kind === 'none') return; // too long a period for a grid, which is its own answer

  const fromRows = r.matrix.rows.reduce((n, x) => n + x.total, 0);
  const fromCols = r.matrix.col_totals.reduce((a, b) => a + b, 0);
  assert.equal(fromRows, r.matrix.total);
  assert.equal(fromCols, r.matrix.total);
  assert.equal(r.matrix.total, r.totals.plays, 'and it matches the tile');
});

test('a period too long for a grid says so instead of drawing an unreadable one', () => {
  const r = fileReport({ workspaceId: WS, contentId: 'f1', start: '2026-01-01', end: '2026-12-31' });
  assert.equal(r.matrix.kind, 'none');
  assert.equal(r.matrix.reason, 'too_many_days');
  // The ranking still answers "what played most"; only the shape of the days is lost.
  assert.ok(r.by_screen.length > 0);
});
