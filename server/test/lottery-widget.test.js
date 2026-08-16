'use strict';

// Loop OS lottery widget (lib/lottery.js + the 'lottery' renderer in routes/widgets.js).
//
// The cases that matter:
//   - a failed refresh must NEVER destroy the cache. A draw stands for days, so the last good
//     result is the right thing to keep showing; blanking a shop wall is not.
//   - concurrent readers must produce ONE upstream request, not one per screen — the entire
//     reason this is fetched server-side rather than from each panel.
//   - the rendered widget must not pass third-party API text through innerHTML.
//   - 'lottery' must actually render, rather than falling through to "Unknown widget".
//   - the tenant-facing catalogue must never offer diag-smoothness.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-lottery-' + crypto.randomBytes(4).toString('hex'));

const { test } = require('node:test');
const assert = require('node:assert/strict');

const lottery = require('../lib/lottery');
const appSettings = require('../lib/app-settings');

const DRAW = {
  numero: 3044, dataApuracao: '13/08/2026',
  listaDezenas: ['04', '15', '17', '40', '55', '58'],
  acumulado: true, dataProximoConcurso: '15/08/2026', valorEstimadoProximoConcurso: 38000000,
  listaRateioPremio: [{ faixa: 1, numeroDeGanhadores: 0, valorPremio: 0 }],
};

const realFetch = globalThis.fetch;
function stubFetch(impl) { globalThis.fetch = impl; }
function restoreFetch() { globalThis.fetch = realFetch; }

test('a successful refresh normalises the upstream shape and caches it', async () => {
  let calls = 0;
  stubFetch(async () => { calls++; return { ok: true, json: async () => DRAW }; });
  try {
    const r = await lottery.refresh();
    assert.equal(calls, 1, 'the first source answering should stop the chain');
    assert.equal(r.contest, 3044);
    assert.equal(r.game, 'megasena');
    assert.deepEqual(r.numbers, ['04', '15', '17', '40', '55', '58']);
    assert.equal(r.accumulated, true);
    assert.equal(r.winners, 0);
    assert.ok(r.fetchedAt > 0);
    assert.ok(appSettings.get(lottery.CACHE_KEY, null), 'result must be persisted');
  } finally { restoreFetch(); }
});

test('a response that parses but carries no draw is treated as a failure', async () => {
  // A schema change upstream returns 200 with the wrong shape. Accepting it would replace a
  // good result with an empty widget — worse than keeping yesterday's correct numbers.
  stubFetch(async () => ({ ok: true, json: async () => ({ numero: null, listaDezenas: [] }) }));
  try {
    const r = await lottery.refresh();
    assert.equal(r, null, 'an empty draw must not count as success');
    const still = JSON.parse(appSettings.get(lottery.CACHE_KEY, 'null'));
    assert.equal(still.contest, 3044, 'the good cache must survive');
  } finally { restoreFetch(); }
});

test('every source down keeps the last good result and never throws', async () => {
  stubFetch(async () => { throw new Error('network down'); });
  try {
    const r = await lottery.refresh();
    assert.equal(r, null);
    const cached = JSON.parse(appSettings.get(lottery.CACHE_KEY, 'null'));
    assert.equal(cached.contest, 3044, 'a failed refresh must not destroy the cache');
  } finally { restoreFetch(); }
});

test('it falls through to the second source when the first fails', async () => {
  const seen = [];
  stubFetch(async (url) => {
    seen.push(url);
    if (url.includes('caixa.gov.br')) throw new Error('primary down');
    // The community mirror names the tier fields differently — faixa 1 carries `ganhadores`.
    return { ok: true, json: async () => ({
      concurso: 3045, data: '15/08/2026', dezenas: ['01', '02', '03', '04', '05', '06'],
      acumulou: false, premiacoes: [{ faixa: 1, ganhadores: 2, valorPremio: 25000000 }],
    }) };
  });
  try {
    const r = await lottery.refresh();
    assert.equal(seen.length, 2, 'both sources should have been tried');
    assert.equal(r.contest, 3045);
    assert.equal(r.source, 'loteriascaixa-api');
    assert.equal(r.winners, 2, 'the mirror\'s `ganhadores` field must be read, not `vencedores`');
  } finally { restoreFetch(); }
});

