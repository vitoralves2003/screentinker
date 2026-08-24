'use strict';

/*
 * The exhibition timeline for one screen.
 *
 * The value being defended here is not "it returns rows" — it is that every row is attributed
 * honestly. A proof-of-play report is shown to the customer who paid for the slot, so the two
 * failures that matter are attributing a play to the wrong day and attributing it to a list it did
 * not come from. Both produce output that looks entirely reasonable.
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exhib-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';

const { db } = require('../db/database');
const { deviceTimeline, deviceTimelineRows, zoneFor, MAX_ROWS } = require('../lib/exhibition');
const { dayRange, dayKey } = require('../lib/zoned-day');

const WS = 'ws-a';
const OTHER = 'ws-b';

before(() => {
  db.prepare("INSERT INTO users (id,email,password_hash,plan_id) VALUES ('u','u@t','x','corporate')").run();
  db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('o','O','u')").run();
  db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES (?,'o','A')").run(WS);
  db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES (?,'o','B')").run(OTHER);

  db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name) VALUES ('p1','u',?,'Manhã')").run(WS);
  db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name) VALUES ('p2','u',?,'Tarde')").run(WS);
  db.prepare("INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type) VALUES ('c1','u',?,'a.mp4','a','video/mp4')").run(WS);
  db.prepare("INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type) VALUES ('c2','u',?,'b.mp4','b','video/mp4')").run(WS);

  // Two screens on opposite sides of the date line, so "which day was that" has a different
  // answer on each and the server's own clock cannot be right for both.
  db.prepare("INSERT INTO devices (id,user_id,workspace_id,name,playlist_id,timezone) VALUES ('kir','u',?,'Kiritimati','p1','Pacific/Kiritimati')").run(WS);
  db.prepare("INSERT INTO devices (id,user_id,workspace_id,name,playlist_id,timezone) VALUES ('hnl','u',?,'Honolulu','p1','Pacific/Honolulu')").run(WS);
  db.prepare("INSERT INTO devices (id,user_id,workspace_id,name,playlist_id) VALUES ('nozone','u',?,'Sem fuso','p1')").run(WS);
  db.prepare("INSERT INTO devices (id,user_id,workspace_id,name) VALUES ('alien','u',?,'De outro tenant')").run(OTHER);
});

/*
 * A play, written the way deviceSocket.js writes one: the list's id AND the name it had at that
 * moment. A helper that stamped only the id would test a row shape production never produces.
 */
