'use strict';

/*
 * How the player frames a source whose aspect does not match the panel.
 *
 * Fullscreen playback used object-fit:contain everywhere. That never crops, but it leaves black
 * bars whenever the aspects differ at all — a 16:9 video on a 16:10 panel got bars for the sake of
 * a few per cent.
 *
 * Blanket `cover` is not the answer either, and a real library proves why: this customer holds
 * 1920x1080 alongside 1080x1920 and 608x1080. A portrait video covered onto a landscape panel
 * keeps a horizontal slice about a third of its height, and the thing being advertised is usually
 * in the part that goes. Bars are ugly; showing the wrong third of the frame is worse.
 *
 * So the rule is proportional, and these are the cases it has to get right.
 */

const path = require('node:path');
const fs = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const PLAYER = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

// Evaluate the player's own helper rather than a copy of the rule, so this test fails if the
// implementation drifts from what it asserts.
function loadFitFor() {
  const m = PLAYER.match(/const MAX_CROP = [\d.]+;\s*function fitFor\(srcW, srcH, boxW, boxH\) \{[\s\S]*?\n    \}/);
  assert.ok(m, 'fitFor must exist in the player');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0]}; return fitFor;`)();
}

test('a source matching the panel fills it completely', () => {
  const fitFor = loadFitFor();
  assert.equal(fitFor(1920, 1080, 1920, 1080), 'cover', '16:9 on 16:9 must reach every edge');
  assert.equal(fitFor(1080, 1920, 1080, 1920), 'cover', 'portrait on a totem likewise');
  // A near miss is still a fill: bars for a few per cent is what this fixes.
  assert.equal(fitFor(1920, 1080, 1680, 1050), 'cover', '16:9 on 16:10');
  assert.equal(fitFor(1920, 1080, 1712, 1204), 'cover', '16:9 in a 3:2 window');
});

test('a source at odds with the panel is letterboxed, not butchered', () => {
  const fitFor = loadFitFor();
  // Covering these would keep roughly a third of the frame and drop the subject with the rest.
  assert.equal(fitFor(1080, 1920, 1920, 1080), 'contain', 'portrait video on a landscape panel');
  assert.equal(fitFor(608, 1080, 1920, 1080), 'contain', 'the narrow portrait cut this library uses');
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
