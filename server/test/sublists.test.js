'use strict';

// Loop OS sub-lists (lib/sublists.js): a playlist item that points at another playlist and
// contributes one of its items per pass.
//
// The cases that matter are the ones where a plausible implementation is quietly wrong:
//   - each sub-list must advance its OWN cursor. Expanding lcm(sizes) instead is the obvious
//     approach and produces a megabytes-large snapshot for the real playlists this targets.
//   - a playlist with NO sub-lists must not be multiplied by the round count.
//   - nesting must be capped at one level from BOTH directions — A->B and B->C are each fine
//     alone, but together they are A->B->C.
//   - an item may reference exactly one of content / widget / sub-playlist.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-sublist-' + crypto.randomBytes(4).toString('hex'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const {
  SubListError, requireSingleTarget, validateSubList, expandSnapshot,
} = require('../lib/sublists');

const WS = 'ws-sl';
db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES ('u-sl','sl@t.local','x','user')").run();
db.prepare("INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES ('o-sl','Org','u-sl')").run();
db.prepare("INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?, 'o-sl','WS')").run(WS);

function mkPlaylist(id, name) {
  db.prepare("INSERT OR IGNORE INTO playlists (id,user_id,name,workspace_id) VALUES (?, 'u-sl', ?, ?)").run(id, name, WS);
  return id;
}
// Real content rows, so the snapshot query's live/expiry filters are genuinely exercised.
function mkItem(playlistId, label, order) {
  const cid = `c-${label}`;
  db.prepare(`INSERT OR IGNORE INTO content (id,workspace_id,user_id,filename,filepath,mime_type,file_size)
              VALUES (?,?, 'u-sl', ?, ?, 'image/jpeg', 100)`).run(cid, WS, `${label}.jpg`, `${label}.jpg`);
  db.prepare('INSERT INTO playlist_items (playlist_id,content_id,sort_order,duration_sec) VALUES (?,?,?,10)')
    .run(playlistId, cid, order);
  return cid;
}

test('each sub-list advances its own cursor — independently, never the LCM', () => {
  const parent = mkPlaylist('p-main', 'Main');
  const news = mkPlaylist('p-news', 'News');    // 3 items
  const promo = mkPlaylist('p-promo', 'Promo'); // 2 items

  mkItem(news, 'n1', 0); mkItem(news, 'n2', 1); mkItem(news, 'n3', 2);
  mkItem(promo, 'p1', 0); mkItem(promo, 'p2', 1);

  // Parent shape: [static A, <news>, static B, <promo>]
  const items = [
    { content_id: 'c-a', filename: 'a.jpg', sort_order: 0, duration_sec: 10 },
    { sub_playlist_id: news, zone_id: null, sort_order: 1, duration_sec: 10 },
    { content_id: 'c-b', filename: 'b.jpg', sort_order: 2, duration_sec: 10 },
    { sub_playlist_id: promo, zone_id: null, sort_order: 3, duration_sec: 10 },
  ];

  const out = expandSnapshot(items, { rounds: 10 });

  // lcm(3,2) = 6, which is under the 10 requested, so the window shortens to the point where the
  // pattern repeats exactly — both lists end their cycle cleanly and the loop seam is invisible.
  assert.equal(out.length, 6 * 4, 'expected 6 rounds x 4 slots');

  const newsPicks = out.filter(i => i._sub?.playlist_id === news).map(i => i.content_id);
  const promoPicks = out.filter(i => i._sub?.playlist_id === promo).map(i => i.content_id);

  // Each list walks its OWN period: news over 3, promo over 2. They are never locked to a shared
  // step — which is the whole point, and what makes 12 sub-lists tractable.
  assert.deepEqual(newsPicks, ['c-n1', 'c-n2', 'c-n3', 'c-n1', 'c-n2', 'c-n3']);
  assert.deepEqual(promoPicks, ['c-p1', 'c-p2', 'c-p1', 'c-p2', 'c-p1', 'c-p2']);

  // Static items repeat every pass, in place.
  assert.deepEqual(out.map(i => i.content_id).slice(0, 4), ['c-a', 'c-n1', 'c-b', 'c-p1']);
  assert.deepEqual(out.map(i => i.content_id).slice(4, 8), ['c-a', 'c-n2', 'c-b', 'c-p2']);
});

test('a playlist with no sub-lists is returned untouched, never multiplied', () => {
  const items = [
    { content_id: 'c-x', sort_order: 0, duration_sec: 10 },
    { content_id: 'c-y', sort_order: 1, duration_sec: 10 },
  ];
  const out = expandSnapshot(items, { rounds: 10 });
  assert.equal(out.length, 2, 'a plain playlist must not become 20 items');
  assert.equal(out, items, 'and should be the same array — no needless copy');
});

