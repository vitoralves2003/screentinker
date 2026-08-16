'use strict';

/*
 * The football widget's crest mirror (lib/football.js + /api/widgets/crest/:id.png).
 *
 * THE CASE THAT MATTERS IS THE SECURITY ONE. The obvious shape for "show me this club's badge" is
 * /crest?url=<something>, and that is an open proxy: anything that can reach the endpoint makes
 * THIS server issue a request to an address of the caller's choosing, including addresses only the
 * server can reach — a cloud metadata endpoint, a database admin port, another tenant's service.
 * The endpoint therefore takes a numeric id and nothing else, and the upstream host is a constant
 * in the module. These tests exist so that stays true: the day someone adds a url parameter "just
 * for testing", this fails.
 *
 * The rest covers the reason the mirror exists at all — one fetch for the whole fleet, cached to
 * disk, never re-fetched — and the fact that a crest that cannot be had must degrade to nothing
 * rather than to a broken-image glyph on a shop wall.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-crest-' + crypto.randomBytes(4).toString('hex'));

const { test } = require('node:test');
const assert = require('node:assert/strict');

const football = require('../lib/football');

const realFetch = globalThis.fetch;
function restoreFetch() { globalThis.fetch = realFetch; }

// A one-pixel PNG is a real enough image for the cache to store and hand back.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

test('an id that is not digits never reaches the network', async () => {
  const attempted = [];
  globalThis.fetch = async (url) => {
    attempted.push(String(url));
    return { ok: true, arrayBuffer: async () => PNG.buffer };
  };
  try {
    // Path traversal, a cloud metadata address, a scheme, an id with a letter smuggled in, and
    // the empty string. Every one of these is what an open proxy would happily fetch.
    const hostile = [
      '../../../etc/passwd',
      '..%2f..%2fetc%2fpasswd',
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:5432/',
      '3445.png?x=/../',
      '3445a',
      '3445 ',
      '',
      null,
      undefined,
      '999999999',            // more digits than any team id, and past the length guard
    ];
    for (const id of hostile) {
      assert.equal(await football.crestFile(id), null, `crestFile must refuse ${JSON.stringify(id)}`);
    }
    assert.deepEqual(attempted, [], 'not one hostile id may cause an outbound request');
  } finally { restoreFetch(); }
});

test('the upstream host is fixed in the module, not taken from the caller', async () => {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return { ok: true, arrayBuffer: async () => PNG.buffer };
  };
  try {
    await football.crestFile('3445');
    assert.equal(seen.length, 1);
    assert.match(seen[0], /^https:\/\/a\.espncdn\.com\//,
      'the crest must be fetched from ESPN and nowhere else');
    assert.match(seen[0], /3445\.png/);
  } finally { restoreFetch(); }

  // Comments are stripped first. The doc comment in football.js explains the open-proxy shape it
  // is avoiding, and scanning the raw file makes the explanation trip the rule it explains.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'football.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/req\.query|searchParams|\?url=/.test(src),
    'the crest fetcher must never read a URL from the request — that is an open proxy');
});

test('a mirrored crest is fetched ONCE for the whole fleet and served from disk after', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return { ok: true, arrayBuffer: async () => PNG.buffer };
  };
  try {
    // Twenty panels rendering the table at the same instant.
    const files = await Promise.all(Array.from({ length: 20 }, () => football.crestFile('2029')));
    assert.equal(calls, 1, `expected 1 upstream fetch for 20 readers, got ${calls}`);
    assert.ok(files.every((f) => f && fs.existsSync(f)), 'every caller gets a real file');

    // And once it is on disk it is never asked for again — crests do not change.
    await football.crestFile('2029');
    assert.equal(calls, 1, 'a cached crest must not be re-fetched');
  } finally { restoreFetch(); }
});

test('an upstream failure yields nothing rather than a truncated or oversized file', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => Buffer.alloc(0).buffer });
  try {
    assert.equal(await football.crestFile('4001'), null, 'a 404 crest must not be cached');
  } finally { restoreFetch(); }

  // A bad upstream response must not be allowed to fill the disk on a device that has very little.
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => Buffer.alloc(2 * 1024 * 1024).buffer });
  try {
    assert.equal(await football.crestFile('4002'), null, 'an implausibly large response is not a crest');
  } finally { restoreFetch(); }

  const dir = path.join(process.env.DATA_DIR, 'cache', 'crests');
  const stored = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  assert.ok(!stored.some((f) => f.startsWith('4001') || f.startsWith('4002')),
    'nothing from a failed fetch may be left in the cache');
  assert.ok(!stored.some((f) => f.endsWith('.tmp')),
    'the write-then-rename must not leave partial files behind');
});

test('the widget points at THIS server for crests, never at the CDN', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'widgets.js'), 'utf8');
  const fn = src.slice(src.indexOf('function renderFootball'), src.indexOf('function renderRSS'));

  assert.ok(!/espncdn|a\.espn/.test(fn),
    'the player must never be pointed at the crest CDN directly — it may have no route to it');
  assert.match(fn, /'\.\.\/crest\/'/,
    'crests are read from this server, relative to the widget render URL');
  // The score payload is third-party text and this widget can run same-origin.
  assert.ok(!/innerHTML\s*=/.test(fn), 'football must not assign innerHTML anywhere');
});

test.after(() => {
  restoreFetch();
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* windows locks */ }
});

test('image routes are readable from the null origin the player frames them in', () => {
  // The player frames a widget in <iframe sandbox="allow-scripts"> with NO allow-same-origin, so
  // the widget document has a null origin. An <img> is a no-cors request, and helmet's default
  // Cross-Origin-Resource-Policy: same-origin makes the browser fetch the bytes, receive a 200,
  // and then discard them — the tag fires `error` and nothing is drawn. The access log shows a
  // perfectly good 200, which is why this read as a network fault rather than a header.
  //
  // data.json was never affected because fetch() is CORS mode and CORP does not apply to it, so
  // the widget had live data and no pictures.
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'widgets.js'), 'utf8');

  for (const [route, next] of [["router.get('/crest/:id.png'", "router.get('/:id/newsimg/:n'"],
                               ["router.get('/:id/newsimg/:n'", "router.get('/:id/data.json'"]]) {
    const handler = src.slice(src.indexOf(route), src.indexOf(next));
    assert.ok(handler.length > 0, `${route} not found`);
    assert.match(handler, /Cross-Origin-Resource-Policy['"]\s*,\s*['"]cross-origin/,
      `${route} must be readable from a null origin or the image never paints on a real screen`);
    // It is only safe because the endpoint is already public and CORS-open.
    assert.match(handler, /Access-Control-Allow-Origin['"]\s*,\s*['"]\*/,
      `${route} was already public; CORP grants nothing new`);
  }
});
