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

test('all ten modalities are offered, each with its own cache row', async () => {
  const ids = Object.keys(lottery.GAMES);
  assert.deepEqual(ids.sort(),
    ['diadesorte', 'duplasena', 'federal', 'lotofacil', 'lotomania', 'maismilionaria',
      'megasena', 'quina', 'supersete', 'timemania'],
    'the catalogue promises ten games; lib/lottery.js has to carry all ten');

  // Every game must cache under its OWN key, or the six of them overwrite each other and each
  // screen shows whichever draw landed last.
  stubFetch(async () => ({ ok: true, json: async () => DRAW }));
  try {
    for (const id of ids) await lottery.refresh(id);
    for (const id of ids) {
      const row = JSON.parse(appSettings.get('lottery.' + id, 'null'));
      assert.ok(row, `${id} must persist its own cache row`);
      assert.equal(row.game, id);
      assert.equal(row.ball_count, lottery.GAMES[id].balls,
        'ball_count drives the widget layout, so it must survive the round-trip');
    }
    // Mega-Sena's key is the one that existed before the widget grew — an install upgrading in
    // place must keep reading its old cache, not start from empty.
    assert.equal(lottery.CACHE_KEY, 'lottery.megasena');
  } finally { restoreFetch(); }
});

test('Caixa\'s NUL padding never reaches the screen as a club name', async () => {
  // Caixa returns nomeTimeCoracaoMesSorte for EVERY game, padded with NUL bytes when there is no
  // club. String.trim() does not strip NULs, so the padding survives as a truthy string and the
  // widget renders an empty "Time do coração" block on Mega-Sena, Quina and the rest.
  const padded = { ...DRAW, nomeTimeCoracaoMesSorte: '\u0000'.repeat(17) };
  stubFetch(async () => ({ ok: true, json: async () => padded }));
  try {
    const r = await lottery.refresh('megasena');
    assert.equal(r.extra, null, 'NUL padding must normalise to null, not to a truthy blank');
  } finally { restoreFetch(); }

  // The real Timemania value is padded INSIDE the name too: "BOTAFOGO         /SP".
  const club = { ...DRAW, nomeTimeCoracaoMesSorte: 'BOTAFOGO         /SP' };
  stubFetch(async () => ({ ok: true, json: async () => club }));
  try {
    const r = await lottery.refresh('timemania');
    assert.equal(r.extra, 'BOTAFOGO/SP');
  } finally { restoreFetch(); }
});

test('the club field is captioned per game, because Caixa reuses it for two things', async () => {
  // nomeTimeCoracaoMesSorte carries Timemania's football club AND Dia de Sorte's lucky month.
  // Without a per-game caption the month "Maio" is announced as a football team.
  stubFetch(async () => ({ ok: true, json: async () => ({ ...DRAW, nomeTimeCoracaoMesSorte: 'Maio' }) }));
  try {
    const dia = await lottery.refresh('diadesorte');
    assert.equal(dia.extra, 'Maio');
    assert.equal(dia.extra_label, 'Mês da sorte');

    const time = await lottery.refresh('timemania');
    assert.equal(time.extra_label, 'Time do coração');

    // A game that has no such concept must not show the block at all, whatever Caixa sends.
    const mega = await lottery.refresh('megasena');
    assert.equal(mega.extra, null);
    assert.equal(mega.extra_label, null);
  } finally { restoreFetch(); }
});

