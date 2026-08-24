'use strict';

/*
 * schema.sql has to survive being run against a database that already exists.
 *
 * THE BUG THIS PINS: adding `playlist_id` to play_logs, I also put its index in schema.sql. On a
 * fresh install that is fine. On every existing install it is fatal — schema.sql is exec-ed at
 * boot BEFORE the migrations array, and there `CREATE TABLE IF NOT EXISTS play_logs` is a no-op,
 * so the table still lacks the column when the next statement indexes it. Boot died with
 * "no such column: playlist_id", and the whole server with it.
 *
 * It passed every test that built its database from scratch, which is most of them. What catches
 * it is replaying the actual upgrade: yesterday's schema, then today's on top.
 *
 * The rule: a new column goes in the CREATE TABLE (for fresh installs) AND in the migrations array
 * (for existing ones). Anything that REFERENCES that column — an index, a view, a trigger — belongs
 * only in the migrations array, which runs after the ALTERs.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const CURRENT = fs.readFileSync(path.join(ROOT, 'server', 'db', 'schema.sql'), 'utf8');

/*
 * The schema a server that has not taken this change is running.
 *
 * The previous COMMIT, not HEAD: once the change is committed HEAD is the new schema and the
 * comparison is with itself — green, and checking nothing. Per-commit is also the point at which
 * the mistake is cheap to fix, before it is buried in a branch.
 *
 * Anchoring further back (the merge base with main) surfaces one older instance of the same
 * class that predates this test: schema.sql seeds `plans` with min_devices, a column only the
 * migrations array adds, so a database created before that column aborts schema.sql at line ~42
 * of 702 and skips every table defined after it for one boot. It self-heals on the next restart
 * and every live database is long past it, which is why this is recorded here rather than
 * silently fixed inside an unrelated change.
 */
function committedSchema() {
  for (const rev of ['HEAD~1', 'HEAD']) {
    try {
      return execFileSync('git', ['show', rev + ':server/db/schema.sql'],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    } catch { /* first commit, or not a git checkout: try the next */ }
  }
  return null; // no baseline to upgrade FROM; the tests below skip rather than fail
}

test('today\'s schema applies cleanly on top of the committed one', () => {
  const before = committedSchema();
  if (before === null) return; // nothing to upgrade FROM

  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(before);

  /*
   * The migrations have NOT run at this point, deliberately. That is the exact order the server
   * boots in, and the whole point: schema.sql must be safe on its own.
   */
  assert.doesNotThrow(() => db.exec(CURRENT),
    'schema.sql must not reference anything the migrations have not added yet');
  db.close();
});

test('and the migrations bring that database up to the current columns', () => {
  const before = committedSchema();
  if (before === null) return;

  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(before);
  db.exec(CURRENT);

  /*
   * Applied the way database.js applies them: "duplicate column" and "already exists" are the
   * expected outcome on a database that is already up to date, and the whole point of running the
   * array on every boot is that it is idempotent. Any OTHER failure is a real partial migration,
   * and this is where it should surface rather than in a boot log nobody reads.
   */
  const src = fs.readFileSync(path.join(ROOT, 'server', 'db', 'database.js'), 'utf8');
  const wanted = [
    'ALTER TABLE play_logs ADD COLUMN playlist_id TEXT',
    "ALTER TABLE play_logs ADD COLUMN playlist_name TEXT NOT NULL DEFAULT ''",
    'CREATE INDEX IF NOT EXISTS idx_play_logs_playlist ON play_logs(playlist_id, started_at DESC)',
  ];
  for (const sql of wanted) {
    assert.ok(src.includes(sql), `existing installs get this from the migrations array: ${sql}`);
    try { db.exec(sql); } catch (e) {
      assert.match(e.message, /duplicate column name|already exists/i, sql);
    }
  }

  const cols = db.prepare('PRAGMA table_info(play_logs)').all().map((c) => c.name);
  assert.ok(cols.includes('playlist_id'), 'which list a play came from');
  assert.ok(cols.includes('playlist_name'), 'and what that list was called, for when it is deleted');

  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='play_logs'")
    .all().map((r) => r.name);
  assert.ok(idx.includes('idx_play_logs_playlist'));
  db.close();
});
