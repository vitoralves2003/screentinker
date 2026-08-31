'use strict';

/*
 * The screens page renders as a table, and the handlers around it reach into that table by CSS
 * class. Nothing type-checks that relationship: rename a class in the row template and the filter
 * silently matches nothing, the status badge silently never updates, the progress bar silently
 * never appears. Every one of those is a page that still loads, still looks right on first render,
 * and is wrong the moment anyone touches a control.
 *
 * That is exactly what happened during this change — twice. The state cell was renamed and the
 * status filter kept querying the old class, so filtering by "offline" emptied a fleet that had
 * two offline screens in it. A unit test of the filter logic would have passed: the rule was
 * right, it was just never reached.
 *
 * So this asserts the contract between the row markup and the code that queries it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const VIEW = path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'dashboard.js');
const CSS = path.join(__dirname, '..', '..', 'frontend', 'css', 'main.css');
const src = fs.readFileSync(VIEW, 'utf8');
const css = fs.readFileSync(CSS, 'utf8');

/* The body of a named function, by brace matching — regex cannot survive nested template literals. */
function functionBody(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is gone — the fleet list no longer renders rows`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// The state cell is built by its own helper so the socket handler can repaint a row live using
// exactly the same markup — so "the row's markup" is the two of them together.
const row = functionBody('renderDeviceRow') + functionBody('stateCellHtml');
const table = functionBody('renderDeviceTable');

test('the row emits every class the page queries it by', () => {
  for (const cls of [
    'device-row',        // drag-and-drop, the filter, and the row click all start here
    'data-liveness',     // the filter reads the STATE off the ROW, not a visible label
    'data-offline-reason', // the offline drill-in
    'col-playlist',
    'list-name-main',    // the search matches on the name cell
  ]) {
    assert.ok(row.includes(cls), `renderDeviceRow no longer emits "${cls}"`);
  }
  // The checkbox cell comes from the shared module, so the row's obligation is to CALL it — and
  // the module's is to keep emitting the class wireSelection then binds to.
  assert.ok(row.includes('selectCell('), 'the row must render the shared checkbox cell');
  const kit = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'bulk-select.js'), 'utf8');
  assert.ok(kit.includes('bulk-check'), 'selectCell no longer emits the class wireSelection binds');
});

test('the state is readable without reading: a stripe, at a fixed x', () => {
  /*
   * The point of the stripe is that it is scanned, not read. That only holds if THREE things stay
   * true together, and each has failed on its own during this work: the row must publish its state
   * as an attribute, the CSS must paint a distinct colour for every state livenessState can
   * return, and the live socket handler must repaint the attribute — otherwise a screen that drops
   * while you are watching keeps the colour it had when the page loaded, which is precisely the
   * moment the stripe exists for.
   */
  assert.ok(row.includes('data-row-state="${b.state}"'), 'the row must publish its state for the stripe');

  for (const state of ['healthy', 'degraded', 'offline', 'provisioning']) {
    assert.ok(css.includes(`.device-row[data-row-state="${state}"]`),
      `no stripe colour for "${state}" — livenessState can return it, so it would paint as nothing`);
  }

  const handler = src.slice(src.indexOf('statusHandler = (data) =>'));
  assert.match(handler.slice(0, 2400), /dataset\.rowState = b\.state/,
    'a screen that goes down while you watch must repaint its stripe');

  /*
   * AND THE STATE THE FILTER READS. The stripe is painted from data-row-state and the filter
   * matches on data-liveness — both live on the row, and both have to be repainted, or a row goes
   * on claiming "saudável" after the screen dropped until somebody reloads.
   */
  assert.match(handler.slice(0, 2400), /dataset\.liveness = b\.state/,
    'the live handler must repaint the state the filter matches on');
});

test('the state says what, for how long, and why — in one phrase', () => {
  const text = functionBody('stateText');
  assert.match(text, /formatTimeAgo/, 'the elapsed time belongs with the state, not in its own column');
  assert.match(text, /b\.sub/, 'the offline reason is real information and must survive');
  // Severity lives in the join of state and duration, so a healthy screen showing "Agora mesmo"
  // adds nothing — and under a minute the phrase would read "Offline Agora mesmo".
  assert.match(text, /elapsed >= 60/, 'no duration under a minute, and none for a healthy screen');
  assert.ok(!table.includes("t('dashboard.col_last_seen')"), 'the separate last-seen column is gone');
  // Three columns went with it: the state (now a dot), the current item (now on the screen's own
  // page) and the signals. Their headings must go too, or table-layout:fixed sizes a column that
  // has no cells.
  for (const gone of ['col_state', 'col_now_playing', 'col_signals']) {
    assert.ok(!table.includes(`dashboard.${gone}`), `the ${gone} heading outlived its column`);
  }

  // The filled pill was a second, louder copy of what the stripe now says.
  assert.ok(!row.includes('device-status-badge'), 'the fleet row must not re-render the filled pill');
});

test('the fleet row no longer carries a playback widget', () => {
  /*
   * The 'Reproduzindo agora' column is gone from the list, and the widget it fed is not on the
   * screen page either — the tab built to hold it was wrong, so it was pulled out with it.
   *
   * #tab-screen turned out to be ONE device-section among several: orientation, the controls, the
   * info cards, the hours and the sound are siblings outside any pane. Switching tabs therefore
   * hid two fields and left the whole settings page standing under a heading that said Exibição.
   *
   * The feature comes back when every section on that page is wrapped into panes, which is the
   * shape the day-history tab needs anyway. Recorded here so the absence reads as a decision
   * rather than as something that fell out during a refactor.
   */
  assert.ok(!row.includes('device-card-progress'), 'the column is gone from the row');

  const detail = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'device-detail.js'), 'utf8');
  assert.ok(!detail.includes('nowPlaying'), 'and the half-built tab went with it');
});


test('the selectors the handlers use are ones the row actually emits', () => {
  // The specific failure this file exists for: a handler pointing at a class from the old card.
  const queried = [...src.matchAll(/querySelector(?:All)?\(\s*['"`]\.([a-z-]+)/g)].map(m => m[1]);
  const fromRow = new Set(['device-row', 'bulk-check', 'bulk-check-all', 'state-inline', 'list-name-main']);
  const rowLevel = queried.filter(c => fromRow.has(c));
  for (const cls of rowLevel) {
    assert.ok(row.includes(cls) || table.includes(cls),
      `code queries ".${cls}" but neither the row nor the table renders it`);
  }
  assert.ok(rowLevel.length >= 4, 'expected the row-level selectors to still be in use');
});

