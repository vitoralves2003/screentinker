'use strict';

/*
 * The schedule editor, and the two bugs that were live when it was reworked.
 *
 * THE ONE THAT WOULD HAVE BITTEN FIRST: extracting the editor out of views/playlists.js left
 * validateScheduleBlocks behind in that file. The component called it with nothing importing it, so
 * every save threw ReferenceError — a button that does nothing, no message, nothing in the UI to
 * suggest where to look. It survived because nobody had saved a schedule since the extraction.
 *
 * THE ONE THAT WAS REPORTED: the content library opened the editor as a modal ON TOP of the file
 * dialog. Two Cancel buttons and two Save buttons on screen, and the inner one wrote immediately
 * while the outer had its own Save — so a schedule could be stored and then apparently undone by
 * pressing Cancelar underneath.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, 'frontend', 'js', ...p), 'utf8');

const editor = read('components', 'schedule-editor.js');
const library = read('views', 'content-library.js');
const devicePage = read('views', 'device-detail.js');

test('every function the editor calls is one it can reach', () => {
  /*
   * The specific failure: a helper left behind in the view the component was extracted from. It
   * cannot be caught by reading either file alone — the call looks fine, the definition looks
   * fine, and they are in different modules.
   */
  const called = [...editor.matchAll(/\b(validateScheduleBlocks|scheduleSummary|blockSummary|daysSummary)\s*\(/g)]
    .map((m) => m[1]);
  for (const name of new Set(called)) {
    const imported = new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from`).test(editor);
    const defined = new RegExp(`function ${name}\\b`).test(editor);
    assert.ok(imported || defined, `${name}() is called but neither imported nor defined`);
  }
});

test('the shared validator exists and both shapes go through it', () => {
  const shared = read('schedule-validate.js');
  assert.match(shared, /export function validateScheduleBlocks/);
  assert.match(editor, /import \{ validateScheduleBlocks \} from '\.\.\/schedule-validate\.js'/);
  // And the copy it was extracted from is gone, because two copies drift.
  assert.doesNotMatch(read('views', 'playlists.js'), /function validateScheduleBlocks/,
    'a second copy is how the client and the server stop agreeing');
});

test('the file dialog embeds the editor rather than stacking a modal on itself', () => {
  // The file dialog now mounts the typed-rule editor; the block editor above is still what the
  // device page's opening hours uses, which is why both shapes are checked in this file.
  assert.match(library, /mountScheduleRulesEditor\(host, rules\)/,
    'the content library must mount it inline');
  assert.doesNotMatch(library, /showScheduleEditor\(/,
    'and must not open the modal shape from inside a modal');
  assert.match(library, /id="editScheduleHost"/);
});

test('the embedded editor never writes on its own', () => {
  /*
   * The whole point of the inline shape. An editor inside a form that persists behind the form's
   * button is how "I pressed Cancel" and "it was saved" become true at the same time.
   */
  const mount = editor.slice(editor.indexOf('export function mountScheduleEditor'),
    editor.indexOf('export function showScheduleEditor'));
  assert.doesNotMatch(mount, /\bapi\./, 'the inline editor must not call the API');
  assert.doesNotMatch(mount, /onSave/, 'nor take a save callback — the form owns saving');
  assert.match(mount, /read\(\)/, 'it hands its blocks back instead');
});

test('the form validates the schedule BEFORE writing anything else', () => {
  /*
   * Saving the name and the expiry and then rejecting the blocks would leave the dialog half
   * applied, with nothing on screen saying which half.
   */
  const save = library.slice(library.indexOf("querySelector('#saveEditBtn')"));
  const validateAt = save.indexOf('scheduleEditor.read()');
  /*
   * The metadata write is a raw fetch, not an api.* call. Matching the wrong name made this
   * assertion skip itself silently — the exact shape of vacuous test worth avoiding, so it now
   * anchors on what the handler actually does.
   */
  const writeAt = save.indexOf("await fetch('/api/content/");
  assert.ok(validateAt >= 0, 'the save must read the editor');
  assert.ok(writeAt >= 0, 'and the write it must precede has to be found, or this proves nothing');
  assert.ok(validateAt < writeAt, 'validation comes before the first write');
});

test('the device page keeps the modal shape, which is correct there', () => {
  // Opening hours is edited from a page, not from inside another dialog — there is nowhere to
  // embed it, and a modal is the right answer.
  assert.match(devicePage, /showScheduleEditor\(\{/);
  assert.match(editor, /export function showScheduleEditor/);
});

test('the hours dialog opens on a block, with no presets in front of it', () => {
  /*
   * Four preset buttons used to sit above the editor. They were added when this component was
   * also the file scheduler and its block model needed explaining; that job moved to the
   * named-rule editor, and the only thing left here is a screen's opening hours. For that one
   * question the presets were four choices standing in front of the field the reader came to
   * fill in.
   *
   * Seeded in the MODAL only. The embedded shape is mounted inside forms that may legitimately
   * have no schedule at all, and inventing a block there would quietly turn "always plays" into
   * "weekdays only" the moment somebody saved that form for an unrelated reason.
   */
  assert.doesNotMatch(editor, /sched-preset|const PRESETS/, 'the preset bar is gone');
  assert.match(editor, /const DEFAULT_HOURS = \{ days: \[1, 2, 3, 4, 5\]/);

  const modal = editor.slice(editor.indexOf('export function showScheduleEditor'));
  assert.match(modal, /const seeded = \(initial && initial\.length\) \? initial : \[DEFAULT_HOURS\]/);
  // `.*` and not `[^)]*`: the call's own argument contains a closing paren
  // (querySelector('#schedHost')), so a negated-paren class stops short and never matches.
  assert.match(modal, /mountScheduleEditor\(.*, seeded\)/,
    'the seed has to reach the mount, or it is a dead variable and the dialog still opens empty');

  const mount = editor.slice(editor.indexOf('export function mountScheduleEditor'),
    editor.indexOf('export function showScheduleEditor'));
  assert.doesNotMatch(mount, /DEFAULT_HOURS/, 'the embedded shape must not invent a block');
});

test('the modal uses the product\'s own buttons, not a hardcoded colour', () => {
  // The extracted version carried style="background:#f59e0b" from the view it came from, so the
  // Save came out orange beside a green one in the dialog underneath.
  assert.doesNotMatch(editor, /background:#f59e0b/);
  assert.match(editor, /id="schedSave" class="btn btn-primary"|class="btn btn-primary" id="schedSave"/);
});
