'use strict';

/*
 * A sub-list slot that plays shuffled instead of in order.
 *
 * The randomness is baked into the snapshot at PUBLISH time, one permutation per pass, because
 * the rotation has always been flattened there — that is what lets sub-lists work on a player
 * that knows nothing about them. So what has to be true is narrower than "it is random": each
 * pass must be a real permutation, the passes must differ from one another, nothing may be lost
 * or duplicated inside a pass, and the seam between passes must not replay the same item twice.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shuf-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';

const { db } = require('../db/database');
const { expandSnapshot } = require('../lib/sublists');

// A sub-list of five real rows, so subListItems() has something to resolve.
const USER = 'u-shuf';
db.prepare("INSERT INTO users (id, email, password_hash, plan_id) VALUES (?, ?, 'x', 'corporate')").run(USER, USER + '@t.local');
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-s', 'S', ?)").run(USER);
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-s', 'org-s', 'WS')").run();
db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name) VALUES ('sub-a', ?, 'ws-s', 'Rotativa')").run(USER);

const LETTERS = ['a', 'b', 'c', 'd', 'e'];
for (const [i, L] of LETTERS.entries()) {
  db.prepare("INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, duration_sec) VALUES (?,?, 'ws-s', ?, ?, 'video/mp4', 5)")
    .run('c-' + L, USER, L + '.mp4', L + '.mp4');
  db.prepare("INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES ('sub-a', ?, ?, 5)").run('c-' + L, i);
}

const slot = (order) => ([{ _iid: 1, sub_playlist_id: 'sub-a', sub_order: order, zone_id: null }]);

/*
 * The expansion, cut back into complete cycles.
 *
 * Each PASS emits one item per slot, so a slot's picks arrive as a flat run and one full cycle of
 * the sub-list is poolSize consecutive picks. Getting this wrong is easy and was: the first
 * version of this file assumed a pass emitted the whole sub-list.
 */
function passes(out, size = LETTERS.length) {
  const names = out.map((o) => o.filename.replace('.mp4', ''));
  const chunks = [];
  for (let i = 0; i < names.length; i += size) chunks.push(names.slice(i, i + size));
  return chunks;
}

test('sequential is untouched: one cycle, in order', () => {
  /*
   * The default, and what every slot that exists today already does. The LCM shortcut caps the
   * window at one full cycle, because a second would be the identical pattern again.
   */
  const out = expandSnapshot(slot('sequence'), { rounds: 10 });
  assert.deepEqual(passes(out), [LETTERS]);
});

test('an absent sub_order behaves exactly like sequence', () => {
  // Rows written before the column existed carry the default; a slot from the API may omit it.
  const out = expandSnapshot([{ _iid: 1, sub_playlist_id: 'sub-a', zone_id: null }], { rounds: 10 });
  assert.deepEqual(passes(out), [LETTERS]);
});

test('every shuffled pass contains each item exactly once', () => {
  /*
   * The failure that matters more than the ordering: a shuffle that drops an item means a paying
   * advertiser's clip silently stops appearing in some rotations, which nobody reports as a bug
   * because the loop still looks busy.
   */
  const out = expandSnapshot(slot('random'), { rounds: 10 });
  for (const pass of passes(out)) {
    assert.deepEqual([...pass].sort(), [...LETTERS].sort(), 'a pass must be a permutation, not a sample');
  }
});

test('the passes are not all the same permutation', () => {
  /*
   * Shuffling once and repeating it is the easy mistake here, and it looks random for the first
   * two minutes. Run the whole expansion a few times: a correct shuffle produces more than one
   * distinct pass essentially always, so a single distinct order across all of them is a bug and
   * not bad luck. (Five items = 120 orders; the odds of 10 identical passes are astronomical.)
   */
  const distinct = new Set(passes(expandSnapshot(slot('random'), { rounds: 10 })).map((p) => p.join('')));
  assert.ok(distinct.size > 1, `expected several orders across the passes, got ${distinct.size}`);
});

test('no item plays twice across the seam between passes', () => {
  /*
   * The one artefact that makes a shuffle look broken rather than random: the last item of a pass
   * repeating as the first of the next. Checked over many expansions because it is a
   * probabilistic fault — one run could pass by luck.
   */
  for (let attempt = 0; attempt < 40; attempt++) {
    const names = expandSnapshot(slot('random'), { rounds: 10 }).map((o) => o.filename);
    for (let i = 1; i < names.length; i++) {
      assert.notEqual(names[i], names[i - 1], `"${names[i]}" played twice in a row (attempt ${attempt})`);
    }
  }
});