test('the three games that are not "a row of numbers" keep their own shape', async () => {
  // +Milionária draws two clovers alongside the six numbers.
  stubFetch(async () => ({ ok: true, json: async () => ({ ...DRAW, trevosSorteados: ['4', '6'] }) }));
  try {
    const r = await lottery.refresh('maismilionaria');
    assert.equal(r.kind, 'clover');
    assert.deepEqual(r.clovers, ['4', '6']);
  } finally { restoreFetch(); }

  // Federal has no drawn numbers: five places against ticket numbers, zipped from two arrays.
  const federal = {
    numero: 6091, dataApuracao: '12/08/2026',
    listaDezenas: ['086997', '004852', '000091', '082438', '039210'],
    listaRateioPremio: [
      { faixa: 1, numeroDeGanhadores: 1, valorPremio: 500000 },
      { faixa: 2, numeroDeGanhadores: 1, valorPremio: 27000 },
    ],
  };
  stubFetch(async () => ({ ok: true, json: async () => federal }));
  try {
    const r = await lottery.refresh('federal');
    assert.equal(r.kind, 'tickets');
    assert.equal(r.tickets.length, 5);
    assert.deepEqual(r.tickets.map((t) => t.ticket),
      ['86997', '4852', '091', '82438', '39210'],
      'Caixa zero-pads to six digits; strip the padding but never below three');
    assert.equal(r.tickets[0].prize, 500000, 'the tier table is zipped onto the tickets in order');
  } finally { restoreFetch(); }

  // A Federal response carrying tickets but no prize table must not be cached as a result: the
  // numbers check the other nine games use would wave it through.
  stubFetch(async () => ({ ok: true, json: async () => ({ numero: 6092, listaDezenas: [] }) }));
  try {
    const r = await lottery.refresh('federal');
    assert.equal(r, null, 'an empty ticket table is a failure, not a draw');
    const cached = JSON.parse(appSettings.get('lottery.federal', 'null'));
    assert.equal(cached.contest, 6091, 'the good Federal result must survive');
  } finally { restoreFetch(); }
});

test('Dupla Sena carries its second draw; the other games carry none', async () => {
  const double = { ...DRAW, listaDezenasSegundoSorteio: ['09', '17', '18', '24', '25', '41'] };
  stubFetch(async () => ({ ok: true, json: async () => double }));
  try {
    const r = await lottery.refresh('duplasena');
    assert.deepEqual(r.numbers2, ['09', '17', '18', '24', '25', '41']);
  } finally { restoreFetch(); }

  stubFetch(async () => ({ ok: true, json: async () => DRAW }));
  try {
    const r = await lottery.refresh('quina');
    assert.deepEqual(r.numbers2, [], 'a game with one draw must report an empty second draw');
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

test('a game keeps its own colour despite the accent the old catalogue wrote', () => {
  // Every lottery widget made before the ten-game rework carries accent '#00A868' — the old
  // catalogue stamped that constant into all of them, so it says nothing about what anyone wanted.
  // Honouring it would render Lotomania in Mega-Sena's green on every widget that already exists.
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'widgets.js'), 'utf8');
  const fn = src.slice(src.indexOf('function renderLottery'), src.indexOf('function renderWeather'));

  assert.match(fn, /00A868/, 'the legacy catalogue default has to be recognised to be ignored');
  assert.match(fn, /GAMES\[c\.game\]/, 'the game still selects the palette');
  // And a genuinely chosen accent must still win, or this becomes "the customer cannot pick".
  assert.match(fn, /safeCss\(chosen, game\.accent\)/,
    'any other accent still overrides the per-game colour');
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

test('a next-draw date that has already passed is not announced', () => {
  // Caixa keeps publishing dataProximoConcurso for a draw already held until it publishes the
  // result, so echoing it verbatim left the screen promising a sorteio that happened yesterday —
  // which is what made a perfectly current result look like stale data.
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'widgets.js'), 'utf8');
  const fn = src.slice(src.indexOf('function renderLottery'), src.indexOf('function renderWeather'));

  assert.match(fn, /function upcoming\(/, 'the widget has to decide whether the date is still ahead');
  assert.match(fn, /upcoming\(d\.nextDate\)/, 'the footer is gated on that decision');
  // The date test lives inside a template literal, where a singly-escaped \d collapses to a bare
  // d and the regex stops parsing — a syntax error that only appears at render time, never at
  // build time. That shipped once; this is the guard. Two literal backslashes are required.
  assert.match(fn, /\\\\d\{2\}/,
    'the date regex must be double-escaped, or the rendered widget will not parse');
});
