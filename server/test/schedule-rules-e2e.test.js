'use strict';

/*
 * Typed rules, driven through the real database and the real payload path.
 *
 * The sibling file schedule-rules-wiring.test.js reads the source and checks the calls are there;
 * this one puts rows in a table and asks what a player would actually receive. Both are worth
 * having — a call in the right place can still hand over the wrong thing.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srules-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';

const { db } = require('../db/database');
const { v4: uuid } = require('uuid');
const { __test: plTest } = require('../routes/playlists');
const { isItemActiveNow } = require('../lib/schedule-eval');
const { sweepHorizon, horizonEndOf } = require('../services/schedule-horizon');

db.prepare("INSERT INTO users (id,email,password_hash,name,role) VALUES ('u1','a@b.c','x','A','admin')").run();
db.prepare("INSERT INTO content (id,user_id,filename,filepath,mime_type) VALUES ('c1','u1','campanha.mp4','/x','video/mp4')").run();
db.prepare("INSERT INTO playlists (id,user_id,name,status) VALUES ('p1','u1','Lista A','published')").run();
const item = db.prepare("INSERT INTO playlist_items (playlist_id,content_id,sort_order,duration_sec) VALUES ('p1','c1',0,10)").run().lastInsertRowid;

function setRules(rules) {
  db.prepare("DELETE FROM content_schedule_rules WHERE content_id = 'c1'").run();
  const ins = db.prepare('INSERT INTO content_schedule_rules (id,content_id,type,params,sort_order) VALUES (?,?,?,?,?)');
  rules.forEach((r, i) => {
    const { type, ...params } = r;
    ins.run(uuid(), 'c1', type, JSON.stringify(params), i);
  });
}

function blocksForItem() {
  return plTest.schedulesFor(item, 'c1', null);
}

test('a rule stored on the file comes out of the payload path as blocks', () => {
  setRules([{ type: 'weekday', day: 1 }, { type: 'time_range', start: '09:00', end: '18:00' }]);
  const blocks = blocksForItem();
  assert.ok(blocks.length, 'the payload must carry the compiled schedule');

  // 2026-03-09 is a Monday, 2026-03-10 a Tuesday.
  assert.equal(isItemActiveNow(blocks, new Date(Date.UTC(2026, 2, 9, 12, 0)), 'UTC'), true);
  assert.equal(isItemActiveNow(blocks, new Date(Date.UTC(2026, 2, 9, 20, 0)), 'UTC'), false);
  assert.equal(isItemActiveNow(blocks, new Date(Date.UTC(2026, 2, 10, 12, 0)), 'UTC'), false);
});

test('day of the month reaches the player, which is what the block format could not express', () => {
  setRules([{ type: 'day_of_month', day: 1 }]);
  const blocks = blocksForItem();

  /*
   * A date in the FUTURE, computed from the clock. The expansion starts at today, so a hardcoded
   * date silently falls out of the horizon as the calendar moves and the test starts asserting
   * nothing (or failing for a reason that has nothing to do with the code).
   */
  const now = new Date();
  const firstNextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 10, 0);
  const secondNextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 2, 10, 0);
  assert.equal(isItemActiveNow(blocks, new Date(firstNextMonth), 'UTC'), true);
  assert.equal(isItemActiveNow(blocks, new Date(secondNextMonth), 'UTC'), false);
});

test('the blocks handed to a player use only the keys its parser reads', () => {
  /*
   * PlaylistController.parseSchedules reads days/start/end/start_date/end_date and drops anything
   * else without a word. A key added here would not fail — it would quietly not apply.
   */
  setRules([{ type: 'month', month: 1 }, { type: 'time_range', start: '08:00', end: '12:00' }]);
  for (const b of blocksForItem()) {
    assert.deepEqual(Object.keys(b).sort(), ['days', 'end', 'end_date', 'start', 'start_date']);
  }
});

test('an older block schedule and a new rule both survive on the same file', () => {
  // Blocks OR, so the union is the right join; losing either source would silently unschedule work.
  setRules([{ type: 'weekday', day: 1 }]);
  db.prepare(
    "INSERT INTO content_schedules (id,content_id,active_days,start_time,end_time,sort_order) VALUES (?,?,?,?,?,?)"
  ).run(uuid(), 'c1', '6', '10:00', '14:00', 0);

  const blocks = blocksForItem();
  // Monday from the rule, Saturday from the legacy block.
  assert.equal(isItemActiveNow(blocks, new Date(Date.UTC(2026, 2, 9, 12, 0)), 'UTC'), true);
  assert.equal(isItemActiveNow(blocks, new Date(Date.UTC(2026, 2, 14, 12, 0)), 'UTC'), true);
  assert.equal(isItemActiveNow(blocks, new Date(Date.UTC(2026, 2, 14, 16, 0)), 'UTC'), false);
  db.prepare("DELETE FROM content_schedules WHERE content_id = 'c1'").run();
});

test('a file with no schedule at all still plays', () => {
  setRules([]);
  assert.deepEqual(blocksForItem(), []);
  assert.equal(isItemActiveNow([], new Date(), 'UTC'), true);
});

// ---- the horizon sweep -----------------------------------------------------------------------------

/*
 * What ages is the snapshot a device is HOLDING, not what the server would compute today — the
 * first version of the sweep recompiled from the current date, always saw a full horizon, and so
 * would never have fired at all. These tests move the publish timestamp rather than the clock,
 * because that is the thing the decision actually rests on.
 */
const DAY = 24 * 60 * 60 * 1000;
function publishedDaysAgo(days) {
  db.prepare("UPDATE playlists SET status = 'published', updated_at = ? WHERE id = 'p1'")
    .run(Math.floor((Date.now() - days * DAY) / 1000));
}

test('a weekly rule is never considered stale, because it cannot run out', () => {
  // Its blocks carry no date bounds, so however old the snapshot is, nothing has expired.
  setRules([{ type: 'weekday', day: 3 }]);
  assert.equal(horizonEndOf([{ type: 'weekday', day: 3 }], '2026-03-10'), null);
  publishedDaysAgo(1000);
  assert.deepEqual(sweepHorizon(null).republished, [], 'nothing to refresh');
});

test('a dated rule is refreshed only once its expansion is nearly used up', () => {
  setRules([{ type: 'day_of_month', day: 1 }]);

  publishedDaysAgo(30);
  assert.deepEqual(sweepHorizon(null).republished, [], 'a fresh publish is not due');

  // Past the 18-month horizon minus the six-month margin, the cached window is running out.
  publishedDaysAgo(400);
  assert.deepEqual(sweepHorizon(null).republished, ['p1'], 'due, and exactly one playlist');
});

test('a draft playlist is never republished by the sweep', () => {
  // Publishing someone's unfinished list because a horizon moved is a worse surprise than a stale
  // window on a list nobody is serving.
  setRules([{ type: 'day_of_month', day: 1 }]);
  publishedDaysAgo(400);
  db.prepare("UPDATE playlists SET status = 'draft' WHERE id = 'p1'").run();
  assert.deepEqual(sweepHorizon(null).republished, []);
  db.prepare("UPDATE playlists SET status = 'published' WHERE id = 'p1'").run();
});
