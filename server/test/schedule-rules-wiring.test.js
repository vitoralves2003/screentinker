'use strict';

/*
 * The rules have to survive the whole way to a player, and that path crosses three files:
 * routes/content.js stores them, routes/playlists.js compiles them into the payload, and
 * services/schedule-horizon.js keeps the expansion from expiring. Each of those is a place where
 * a schedule can be lost without anything failing — the file stays in the list, still looks
 * scheduled, and simply never plays.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const srv = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const web = (...p) => fs.readFileSync(path.join(ROOT, '..', 'frontend', 'js', ...p), 'utf8');

const playlists = srv('routes', 'playlists.js');
const content = srv('routes', 'content.js');
const horizon = srv('services', 'schedule-horizon.js');
const editor = web('components', 'schedule-rules-editor.js');
const library = web('views', 'content-library.js');

test('the payload path compiles the rules', () => {
  /*
   * schedulesFor() is the single point every schedule crosses on its way to a device. If it stops
   * calling the compiler, typed rules become invisible: nothing errors, the file just plays
   * whenever, because the evaluator reads "no blocks" as "no schedule".
   */
  assert.match(playlists, /const \{ compileRules \} = require\('\.\.\/lib\/schedule-compile'\)/);
  const fn = playlists.slice(playlists.indexOf('function schedulesFor('), playlists.indexOf('const _assetRules'));
  assert.match(fn, /compileRules\(readAssetRules\(contentId, widgetId\)\)/);
});

test('the older block schedules are still read alongside the rules', () => {
  // content_schedules predates the rules table. Dropping it from the read would silently unschedule
  // anything written before this change.
  const fn = playlists.slice(playlists.indexOf('function schedulesFor('), playlists.indexOf('const _assetRules'));
  assert.match(fn, /_assetBlocks\.all/, 'legacy blocks must still be read');
  assert.match(fn, /legacy\.concat\(compiled\)/, 'and unioned with the compiled ones');
});

test('the route refuses a rule set too broad to push instead of truncating it', () => {
  /*
   * Truncation is the dangerous option: the operator sees the rule they typed, the fleet gets a
   * prefix of it, and the difference shows up as content missing on some dates months later.
   */
  assert.match(content, /MAX_COMPILED_BLOCKS/);
  const put = content.slice(content.indexOf("router.put('/:id/schedule-rules'"));
  assert.match(put, /blocks\.length > MAX_COMPILED_BLOCKS/);
  assert.match(put, /status\(400\)/);
  assert.ok(put.indexOf('validateRules(rules)') < put.indexOf('db.transaction'),
    'validation has to happen before anything is written');
});

test('the sweep only republishes playlists whose expansion is actually running out', () => {
  /*
   * A sweep that republished everything daily would push the whole fleet for no reason, and the
   * churn would be indistinguishable from a real change in the activity log.
   */
  assert.match(horizon, /status = 'published'/, 'drafts serve nobody');
  assert.match(horizon, /EXISTS \(SELECT 1 FROM content_schedule_rules/, 'only content that has rules');
  assert.match(horizon, /p\.updated_at < \?/,
    'staleness is the AGE OF THE PUBLISH — recompiling from today always looks fresh and would never fire');
  assert.match(horizon, /if \(!b\.end_date\) return null/,
    'a schedule with unbounded blocks can never run out and must be skipped');
});

test('the editor hands rules back and never writes them itself', () => {
  const mount = editor.slice(editor.indexOf('export function mountScheduleRulesEditor'));
  assert.doesNotMatch(mount, /\bapi\./, 'the form that contains it owns saving');
  assert.doesNotMatch(mount, /onSave/);
  assert.match(mount, /read\(\)/);
});

test('the file dialog validates the rules before writing anything else', () => {
  const save = library.slice(library.indexOf("querySelector('#saveEditBtn')"));
  const validateAt = save.indexOf('scheduleEditor.read()');
  const writeAt = save.indexOf("await fetch('/api/content/");
  assert.ok(validateAt >= 0 && writeAt >= 0, 'both anchors must exist or this proves nothing');
  assert.ok(validateAt < writeAt, 'a rejected schedule must not leave the name and expiry applied');
  assert.match(save, /api\.setScheduleRules\(/, 'and the rules must actually be saved');
});

test('every rule type the compiler knows is offered in the UI and named in Portuguese', () => {
  /*
   * A type the compiler accepts but the editor never offers is dead code; a type the editor offers
   * but the compiler rejects is a save that fails with a validation error the operator cannot act
   * on. They have to be the same set.
   */
  const { RULE_TYPES } = require('../lib/schedule-compile');
  // O nome de cada tipo mora na tabela TIPO_AGENDA do proprio editor desde que o dicionario
  // saiu. Um tipo que o compilador aceita e a tela nao oferece e uma regra impossivel de criar;
  // um que a tela oferece sem nome aparece como identificador cru no menu.
  const tabela = editor.slice(editor.indexOf('const TIPO_AGENDA = {'),
    editor.indexOf('};', editor.indexOf('const TIPO_AGENDA = {')));
  for (const type of RULE_TYPES) {
    assert.ok(editor.includes(`'${type}'`), `${type} nao esta no menu de tipos do editor`);
    assert.match(tabela, new RegExp("'" + type + "':"), `${type} nao tem nome em portugues`);
  }
});

test('the sentence covers every rule type, so no rule is silently unexplained', () => {
  /*
   * The sentence is the only place the AND/OR semantics are stated. A type missing from it reads
   * as though it were not there at all, which is worse than no sentence.
   */
  const { RULE_TYPES } = require('../lib/schedule-compile');
  const describe = editor.slice(editor.indexOf('export function describeRules'), editor.indexOf('// ---- validation'));
  for (const type of RULE_TYPES) {
    assert.ok(describe.includes(`'${type}'`), `describeRules() says nothing about ${type}`);
  }
});