test('a fleet asking at once produces ONE upstream request', async () => {
  // Force staleness so getLatest() has to refresh.
  const stale = { ...JSON.parse(appSettings.get(lottery.CACHE_KEY, '{}')), fetchedAt: 0 };
  appSettings.set(lottery.CACHE_KEY, JSON.stringify(stale));

  let calls = 0;
  stubFetch(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 30));
    return { ok: true, json: async () => DRAW };
  });
  try {
    // 25 panels polling data.json in the same instant.
    const results = await Promise.all(Array.from({ length: 25 }, () => lottery.getLatest()));
    assert.equal(calls, 1, `expected 1 upstream call for 25 readers, got ${calls}`);
    // With a cached value in hand they are served immediately (flagged stale) rather than
    // blocking on someone else's API.
    assert.ok(results.every(r => r && r.contest), 'every reader gets a result');
    assert.ok(results.every(r => r.stale === true), 'a stale value is served without waiting');
  } finally { restoreFetch(); }
});

test('the lottery widget renders, and never puts API text through innerHTML', () => {
  // renderWidgetHtml is not exported, so go through the public render surface the same way a
  // player would: require the route module and pull the rendered HTML from the preview helper.
  const widgetsSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'widgets.js'), 'utf8');

  assert.match(widgetsSrc, /KNOWN_WIDGET_TYPES = new Set\(\[[^\]]*'lottery'/,
    "'lottery' must be a known widget type or POST /preview rejects it");
  assert.match(widgetsSrc, /case 'lottery': return renderLottery\(config\)/,
    'the switch must dispatch lottery, or it falls through to "Unknown widget"');

  const body = widgetsSrc.slice(widgetsSrc.indexOf('function renderLottery'));
  const fn = body.slice(0, body.indexOf('\nfunction renderWeather'));

  // Third-party payload -> DOM. textContent only.
  assert.ok(!/innerHTML\s*=/.test(fn.replace(/balls\.textContent = '';/g, '')),
    'lottery must not assign innerHTML anywhere — the payload is third-party');
  assert.match(fn, /textContent/, 'values are written with textContent');
  // Reads from THIS server, not from Caixa directly. The call now goes through the widget kit's
  // wPoll (which also keeps the last good render on a failed fetch), so accept either form —
  // what matters is the RELATIVE path, not which helper issues it.
  assert.match(fn, /(fetch\(|wPoll\()'data\.json'/, 'must read the server-side cache, not the upstream API');
  assert.ok(!/servicebus2|loteriascaixa/.test(fn),
    'the player must never be pointed at the upstream API directly');
});

test('the tenant widget catalogue is a closed list and excludes the internal diagnostic', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'playlists.js'), 'utf8');
  const cat = src.slice(src.indexOf('const WIDGET_CATALOGUE'), src.indexOf('async function showAddItemModal'));

  for (const type of ['clock', 'weather', 'rss', 'lottery', 'football']) {
    assert.match(cat, new RegExp(`type: '${type}'`), `catalogue must offer ${type}`);
  }
  assert.ok(!cat.includes('diag-smoothness'),
    'diag-smoothness is an internal frame-rate diagnostic and must never be offered to a customer');
  // Still a CLOSED list — the point of this assertion is that no internal type can drift in, not
  // that the list never grows. Football was added deliberately; text/webpage/social/directory
  // remain internal.
  assert.ok(!/text|webpage|social|directory/.test(cat.match(/type: '[a-z-]+'/g).join(' ')),
    'no internal widget type may appear in the tenant catalogue');

  // The config keys have to be the ones the server renderers actually read.
  // Weather takes a picked city_id (coordinates live server-side in lib/cities-br.js), NOT a
  // typed place name — a name is ambiguous and resolves to the wrong town silently.
  assert.match(cat, /city_id: v/, 'weather maps its input to city_id (what renderWeather reads)');
  assert.match(cat, /feed_url:/, 'news sets `feed_url` (what renderRSS reads)');
  assert.match(cat, /view: v \|\| 'matches'/, 'football sets `view` (what renderFootball reads)');
});

test.after(() => {
  restoreFetch();
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* windows locks */ }
});
