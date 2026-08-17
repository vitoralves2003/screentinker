'use strict';

/*
 * How the player frames a source whose aspect does not match the panel exactly.
 *
 * Fullscreen playback used object-fit:contain everywhere. That never crops, but it leaves black
 * bars whenever the aspects differ at all — a 16:9 video on a 16:10 panel got bars for the sake of
 * a few per cent, on a screen the operator chose that video FOR.
 *
 * SAME ORIENTATION FILLS, whatever the exact ratio. OPPOSITE ORIENTATION DOES NOT: that pairing is
 * not supposed to happen — vertical content goes on vertical screens — so when it appears it is a
 * mistake, and covering it would keep a horizontal slice of a portrait frame and drop whatever was
 * being advertised. Letterboxing makes the mistake visible instead of cropping the message away
 * silently, which is the right behaviour for an accident nobody is watching.
 */

const path = require('node:path');
const fs = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const PLAYER = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

// Evaluate the player's own helper rather than a copy of the rule, so this test fails if the
// implementation drifts from what it asserts.
function loadFitFor() {
  // Sliced by index rather than by regex: the body contains braces and regex metacharacters, and
  // a pattern spanning them is one escaping slip away from silently matching nothing.
  const start = PLAYER.indexOf('function fitFor(srcW, srcH, boxW, boxH) {');
  assert.notEqual(start, -1, 'fitFor must exist in the player');
  const end = PLAYER.indexOf('\n    }', start);
  assert.notEqual(end, -1, 'fitFor must be closed at its own indent level');
  const m = [PLAYER.slice(start, end + 6)];
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0]}; return fitFor;`)();
}

test('a correctly-oriented source fills the panel, whatever the exact ratio', () => {
  const fitFor = loadFitFor();
  // Every one of these is a screen somebody chose this video for. None of them may show bars.
  assert.equal(fitFor(1920, 1080, 1920, 1080), 'cover', '16:9 on 16:9');
  assert.equal(fitFor(1920, 1080, 1680, 1050), 'cover', '16:9 on 16:10');
  assert.equal(fitFor(1920, 1080, 1712, 1204), 'cover', '16:9 in a 3:2 window');
  assert.equal(fitFor(1920, 1080, 1400, 1050), 'cover', '16:9 on 4:3');
  assert.equal(fitFor(1920, 1080, 1280, 1024), 'cover', '16:9 on 5:4 — the ratio a crop cap refused');
  assert.equal(fitFor(1080, 1920, 1080, 1920), 'cover', 'portrait on a totem');
  assert.equal(fitFor(608, 1080, 1080, 1920), 'cover', 'the narrow portrait cut this library uses');
});

test('a mis-oriented source is letterboxed, not butchered', () => {
  const fitFor = loadFitFor();
  // Not supposed to happen. When it does, covering keeps roughly a third of the frame and drops
  // the subject with the rest — bars are how the mistake stays visible.
  assert.equal(fitFor(1080, 1920, 1920, 1080), 'contain', 'portrait video on a landscape panel');
  assert.equal(fitFor(608, 1080, 1920, 1080), 'contain', 'the narrow portrait cut on a TV');
  assert.equal(fitFor(1920, 1080, 1080, 1920), 'contain', 'landscape video on a totem');
});

test('an unknown source size never crops', () => {
  const fitFor = loadFitFor();
  // videoWidth is 0 until metadata arrives and naturalWidth is 0 until the bytes decode. Guessing
  // `cover` there would crop a frame whose shape is not yet known.
  for (const args of [[0, 0, 1920, 1080], [1920, 1080, 0, 0], [null, null, 1920, 1080]]) {
    assert.equal(fitFor(...args), 'contain', `unknown dimensions must not crop: ${JSON.stringify(args)}`);
  }
});

test('both fullscreen mounts ask for the decision', () => {
  // Images decide on load, video on loadedmetadata — the two moments the natural size is known.
  assert.match(PLAYER, /applyFit\(img, img\.naturalWidth, img\.naturalHeight\)/);
  assert.match(PLAYER, /applyFit\(video, video\.videoWidth, video\.videoHeight\)/);
  assert.match(PLAYER, /addEventListener\('loadedmetadata'/, 'video size is only known then');
});
