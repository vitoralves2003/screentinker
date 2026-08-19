'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ghcrCheck = require('../lib/ghcr-check');

// =========== extractSemverTags ===========

test('extractSemverTags: returns only valid x.y.z semver tags, pre-release suffixes excluded', () => {
  const input = ['latest', '1.9.4', 'v1.9.4', '1.9.4-beta', '1.10.0', '2.0.0-rc1', '1.0.0-alpha'];
  const result = ghcrCheck.extractSemverTags(input);
  // Pre-release (-beta, -rc1, -alpha) and non-semver (latest, v1.9.4) excluded
  assert.deepEqual(result, ['1.10.0', '1.9.4']);
});

test('extractSemverTags: sorts numeric components correctly (10 > 9)', () => {
  const input = ['1.2.3', '1.10.0', '1.9.4', '1.2.10'];
  const result = ghcrCheck.extractSemverTags(input);
  assert.deepEqual(result, ['1.10.0', '1.9.4', '1.2.10', '1.2.3']);
});

test('extractSemverTags: empty input returns empty array', () => {
  assert.deepEqual(ghcrCheck.extractSemverTags([]), []);
});

test('extractSemverTags: all non-semver tags returns empty array', () => {
  assert.deepEqual(ghcrCheck.extractSemverTags(['latest', 'dev', 'beta']), []);
});

test('extractSemverTags: handles single valid tag', () => {
  assert.deepEqual(ghcrCheck.extractSemverTags(['1.0.0']), ['1.0.0']);
});

// =========== compareVersions ===========

test('compareVersions: equal versions return 0', () => {
  assert.equal(ghcrCheck.compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(ghcrCheck.compareVersions('2.5.7', '2.5.7'), 0);
});

test('compareVersions: a < b returns negative', () => {
  assert.ok(ghcrCheck.compareVersions('1.9.4', '1.10.0') < 0, 'minor bump');
  assert.ok(ghcrCheck.compareVersions('1.0.0', '2.0.0') < 0, 'major bump');
  assert.ok(ghcrCheck.compareVersions('1.0.0', '1.0.1') < 0, 'patch bump');
  assert.ok(ghcrCheck.compareVersions('1.0.0', '1.1.0') < 0, 'minor bump 0->1');
});

test('compareVersions: a > b returns positive', () => {
  assert.ok(ghcrCheck.compareVersions('2.0.0', '1.9.4') > 0, 'major larger');
  assert.ok(ghcrCheck.compareVersions('1.10.0', '1.9.4') > 0, 'minor larger');
  assert.ok(ghcrCheck.compareVersions('1.0.1', '1.0.0') > 0, 'patch larger');
});

test('compareVersions: non-semver input returns NaN', () => {
  assert.ok(Number.isNaN(ghcrCheck.compareVersions('abc', '1.0.0')));
  assert.ok(Number.isNaN(ghcrCheck.compareVersions('1.0.0', 'latest')));
  assert.ok(Number.isNaN(ghcrCheck.compareVersions('1.0', '1.0.0')));
});

// =========== getLatestVersion (sync cache read) ===========

test('getLatestVersion: returns null before any poll', () => {
  assert.equal(ghcrCheck.getLatestVersion(), null);
});

/*
 * The badge that never went away.
 *
 * This module was written for an install that PULLS a published image: it polled
 * ghcr.io/screentinker/screentinker, compared the highest tag against VERSION, and lit the
 * sidebar's "Update" chip when the upstream project cut a release. This install builds its
 * image from this source tree instead (docker-compose.prod.yml: `build: .`), so that chip sat
 * lit for every signed-in user, advertising a release nobody here could install, decline, or
 * make go away - and naming another product inside ours while it did.
 *
 * Which repository to watch is now config (UPDATE_CHECK_REPO), and unset means do not watch.
 * The two tests below are what stops a future edit from restoring a hardcoded default: one
 * checks the behaviour, the other checks that the string itself is gone from the source.
 */
test('with no repository configured, the check reports nothing newer and never asks anyone', async () => {
  let fetched = false;
  const realFetch = global.fetch;
  global.fetch = () => { fetched = true; return Promise.reject(new Error('must not be called')); };
  try {
    const result = await ghcrCheck.checkNow('1.0.0', '');
    assert.deepEqual(result, { latest: null, update_available: false });
    assert.equal(fetched, false, 'an install with nothing to compare against must not call out');
    assert.equal(ghcrCheck.getLatestVersion(), null, 'and must leave the badge with no version');
  } finally {
    global.fetch = realFetch;
  }
});

test('no registry is hardcoded: the repository comes from config or the check stays off', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ghcr-check.js'), 'utf8');
  assert.doesNotMatch(src, /screentinker\/screentinker/,
    "a hardcoded repository is how the badge started pointing at another product's releases");
});