test('an empty sub-list contributes nothing rather than a blank frame', () => {
  const parent = mkPlaylist('p-e', 'Parent');
  mkPlaylist('p-empty', 'Empty');   // deliberately no items
  const items = [
    { content_id: 'c-a', sort_order: 0, duration_sec: 10 },
    { sub_playlist_id: 'p-empty', sort_order: 1, duration_sec: 10 },
  ];
  const out = expandSnapshot(items, { rounds: 5 });
  assert.equal(out.length, 1, 'the empty slot is skipped, not rendered as a black frame');
  assert.equal(out[0].content_id, 'c-a');
});

test('a resumed cursor is normalised against the CURRENT sub-list size', () => {
  const news = 'p-news'; // 3 items, from the first test
  // Device saved cursor 7 against a list that has since become 3 long: 7 % 3 = 1.
  const items = [{ sub_playlist_id: news, sort_order: 0, duration_sec: 10 }];
  const out = expandSnapshot(items, { rounds: 1, startCursors: { [news]: 7 } });
  assert.equal(out[0].content_id, 'c-n2', 'must resume in range, not run off the end');
});

test('many co-prime sub-lists fall back to the round cap instead of their LCM', () => {
  // lcm(5,7,9,11) = 3465. Expanding to that is exactly the blow-up this design refuses; the
  // window must clamp to `rounds` and the LCM computation must not be what decides it.
  const sizes = [5, 7, 9, 11];
  const ids = sizes.map((n, i) => {
    const id = mkPlaylist(`p-cop${i}`, `Coprime ${n}`);
    for (let k = 0; k < n; k++) mkItem(id, `cop${i}_${k}`, k);
    return id;
  });
  const items = ids.map((id) => ({ sub_playlist_id: id, sort_order: 0, duration_sec: 10 }));

  const out = expandSnapshot(items, { rounds: 10, maxItems: 100000 });

  assert.equal(out.length, 10 * 4, 'must be 10 rounds, not lcm(5,7,9,11)=3465');
});

test('expansion is capped so a wide playlist cannot build an undeliverable snapshot', () => {
  const news = 'p-news';
  const items = Array.from({ length: 10 }, () => ({ sub_playlist_id: news, sort_order: 0, duration_sec: 10 }));
  const out = expandSnapshot(items, { rounds: 10, maxItems: 12 });
  assert.ok(out.length <= 12, `expected <= 12, got ${out.length}`);
});

test('an item may reference exactly one of content / widget / sub-playlist', () => {
  assert.equal(requireSingleTarget({ content_id: 'c' }), 'content_id');
  assert.equal(requireSingleTarget({ sub_playlist_id: 'p' }), 'sub_playlist_id');
  assert.throws(() => requireSingleTarget({}), SubListError, 'nothing set must be rejected');
  // The ambiguous row is the dangerous one: the snapshot's COALESCE would silently pick one.
  assert.throws(() => requireSingleTarget({ content_id: 'c', sub_playlist_id: 'p' }), SubListError);
  assert.throws(() => requireSingleTarget({ content_id: 'c', widget_id: 'w' }), SubListError);
});

test('nesting is capped at one level, from both directions', () => {
  const a = mkPlaylist('n-a', 'A');
  const b = mkPlaylist('n-b', 'B');
  const c = mkPlaylist('n-c', 'C');

  // A playlist cannot contain itself.
  assert.throws(() => validateSubList(a, a, WS), /cannot contain itself/);

  // B -> C is fine while B is nobody's sub-list.
  assert.doesNotThrow(() => validateSubList(b, c, WS));
  db.prepare('INSERT INTO playlist_items (playlist_id,sub_playlist_id,sort_order,duration_sec) VALUES (?,?,0,10)').run(b, c);

  // Now A -> B would be A->B->C. Rejected because the CHILD already has sub-lists.
  assert.throws(() => validateSubList(a, b, WS), /nesting is limited to one level/);

  // And the other direction: make C someone's sub-list, then try to give C a sub-list of its own.
  const d = mkPlaylist('n-d', 'D');
  assert.throws(() => validateSubList(c, d, WS), /already used as a sub-list/,
    'C is used as a sub-list of B, so it must not gain sub-lists itself');
});

test('a sub-list from another workspace is refused', () => {
  db.prepare("INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES ('ws-other','o-sl','Other')").run();
  db.prepare("INSERT OR IGNORE INTO playlists (id,user_id,name,workspace_id) VALUES ('p-foreign','u-sl','Foreign','ws-other')").run();
  const parent = mkPlaylist('p-tenant', 'Tenant');
  assert.throws(() => validateSubList(parent, 'p-foreign', WS), /not in this playlist's workspace/);
});

test('resolved sub-items carry provenance so a player can resume and report', () => {
  const items = [{ sub_playlist_id: 'p-news', sort_order: 0, duration_sec: 10 }];
  const out = expandSnapshot(items, { rounds: 3 });
  assert.equal(out.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(out[i]._sub.playlist_id, 'p-news');
    assert.equal(out[i]._sub.cursor, i, 'cursor identifies which sub-item this pass resolved to');
    assert.equal(out[i]._sub.size, 3);
    assert.equal(out[i]._sub.round, i);
  }
  // The internal join key must never reach a device.
  assert.ok(out.every(i => i._iid === undefined), '_iid must be stripped from the snapshot');
});