test('a shuffled slot bakes several COMPLETE cycles, not one', () => {
  /*
   * The trap this exists for. Each pass emits one item per slot, so the default rounds=10 over a
   * ten-item sub-list would be a single permutation — shuffled once at publish and then replayed
   * unchanged for ever, which is not random by any reading. A shuffled slot therefore asks for
   * whole cycles of its own pool rather than accepting `rounds` as-is.
   */
  const rnd = expandSnapshot(slot('random'), { rounds: 10 });
  assert.equal(rnd.length % LETTERS.length, 0, 'the window must end on a cycle boundary');
  assert.ok(rnd.length / LETTERS.length >= 4, `expected at least four cycles, got ${rnd.length / LETTERS.length}`);

  const seq = expandSnapshot(slot('sequence'), { rounds: 10 }).length;
  assert.ok(rnd.length > seq, `shuffled must not be shortened by the LCM (seq=${seq}, rnd=${rnd.length})`);
});

test('every baked cycle is a different order', () => {
  /*
   * Four cycles of the same permutation would satisfy the count above and still look exactly like
   * the bug it is meant to catch.
   */
  const distinct = new Set(passes(expandSnapshot(slot('random'), { rounds: 10 })).map((c) => c.join('')));
  assert.ok(distinct.size >= 3, `four cycles should rarely repeat; got ${distinct.size} distinct`);
});

test('the window stays inside the snapshot ceiling, ending on a whole cycle', () => {
  /*
   * Truncating mid-permutation would drop an item from the last cycle — the one failure a shuffle
   * must never have — so the budget is computed before emitting rather than cut afterwards.
   */
  const wide = Array.from({ length: 8 }, (_, i) => ({ _iid: i, sub_playlist_id: 'sub-a', sub_order: 'random', zone_id: null }));
  const out = expandSnapshot(wide, { rounds: 10, maxItems: 120 });
  assert.ok(out.length <= 120, `ceiling honoured, got ${out.length}`);
  assert.equal((out.length / wide.length) % LETTERS.length, 0, 'must stop on a cycle boundary');
});

test('a one-item sub-list does not hang or throw on the no-repeat rule', () => {
  // With one item the repeat is unavoidable; the guard must give up rather than loop forever.
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name) VALUES ('sub-one', ?, 'ws-s', 'Uma')").run(USER);
  db.prepare("INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES ('sub-one', 'c-a', 0, 5)").run();
  const out = expandSnapshot([{ _iid: 9, sub_playlist_id: 'sub-one', sub_order: 'random', zone_id: null }], { rounds: 5 });
  assert.ok(out.length >= 1);
  assert.ok(out.every((o) => o.filename === 'a.mp4'));
});

test('sub_order never reaches the player', () => {
  /*
   * The expansion is already done by the time the snapshot is built, so the field describes a
   * decision the device has no part in. It is an editor concern and it stays server-side.
   */
  for (const o of expandSnapshot(slot('random'), { rounds: 3 })) {
    assert.ok(!('sub_order' in o), 'sub_order must be stripped before the wire');
    assert.ok(!('_iid' in o));
  }
});

test('two slots on the same sub-list shuffle independently', () => {
  /*
   * Shuffle is a property of the slot. Two slots sharing one sub-list must not share a queue, or
   * the second slot would pick up where the first left off and the two would interleave into
   * something neither of them asked for.
   */
  const out = expandSnapshot([
    { _iid: 1, sub_playlist_id: 'sub-a', sub_order: 'random', zone_id: null },
    { _iid: 2, sub_playlist_id: 'sub-a', sub_order: 'random', zone_id: null },
  ], { rounds: 6 });
  // Two picks per pass, one per slot, and the window is whole cycles of the pool.
  assert.equal(out.length % (2 * LETTERS.length), 0, 'the window must end on a cycle boundary');

  // Split the interleaved output back into each slot's own run.
  const slotA = out.filter((_, i) => i % 2 === 0).map((o) => o.filename);
  const slotB = out.filter((_, i) => i % 2 === 1).map((o) => o.filename);

  // Each slot must see complete cycles of its own — a shared queue would give each slot half a
  // permutation and the two would interleave into something neither asked for.
  for (const run of [slotA, slotB]) {
    for (let i = 0; i < run.length; i += LETTERS.length) {
      const cycle = run.slice(i, i + LETTERS.length).sort();
      assert.deepEqual(cycle, LETTERS.map((L) => L + '.mp4').sort(), 'each slot draws whole cycles of its own');
    }
  }
});

test('a sequential slot beside a shuffled one still plays in order', () => {
  // Mixing the two must not make the sequential slot inherit the shuffle.
  const out = expandSnapshot([
    { _iid: 1, sub_playlist_id: 'sub-a', sub_order: 'sequence', zone_id: null },
    { _iid: 2, sub_playlist_id: 'sub-a', sub_order: 'random', zone_id: null },
  ], { rounds: 5 });
  // Slot 1 is sequential, slot 2 shuffled; they alternate in the output, one pick each per pass.
  const seqPicks = out.filter((_, i) => i % 2 === 0).map((o) => o.filename.replace('.mp4', ''));
  for (const [i, name] of seqPicks.entries()) {
    assert.equal(name, LETTERS[i % LETTERS.length], 'the sequential slot walks the pool in order');
  }
});
