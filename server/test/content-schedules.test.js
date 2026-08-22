'use strict';

/*
 * When a file may play — the display rule attached to the CONTENT rather than to a list entry.
 *
 * It lived on the playlist item, which put it in the wrong hands. Whoever uploads the December
 * campaign knows it runs to the 24th; whoever assembles a playlist often does not and has to be
 * told. Worse, the same file in three lists needed the rule entered three times, with nothing
 * stopping the three from disagreeing with each other.
 *
 * NOTHING CHANGES ON THE WIRE. The player has always read a `schedules` array off each assignment
 * and evaluated the blocks in its own local time. All that moved is where the server reads them
 * from, which is why this reaches every panel in the field without an APK — the same reasoning as
 * the sound switch and the zone map.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csched-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';

const { db } = require('../db/database');
const { v4: uuid } = require('uuid');
const { __test: plTest } = require('../routes/playlists');

db.prepare("INSERT INTO users (id,email,password_hash,name,role) VALUES ('u1','a@b.c','x','A','admin')").run();
db.prepare("INSERT INTO content (id,user_id,filename,filepath,mime_type) VALUES ('c1','u1','natal.mp4','/x','video/mp4')").run();
db.prepare("INSERT INTO playlists (id,user_id,name) VALUES ('p1','u1','Lista A')").run();
db.prepare("INSERT INTO playlists (id,user_id,name) VALUES ('p2','u1','Lista B')").run();
const itemA = db.prepare("INSERT INTO playlist_items (playlist_id,content_id,sort_order,duration_sec) VALUES ('p1','c1',0,10)").run().lastInsertRowid;
const itemB = db.prepare("INSERT INTO playlist_items (playlist_id,content_id,sort_order,duration_sec) VALUES ('p2','c1',0,10)").run().lastInsertRowid;

function setContentBlocks(rows) {
  db.prepare("DELETE FROM content_schedules WHERE content_id = 'c1'").run();
  const ins = db.prepare(
    'INSERT INTO content_schedules (id,content_id,active_days,start_time,end_time,start_date,end_date,sort_order) VALUES (?,?,?,?,?,?,?,?)');
  rows.forEach((r, i) => ins.run(uuid(), 'c1', r.days, r.start, r.end, r.start_date || null, r.end_date || null, i));
}

test('the rule set once on the file reaches EVERY list holding it', () => {
  setContentBlocks([{ days: '1,2,3,4,5', start: '08:00', end: '18:00' }]);

  for (const [playlist, label] of [['p1', 'Lista A'], ['p2', 'Lista B']]) {
    const items = plTest.buildSnapshotItems(playlist);
    assert.deepEqual(items[0].schedules, [{
      days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00', start_date: null, end_date: null,
    }], `${label} must carry the file's rule without anyone re-entering it`);
  }
});

test('no rule means always on — an empty list must not become "never"', () => {
  setContentBlocks([]);
  const items = plTest.buildSnapshotItems('p1');
  assert.equal(items[0].schedules, undefined,
    'the absence of the field is what the player reads as unrestricted');
});

test("a booking on the ITEM still wins, because a booking is not a property of the file", () => {
  /*
   * The agency API creates an item together with its own window. Two agencies booking the same
   * clip for different fortnights is the ordinary case, so collapsing item blocks into the file
   * would quietly redefine what a booking means. Most specific wins.
   */
  setContentBlocks([{ days: '1,2,3,4,5', start: '08:00', end: '18:00' }]);
  db.prepare(`INSERT INTO playlist_item_schedules (id,playlist_item_id,active_days,start_time,end_time,start_date,end_date,sort_order)
              VALUES (?,?,'6','10:00','14:00','2026-12-01','2026-12-24',0)`).run(uuid(), itemA);

  const booked = plTest.buildSnapshotItems('p1');
  assert.deepEqual(booked[0].schedules[0].days, [6], 'the item overrides for the list that booked it');
  assert.equal(booked[0].schedules[0].end_date, '2026-12-24');

  const other = plTest.buildSnapshotItems('p2');
  assert.deepEqual(other[0].schedules[0].days, [1, 2, 3, 4, 5],
    'and the other list still gets the file rule — the override is per booking, not global');

  db.prepare('DELETE FROM playlist_item_schedules WHERE playlist_item_id = ?').run(itemA);
});

test('the wire shape is unchanged, which is why no panel needs updating', () => {
  setContentBlocks([{ days: '0,6', start: '00:00', end: '24:00' }]);
  const [item] = plTest.buildSnapshotItems('p1');
  const [block] = item.schedules;
  assert.deepEqual(Object.keys(block).sort(), ['days', 'end', 'end_date', 'start', 'start_date']);
  assert.ok(Array.isArray(block.days) && block.days.every(Number.isInteger),
    'days is a numeric array, as the shared evaluator expects');
  assert.equal(item._iid, undefined, 'the internal row id never leaves the server');
});

test('deleting the file takes its rule with it', () => {
  setContentBlocks([{ days: '1', start: '09:00', end: '10:00' }]);
  db.prepare("DELETE FROM playlist_items WHERE content_id = 'c1'").run();
  db.prepare("DELETE FROM content WHERE id = 'c1'").run();
  assert.equal(db.prepare("SELECT COUNT(*) c FROM content_schedules WHERE content_id = 'c1'").get().c, 0,
    'ON DELETE CASCADE — an orphan block would be invisible and would apply to nothing');
});

test('cleanup', () => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
