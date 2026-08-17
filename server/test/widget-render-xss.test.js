'use strict';

// Verifies the public widget render endpoint sanitizes config that gets inlined
// into <style>/CSS (clock/weather/rss/social) and isolates the text widget's
// raw HTML in a sandboxed, null-origin iframe.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-widget-xss';

const db = new Database(':memory:');
db.exec(`CREATE TABLE widgets (id TEXT PRIMARY KEY, widget_type TEXT, config TEXT, workspace_id TEXT);`);
const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

const express = require('express');
const widgetsRouter = require('../routes/widgets');
const app = express();
app.use('/api/widgets', widgetsRouter);
const server = app.listen(0);
let base;
test.before(async () => { await new Promise(r => server.listening ? r() : server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); db.close(); });

const seed = (id, type, config) => db.prepare('INSERT INTO widgets (id, widget_type, config, workspace_id) VALUES (?,?,?,?)').run(id, type, JSON.stringify(config), 'ws1');
const render = async (id) => (await fetch(`${base}/api/widgets/${id}/render`)).text();

const CSS_BREAKOUT = 'red}</style><script>document.title="pwned"</script><style>{';

test('clock widget: malicious background/color/font_size cannot break out of <style>', async () => {
  seed('clock1', 'clock', { background: CSS_BREAKOUT, color: CSS_BREAKOUT, font_size: '64px}</style><script>x</script>' });
  const html = await render('clock1');
  assert.ok(!html.includes('</style><script>document.title'), 'CSS breakout payload must be rejected');
  // The payload must not survive ANYWHERE in the document, not merely outside <style>.
  assert.ok(!html.includes(CSS_BREAKOUT), 'the raw payload must not appear in the output at all');
  // The widget now sizes itself against the screen (calc(var(--u) * n), see lib/widget-kit.js)
  // instead of taking a pixel count from config, so `font_size` is no longer read — that
  // injection vector is gone rather than sanitised. What used to be asserted here (a
  // `font-size:64px` fallback and a `background:transparent` default) described the old
  // implementation, not the security property.
  assert.ok(!/font-size:[^;]*script/i.test(html), 'no config value reaches a font-size declaration');
  assert.ok(/--u:\s*calc\(1vmin/.test(html), 'sizes come from the screen-relative unit, not from config');
});

test('rss ticker: scroll_speed/max_items coerced to numbers (no injection)', async () => {
  // mode: 'ticker' is where scroll_speed and max_items live. The default rendering is the card
  // layout below; both are reachable from config, so both are covered.
  seed('rss1', 'rss', {
    mode: 'ticker',
    scroll_speed: '30s}</style><script>y</script>',
    max_items: '10);evil(',
    background: CSS_BREAKOUT,
  });
  const html = await render('rss1');
  assert.ok(!html.includes('</style><script>y'), 'scroll_speed cannot inject');
  assert.ok(!html.includes('evil('), 'max_items cannot inject into the script');
  assert.ok(html.includes('background:#000'), 'invalid background -> default');
});

test('rss card: accent/item_seconds coerced, and the feed never reaches the markup', async () => {
  seed('rss2', 'rss', {
    item_seconds: '9}</style><script>y</script>',
    accent: CSS_BREAKOUT,
    background: CSS_BREAKOUT,
    // The feed URL is fetched server-side and must not be echoed into the page at all.
    feed_url: 'https://x.test/f.xml"><script>steal()</script>',
  });
  const html = await render('rss2');
  assert.ok(!html.includes('</style><script>y'), 'item_seconds cannot inject');
  assert.ok(!html.includes('steal()'), 'the configured feed URL must not reach the rendered page');
  assert.ok(html.includes('background:#06111E'), 'invalid background -> the kit default');
  assert.ok(!/--accent:\s*[^;]*expression/i.test(html), 'invalid accent cannot inject into CSS');
  // The headline and its photograph both arrive after load, from this server.
  assert.match(html, /wPoll\('data\.json'/, 'items come from the server cache, not from the player');
  assert.match(html, /'newsimg\/'/, 'photographs are addressed by item index on this server');
  assert.ok(!/rss2json|api\.rss2json/.test(html), 'the player must not call a third-party RSS service');
});

test('text widget: raw HTML is isolated in a null-origin sandboxed iframe', async () => {
  seed('text1', 'text', { html: '<script>parent.localStorage.token</script>', css: 'body{}' });
  const html = await render('text1');
  assert.ok(html.includes('<iframe sandbox="allow-scripts"'), 'user HTML wrapped in sandboxed iframe');
  assert.ok(!/<body[^>]*>\s*<script>parent\.localStorage/.test(html), 'raw script must not sit in the top-level (same-origin) document');
  assert.ok(html.includes('&lt;script&gt;parent.localStorage'), 'user script is escaped into srcdoc, runs only in the sandboxed frame');
});

test('valid color/gradient backgrounds are preserved', async () => {
  seed('clock2', 'clock', { background: 'linear-gradient(45deg, #ff0000, #00ff00)', color: '#3B82F6' });
  const html = await render('clock2');
  assert.ok(html.includes('linear-gradient(45deg, #ff0000, #00ff00)'), 'legit gradient preserved');
  assert.ok(html.includes('color:#3B82F6'), 'legit hex color preserved');
});

test('clock: no timezone configured means the DEVICE clock, not UTC', async () => {
  // safeTimezone used to default to 'UTC', so a clock with nothing configured showed a time three
  // hours ahead of the wall it hung on. Undefined is what makes Intl read the panel's own zone.
  seed('clock3', 'clock', {});
  const html = await render('clock3');
  assert.match(html, /TZ = null \|\| undefined/,
    'an unset timezone must reach Intl as undefined, which means the device zone');
  assert.ok(!/TZ = "UTC"/.test(html), 'UTC must not be assumed for a panel that never asked for it');
  assert.ok(!html.includes('id="secs"'), 'seconds are opt-in, not the default');

  // A zone that WAS chosen still wins, and an injected one is refused.
  seed('clock4', 'clock', { timezone: 'America/Sao_Paulo', show_seconds: true });
  const chosen = await render('clock4');
  assert.match(chosen, /TZ = "America\/Sao_Paulo"/, 'a configured zone is honoured');
  assert.ok(chosen.includes('id="secs"'), 'seconds appear when asked for');

  seed('clock5', 'clock', { timezone: 'x";evil()//' });
  const bad = await render('clock5');
  assert.ok(!bad.includes('evil()'), 'a malformed timezone cannot inject');
});

test('the news card credits no newsroom, and the lottery footer only dates', async () => {
  // The screen is the customer's own wall: the headline is the content, and whose feed it arrived
  // through is our plumbing. The corner credit is gone, and the category flash is suppressed when
  // it carries a source rather than a subject — feeds routinely put their own name in <category>.
  seed('news9', 'rss', { feed_urls: ['https://example.com/a.xml'] });
  const news = await render('news9');
  assert.ok(!/class="src"/.test(news), 'no newsroom credit element');
  assert.ok(!/getElementById\('src'\)/.test(news), 'nothing fills a newsroom credit');
  assert.ok(!/\.src \{/.test(news), 'no dead styling left behind for it');
  // The suppression compares against THIS item's own source, not the joined list of every source
  // configured — comparing against the list is why "G1" slipped through on a four-section widget.
  assert.match(news, /item\.source \|\| feedSource/, 'the category is checked against its own item');

  // Caixa keeps publishing a next-draw date for a draw already held, so the same field means
  // "next" some days and "just held" on others. Either way it is a date; the footer says the date
  // and does not narrate the state of our data pipeline to a shop wall.
  seed('lot9', 'lottery', { game: 'quina' });
  const lot = await render('lot9');
  assert.ok(!/resultado em breve/i.test(lot), 'the widget must not announce a pending result');
  assert.match(lot, /'Sorteio de ' \+ d\.nextDate/, 'a past date is stated plainly');
  assert.match(lot, /'Próximo sorteio: ' \+ d\.nextDate/, 'a future date keeps its label');
});

test('the slot length reported by the player drives the rotation and the bar', async () => {
  // Only the player knows how long a widget is on screen: the same widget can sit in two playlists
  // with different slots. Without it the hold was a guess at "longer than any sensible slot",
  // which showed one headline and a slice of the next, and left the progress bar stopping two
  // thirds of the way across.
  seed('news10', 'rss', { feed_urls: ['https://example.com/a.xml'] });
  const withSlot = await (await fetch(`${base}/api/widgets/news10/render?dur=15`)).text();
  assert.match(withSlot, /var HOLD_MS = 15000/, 'the slot length wins over the configured default');
  assert.match(withSlot, /'advance ' \+ HOLD_MS \+ 'ms/, 'the bar fills over exactly that time');

  const noSlot = await render('news10');
  assert.match(noSlot, /var HOLD_MS = 25000/, 'an old player or a direct visit still renders');

  // Clamped: a slot length is a query parameter, and anything can be put in one.
  const absurd = await (await fetch(`${base}/api/widgets/news10/render?dur=99999`)).text();
  assert.match(absurd, /var HOLD_MS = 3600000/, 'an absurd slot is clamped, not honoured');
  const hostile = await (await fetch(`${base}/api/widgets/news10/render?dur=15);evil(`)).text();
  assert.ok(!hostile.includes('evil('), 'the slot length cannot inject');
});