function play(deviceId, at, opts = {}) {
  const listId = opts.playlist_id === undefined ? 'p1' : opts.playlist_id;
  const listName = listId
    ? (db.prepare('SELECT name FROM playlists WHERE id = ?').get(listId) || {}).name || ''
    : '';
  db.prepare(`INSERT INTO play_logs (device_id, content_id, playlist_id, playlist_name, content_name,
                                     zone_id, started_at, duration_sec, completed)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(deviceId, opts.content_id === undefined ? 'c1' : opts.content_id,
         listId, opts.playlist_name === undefined ? listName : opts.playlist_name,
         opts.name || 'a.mp4', opts.zone_id || null, at, opts.duration || 10,
         opts.completed === undefined ? 1 : opts.completed);
}

test('a play lands on the day the SCREEN was having, not the server', () => {
  /*
   * The instant chosen is 2026-06-01T09:00Z. In Kiritimati (+14) that is already the 1st at 23:00;
   * in Honolulu (-10) it is still the 31st of May at 23:00. One UTC instant, two calendar days,
   * and a report that groups by the server's clock silently picks one of them for both screens.
   */
  const at = Math.floor(Date.UTC(2026, 5, 1, 9, 0, 0) / 1000);
  play('kir', at);
  play('hnl', at);

  const k = deviceTimeline({ workspaceId: WS, deviceId: 'kir', start: '2026-06-01', end: '2026-06-01' });
  const h = deviceTimeline({ workspaceId: WS, deviceId: 'hnl', start: '2026-06-01', end: '2026-06-01' });

  assert.equal(k.totals.plays, 1, 'Kiritimati was already on the 1st');
  assert.equal(k.days[0].date, '2026-06-01');
  assert.equal(k.days[0].items[0].time, '23:00');

  assert.equal(h.totals.plays, 0, 'Honolulu was still on the 31st, so the 1st is empty for it');

  const h31 = deviceTimeline({ workspaceId: WS, deviceId: 'hnl', start: '2026-05-31', end: '2026-05-31' });
  assert.equal(h31.totals.plays, 1);
  assert.equal(h31.days[0].items[0].time, '23:00');
});

test('the window is asked for in the screen\'s days, both ends', () => {
  // A day boundary resolved on the server's clock would cut fourteen hours off one end of a
  // Kiritimati day and add them to the other.
  const [s, e] = dayRange('2026-06-01', 'Pacific/Kiritimati');
  assert.equal(dayKey(s, 'Pacific/Kiritimati'), '2026-06-01');
  assert.equal(dayKey(e, 'Pacific/Kiritimati'), '2026-06-01');
  assert.equal(dayKey(s - 1, 'Pacific/Kiritimati'), '2026-05-31', 'the second before must be the day before');
  assert.equal(dayKey(e + 1, 'Pacific/Kiritimati'), '2026-06-02', 'and the second after, the day after');
});

test('a play with no list reads as unrecorded — never as the list the screen runs now', () => {
  /*
   * This is the whole reason the column was added before the reports were built. The screen below
   * runs p1 today; the play predates the column. Answering "p1" would be a confident lie, and one
   * that gets more wrong every time a screen is reassigned.
   */
  const at = Math.floor(Date.UTC(2026, 5, 2, 9, 0, 0) / 1000);
  play('kir', at, { playlist_id: null });

  const t = deviceTimeline({ workspaceId: WS, deviceId: 'kir', start: '2026-06-02', end: '2026-06-02' });
  const it = t.days[0].items[0];
  assert.equal(it.playlist_id, null);
  assert.equal(it.playlist_name, null);
  assert.equal(it.playlist_deleted, false, 'nothing was deleted; it was never recorded');
  assert.equal(t.totals.unattributed, 1, 'the size of the gap is reported, not hidden');
});

test('a deleted list can still say what it was', () => {
  /*
   * THE REASON play_logs KEEPS THE NAME. The foreign key is SET NULL, so deleting a playlist takes
   * the id off every play it ever made. Without the name stored beside it, a list that ran for a
   * year becomes indistinguishable from a play that never recorded a list at all — and the report
   * would answer "not recorded" for history it recorded perfectly well.
   */
  const at = Math.floor(Date.UTC(2026, 5, 3, 9, 0, 0) / 1000);
  db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name) VALUES ('gone','u',?,'Sumiu')").run(WS);
  play('kir', at, { playlist_id: 'gone' });
  db.prepare("DELETE FROM playlists WHERE id = 'gone'").run();

  const t = deviceTimeline({ workspaceId: WS, deviceId: 'kir', start: '2026-06-03', end: '2026-06-03' });
  const it = t.days[0].items[0];
  assert.equal(t.totals.plays, 1, 'the proof of play outlives the list');
  assert.equal(it.playlist_id, null, 'SET NULL: the play survives, the reference does not');
  assert.equal(it.playlist_name, 'Sumiu', 'the name is what is left, and it is enough');
  assert.equal(it.playlist_deleted, true);
  assert.equal(t.totals.unattributed, 0, 'this one is attributed — just not to a row that exists');
});

test('a renamed list is reported under the name it has now', () => {
  /*
   * The other order round from the case above. The stored name is a fallback, not the answer: an
   * operator searching for a list searches the name it carries today, and a report that insisted
   * on the historical one would look like a different list entirely.
   */
  const at = Math.floor(Date.UTC(2026, 5, 6, 9, 0, 0) / 1000);
  db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name) VALUES ('ren','u',?,'Nome antigo')").run(WS);
  play('kir', at, { playlist_id: 'ren' });
  db.prepare("UPDATE playlists SET name = 'Nome novo' WHERE id = 'ren'").run();

  const t = deviceTimeline({ workspaceId: WS, deviceId: 'kir', start: '2026-06-06', end: '2026-06-06' });
  assert.equal(t.days[0].items[0].playlist_name, 'Nome novo');
  assert.equal(t.days[0].items[0].playlist_deleted, false);
});

test('two deleted lists do not merge into one', () => {
  // Both lost their id to SET NULL. Grouping on the id alone would pour them — and every
  // unrecorded play in the window — into a single nameless row.
  const at = Math.floor(Date.UTC(2026, 5, 7, 9, 0, 0) / 1000);
  for (const [id, name] of [['d1', 'Excluída A'], ['d2', 'Excluída B']]) {
    db.prepare('INSERT INTO playlists (id,user_id,workspace_id,name) VALUES (?,?,?,?)').run(id, 'u', WS, name);
  }
  play('kir', at, { playlist_id: 'd1' });
  play('kir', at + 60, { playlist_id: 'd2' });
  play('kir', at + 120, { playlist_id: null });
  db.prepare("DELETE FROM playlists WHERE id IN ('d1','d2')").run();

  const t = deviceTimeline({ workspaceId: WS, deviceId: 'kir', start: '2026-06-07', end: '2026-06-07' });
  const names = t.days[0].lists.map((l) => l.playlist_name);
  // Sorted through String() because a default sort puts null after every letter.
  assert.deepEqual(names.slice().sort((x, y) => String(x).localeCompare(String(y))),
    ['Excluída A', 'Excluída B', null]);
  assert.equal(t.totals.unattributed, 1, 'only the one that can name nothing');
  assert.equal(t.totals.distinct_lists, 2);
});

test('days carry their own per-list totals', () => {
  const base = Math.floor(Date.UTC(2026, 5, 4, 9, 0, 0) / 1000);
  play('kir', base, { playlist_id: 'p1', duration: 10 });
  play('kir', base + 60, { playlist_id: 'p1', duration: 20 });
  play('kir', base + 120, { playlist_id: 'p2', duration: 5, content_id: 'c2', name: 'b.mp4' });

  const t = deviceTimeline({ workspaceId: WS, deviceId: 'kir', start: '2026-06-04', end: '2026-06-04' });
  const day = t.days[0];
  assert.equal(day.plays, 3);
  assert.equal(day.seconds, 35);
  assert.deepEqual(day.lists.map((l) => [l.playlist_name, l.plays, l.seconds]),
    [['Manhã', 2, 30], ['Tarde', 1, 5]], 'busiest list first');
  assert.equal(t.totals.distinct_files, 2);
  assert.equal(t.totals.distinct_lists, 2);
});

test('another workspace cannot read the screen, and is not told it exists', () => {
  // Same 404 for "no such device" and "not yours": distinguishing them confirms an id.
  assert.equal(deviceTimeline({ workspaceId: WS, deviceId: 'alien' }), null);
  assert.equal(deviceTimeline({ workspaceId: OTHER, deviceId: 'kir' }), null);
  assert.equal(deviceTimeline({ workspaceId: WS, deviceId: 'does-not-exist' }), null);
  assert.equal(deviceTimeline({ workspaceId: null, deviceId: 'kir' }), null,
    'no workspace means no rows, not every row');
});

test('a screen with no zone is rendered in one, and says so', () => {
  const z = zoneFor({ timezone: null, reported_timezone: null });
  assert.equal(z.tz, 'UTC');
  assert.equal(z.assumed, true, 'an unlabelled wrong clock is worse than a labelled one');

  const t = deviceTimeline({ workspaceId: WS, deviceId: 'nozone', start: '2026-06-01', end: '2026-06-01' });
  assert.equal(t.timezone_assumed, true);
});

test('an invalid zone override does not throw a report', () => {
  // A typo in an operator override reaches this code as a RangeError out of Intl, which would
  // fail the page rather than the field that caused it.
  const z = zoneFor({ timezone: 'America/Sao_Paolo', reported_timezone: null }); // note the typo
  assert.equal(z.tz, 'UTC');
  assert.equal(z.assumed, true);
});

test('too many rows truncates, and admits it', () => {
  const base = Math.floor(Date.UTC(2026, 5, 5, 0, 0, 0) / 1000);
  const ins = db.prepare(`INSERT INTO play_logs (device_id, content_id, playlist_id, content_name, started_at, duration_sec)
                          VALUES ('kir','c1','p1','a.mp4',?,10)`);
  const many = db.transaction((n) => { for (let i = 0; i < n; i++) ins.run(base + i); });
  many(30);

  const t = deviceTimeline({ workspaceId: WS, deviceId: 'kir', start: '2026-06-05', end: '2026-06-05', limit: 10 });
  assert.equal(t.totals.plays, 10);
  assert.equal(t.truncated, true, 'the page must be able to say the list is partial');
  assert.equal(t.limit, 10);

  // And the cap cannot be argued upward from the query string.
  const greedy = deviceTimeline({ workspaceId: WS, deviceId: 'kir', start: '2026-06-05', end: '2026-06-05', limit: 999999 });
  assert.equal(greedy.limit, MAX_ROWS);
});

test('the page reads newest first; the export reads in the order it happened', () => {
  const flat = deviceTimelineRows({ workspaceId: WS, deviceId: 'kir', start: '2026-06-04', end: '2026-06-04' });
  const ats = flat.rows.map((r) => r.at);
  assert.deepEqual([...ats].sort((a, b) => a - b), ats, 'a CSV of proof of play reads forwards');

  const page = deviceTimeline({ workspaceId: WS, deviceId: 'kir', start: '2026-06-04', end: '2026-06-04' });
  const pageAts = page.days[0].items.map((i) => i.at);
  assert.deepEqual([...pageAts].sort((a, b) => b - a), pageAts, 'the page opens on the most recent');
});

test('no window means the screen\'s today, not the server\'s', () => {
  const t = deviceTimeline({ workspaceId: WS, deviceId: 'kir' });
  assert.equal(t.window.start, dayKey(Math.floor(Date.now() / 1000), 'Pacific/Kiritimati'));
  assert.equal(t.window.end, t.window.start);
});

test('a play still on screen has no duration yet — and that is not zero', () => {
  /*
   * duration_sec is written when the play ENDS. Rendering the gap as "0s" says the opposite of
   * what is true: that the item appeared and vanished. Seen on a live screen, where the topmost
   * row is always the item currently on air.
   */
  const at = Math.floor(Date.UTC(2026, 5, 20, 9, 0, 0) / 1000);
  db.prepare(`INSERT INTO play_logs (device_id, content_id, playlist_id, playlist_name, content_name, started_at, duration_sec)
              VALUES ('kir','c1','p1','Manhã','a.mp4',?,NULL)`).run(at);
  db.prepare(`INSERT INTO play_logs (device_id, content_id, playlist_id, playlist_name, content_name, started_at, duration_sec)
              VALUES ('kir','c1','p1','Manhã','a.mp4',?,12)`).run(at - 60);

  const t = deviceTimeline({ workspaceId: WS, deviceId: 'kir', start: '2026-06-20', end: '2026-06-20' });
  assert.equal(t.days[0].items[0].duration_sec, null, 'unknown, not zero');
  assert.equal(t.days[0].items[1].duration_sec, 12);

  // And the unknown one must not poison the arithmetic around it.
  assert.equal(t.days[0].seconds, 12);
  assert.equal(t.totals.seconds, 12);
  assert.equal(t.totals.plays, 2, 'it still played, whatever its duration turns out to be');
});

test('widgets are counted as themselves, not silently dropped', () => {
  /*
   * "Arquivos distintos: 1" on a screen with 739 plays reads as a fault. It was not: the other
   * 738 were the clock, the news, the weather and the football — widgets, which carry a widget_id
   * and no content_id, so a count keyed on files sees one thing.
   */
  const at = Math.floor(Date.UTC(2026, 5, 21, 9, 0, 0) / 1000);
  db.prepare("INSERT INTO widgets (id,user_id,workspace_id,name,widget_type) VALUES ('w1','u',?,'Relógio','clock')").run(WS);
  db.prepare("INSERT INTO widgets (id,user_id,workspace_id,name,widget_type) VALUES ('w2','u',?,'Notícias','news')").run(WS);
  const ins = db.prepare(`INSERT INTO play_logs (device_id, content_id, widget_id, playlist_id, playlist_name, content_name, started_at, duration_sec)
                          VALUES ('kir',?,?,'p1','Manhã',?,?,10)`);
  ins.run('c1', null, 'a.mp4', at);
  ins.run(null, 'w1', 'Relógio', at + 60);
  ins.run(null, 'w2', 'Notícias', at + 120);
  ins.run(null, 'w1', 'Relógio', at + 180);

  const t = deviceTimeline({ workspaceId: WS, deviceId: 'kir', start: '2026-06-21', end: '2026-06-21' });
  assert.equal(t.totals.plays, 4);
  assert.equal(t.totals.distinct_files, 1);
  assert.equal(t.totals.distinct_widgets, 2, 'the clock and the news are two things, not none');
});
