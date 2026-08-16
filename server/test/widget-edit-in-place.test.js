'use strict';

/*
 * Changing what an existing widget shows, without deleting it and adding it back.
 *
 * WHY THIS EXISTS. The catalogue asked which lottery modality to show only when the widget was
 * CREATED, so every widget made before the ten-game rework carried no `game` key at all and every
 * one of them fell back to Mega-Sena — with no way in the product to change it. Ten modalities
 * shipped without a way to choose between them after the fact.
 *
 * The two things that must stay true:
 *   - the edit MERGES config. config() builds a fresh object for a new widget, and writing that
 *     over an existing one silently drops everything else set on it.
 *   - the server pushes the change to displays already showing the widget, or the edit only
 *     reaches the wall when the player restarts (#234).
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-wedit-' + crypto.randomBytes(4).toString('hex'));
process.env.JWT_SECRET = 'test-secret-widget-edit';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const VIEW = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'playlists.js'), 'utf8');

test('every catalogue entry that asks a question can also read its answer back', () => {
  const cat = VIEW.slice(VIEW.indexOf('const WIDGET_CATALOGUE'), VIEW.indexOf('function catalogueFor'));

  // The question's field name is not always the config key it writes — news asks for a "category"
  // and stores feed_url — so an editor cannot derive the current value. Each entry states it.
  const asks = (cat.match(/ask: \{/g) || []).length;
  const currents = (cat.match(/current: \(cfg\)/g) || []).length;
  assert.equal(asks, currents,
    `every ask needs a matching current() or the edit dialog opens on the wrong value (${asks} asks, ${currents} currents)`);

  for (const key of ['cfg.game', 'cfg.view', 'cfg.city_id', 'cfg.feed_url']) {
    assert.ok(cat.includes(key), `the catalogue must read ${key} back for editing`);
  }
});

test('the edit merges config instead of replacing it', () => {
  // The merge itself moved into mergedConfig() when retiring dead keys was added; the property
  // being asserted is the same one — what was there survives unless the catalogue supersedes it.
  const merge = VIEW.slice(VIEW.indexOf('function mergedConfig'), VIEW.indexOf('async function showEditWidgetModal'));
  assert.match(merge, /\{ \.\.\.current, \.\.\.entry\.config\(value\) \}/,
    'the existing config must be spread under the new value, not replaced by it');

  const fn = VIEW.slice(VIEW.indexOf('async function showEditWidgetModal'),
    VIEW.indexOf('async function showAddItemModal'));
  assert.match(fn, /api\.updateWidget\(/, 'it saves through the widget update endpoint');
  assert.match(fn, /api\.getWidget\(/, 'it opens on the widget as it is stored, not on a default');
});

test('the edit button appears only where there is something to change', () => {
  assert.match(VIEW, /function widgetIsEditable\(/);
  assert.match(VIEW, /item\.widget_id && widgetIsEditable\(item\.widget_type\)/,
    'the button is gated on the item being a widget with an editable catalogue entry');
  // The clock asks nothing today, so offering it an edit button opens an empty dialog.
  const clock = VIEW.slice(VIEW.indexOf("type: 'clock'"), VIEW.indexOf("type: 'weather'"));
  assert.match(clock, /ask: null/, 'the clock takes no choice, so it must not be editable yet');
});

test('a widget is named after what it was set to, on create AND on edit', () => {
  // Four widgets all called "Loteria" is what the playlist looked like before, and it is genuinely
  // impossible to tell which shows which draw.
  assert.match(VIEW, /function widgetName\(entry, value\)/);
  const add = VIEW.slice(VIEW.indexOf('async function showAddItemModal'));
  assert.match(add, /const name = widgetName\(entry, value\)/,
    'creation uses the shared naming rule');
  const edit = VIEW.slice(VIEW.indexOf('async function showEditWidgetModal'),
    VIEW.indexOf('async function showAddItemModal'));
  assert.match(edit, /name: entry\.ask\.options \? widgetName\(/,
    'editing renames too, or the list contradicts the setting');
});

test('the server pushes an edited widget to displays already showing it', () => {
  const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'widgets.js'), 'utf8');
  const put = routes.slice(routes.indexOf("router.put('/:id'"), routes.indexOf("router.delete('/:id'"));

  assert.match(put, /UPDATE widgets SET config/, 'config is persisted');
  assert.match(put, /queueOrEmitPlaylistUpdate/,
    'an edit must reach the wall without restarting the player (#234)');
  assert.match(put, /pi\.widget_id = \?/,
    'only the devices actually showing this widget are disturbed');
  assert.match(put, /checkWidgetsEnabled/,
    'editing is gated by the same plan check as creating');
});

test.after(() => {
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* windows locks */ }
});

test('a save RETIRES keys the catalogue stopped writing', () => {
  // Merging alone leaves a key the catalogue no longer writes at whatever value it had, forever.
  // That is how a news widget kept item_seconds: 9 through every edit and went on showing a
  // headline and a slice of the next in a fifteen-second slot, and how background '#000000' from
  // the ticker era kept painting the card black under its own backdrop.
  assert.match(VIEW, /function mergedConfig\(entry, current, value\)/);
  assert.match(VIEW, /config: mergedConfig\(entry, config, value\)/,
    'the edit must save through the merge-and-retire path, not a plain spread');

  const cat = VIEW.slice(VIEW.indexOf('const WIDGET_CATALOGUE'), VIEW.indexOf('function catalogueFor'));
  for (const dead of ['scroll_speed', 'background', 'font_size']) {
    assert.ok(cat.includes(`'${dead}'`), `${dead} must be named as retired somewhere in the catalogue`);
  }
  // A value the catalogue OWNS has to be restated on every save or the stale one wins.
  assert.match(cat, /item_seconds: 25/, 'news restates its hold');
  assert.match(cat, /game_seconds: 25/, 'the lottery restates its hold');
  // ...and the keys an older widget still needs must NOT be retired.
  assert.ok(!/drops: \[[^\]]*'games'/.test(cat), 'games is what a lottery widget shows');
  assert.match(cat, /drops: \[[^\]]*'feed_url'/, 'the single-feed key is superseded by feed_urls');
});

test('the cleanup migration leaves ticker widgets alone', () => {
  const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'db', 'database.js'), 'utf8');
  const fn = dbSrc.slice(dbSrc.indexOf('function retireDeadWidgetConfigKeys'),
    dbSrc.indexOf('retireDeadWidgetConfigKeys();', dbSrc.indexOf('function retireDeadWidgetConfigKeys')));

  assert.match(fn, /cfg\.mode === 'ticker'/,
    'a crawling ticker still reads scroll_speed and font_size — cleaning it would break it');
  assert.match(fn, /schema_migrations/, 'the cleanup runs once, not on every boot');
  assert.ok(!/delete cfg\.game\b/.test(fn) && !/'game'/.test(fn),
    'a widget created before the multi-select still shows `game`');
});