test('the state cell does not inherit the absolutely-positioned card badge', () => {
  // .device-card-status is position:absolute — it floated the pill over a thumbnail. A table cell
  // carrying that class lands in the corner of the PAGE, not in its column.
  assert.ok(/\.device-card-status\s*\{[^}]*position:\s*absolute/s.test(css),
    'this test is only meaningful while .device-card-status is absolutely positioned');
  assert.ok(!row.includes('class="device-card-status"'),
    'the state cell must not reuse the card badge wrapper class');
});

test('the fleet page no longer asks every panel for a screenshot', () => {
  // The card carried a thumbnail, which meant a capture request per panel every 30 seconds for as
  // long as anyone had the page open. Removing the picture and leaving the poll would keep the
  // whole cost and deliver nothing.
  assert.ok(!src.includes('requestScreenshot'),
    'the fleet list has no thumbnails; it must not request captures');
  assert.ok(!/on\(\s*'screenshot-ready'/.test(src),
    'nothing on this page consumes screenshots any more');
  assert.ok(!/setInterval\(\s*pollScreenshots/.test(src), 'the 30-second capture poll is gone');
});

test('bulk actions run through the shared selection module', () => {
  // One implementation across content, playlists and screens: three subtly different bulk deletes
  // is how an operator removes the wrong thing.
  assert.match(src, /from '\.\.\/bulk-select\.js'/, 'the page must use the shared selection module');
  assert.ok(src.includes('runEach('), 'per-item bulk actions must report partial failure');
  assert.ok(src.includes('function renderDeviceBulkBar()'), 'the bulk toolbar renderer is gone');
});

test('the row is the way in, and it is the ONLY way in', () => {
  /*
   * The per-row open and delete icons were removed once the row itself opened the screen: two doors
   * to the same room, on a 25px target one row away from a different shop. That makes the row click
   * load-bearing in a way it was not before — if it breaks there is no route to a screen at all,
   * and no icon left to fall back on.
   */
  assert.ok(!row.includes('data-open-device'), 'the redundant open icon is gone');
  assert.ok(!row.includes('data-delete-device'), 'delete belongs on the device page, not the row');
  assert.ok(!/<t[hd] class="actions"/.test(row + table), 'the fleet table has no actions column');

  const handler = src.slice(src.indexOf("container.addEventListener('click'"));
  assert.match(handler, /closest\?\.\('\.device-row'\)/, 'the row click must still open the screen');
  assert.match(handler, /window\.location\.hash = '\/device\/'/, 'and it must navigate to the device');
  assert.match(handler, /closest\('\.bulk-cell'\)/, 'ticking a checkbox must not navigate');
});

test('deleting screens in bulk asks before it acts', () => {
  const bar = functionBody('renderDeviceBulkBar');
  const del = bar.slice(bar.indexOf("id: 'delete'"));
  assert.ok(del.includes('confirm: true'), 'bulk delete must confirm');
  assert.ok(del.includes('api.deleteDevice'), 'bulk delete must call the delete endpoint');
  // A chave 'dashboard.confirm_destructive_selection' virou a propria pergunta quando o
  // dicionario saiu. O que se guarda e a pergunta existir, nao o nome dela.
  assert.ok(bar.includes('telas selecionadas?'),
    'reiniciar/desligar uma selecao inteira tem de perguntar antes');
  assert.ok(bar.includes('não pode ser desfeito'),
    'e tem de dizer que nao da para voltar atras');
});
