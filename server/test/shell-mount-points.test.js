'use strict';

/*
 * EVERY ELEMENT app.js REACHES FOR EXISTS — either in the shell, or because app.js made it.
 *
 * THE OUTAGE THIS IS THE RECORD OF. The sidebar footer held three things: a permanent "Connected"
 * label, a build number, and — invisibly, because it is not in the markup — the signed-in user's
 * block, which app.js BUILDS at runtime and inserts into that container.
 *
 * Removing the first two took the container with them. `footer.insertBefore(...)` then threw on a
 * null, updateSidebarUser() died, and it dies inside the render path: no user name, no sign-out
 * button, and an entirely blank content area. Two symptoms, one cause, and nothing in the markup
 * that named the dependency.
 *
 * Grepping the stylesheet and the shell for the class found nothing, which is exactly what made it
 * look safe. The mount point only exists in JavaScript, so the check has to read JavaScript.
 *
 * SCOPE: app.js only. It is the shell's own script and its selectors should all be shell elements
 * or its own creations. Views build their own DOM and are not the shell's business.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'frontend');
const app = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
const shell = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* Ids and classes app.js assigns to elements it creates itself. */
const selfMade = new Set([
  ...[...app.matchAll(/\.id\s*=\s*'([^']+)'/g)].map((m) => m[1]),
  ...[...app.matchAll(/\.className\s*=\s*'([^']+)'/g)].flatMap((m) => m[1].split(/\s+/)),
  ...[...app.matchAll(/id="([^"]+)"/g)].map((m) => m[1]),          // ids inside its own innerHTML
]);

const inShell = {
  id: (v) => new RegExp(`id="${v}"`).test(shell),
  class: (v) => new RegExp(`class="[^"]*\\b${v}\\b`).test(shell),
};

test('every id app.js looks up is provided by the shell or created by app.js', () => {
  const missing = [...new Set([...app.matchAll(/getElementById\(\s*'([^']+)'/g)].map((m) => m[1]))]
    .filter((id) => !inShell.id(id) && !selfMade.has(id));

  assert.deepEqual(missing, [],
    'procurados e inexistentes — uma chamada nesses vira null e derruba o render:\n  #' + missing.join('\n  #'));
});

test('every class app.js mounts into is provided by the shell', () => {
  /*
   * THE ONE THAT BROKE. `.sidebar-footer` is looked up here and written into, and it existed only
   * in index.html — so deleting it from the markup was invisible to every other check.
   *
   * Tag and attribute selectors are skipped: `span`, `[data-i18n]` and friends are questions about
   * page content, not about a shell element that must be there.
   */
  const missing = [...new Set([...app.matchAll(/querySelector(?:All)?\(\s*'(\.[^']+)'/g)].map((m) => m[1]))]
    .map((sel) => sel.slice(1).split(/[ >:.[,]/)[0])
    .filter((cls) => cls && !inShell.class(cls) && !selfMade.has(cls));

  assert.deepEqual(missing, [],
    'a casca não oferece estes pontos de montagem:\n  .' + missing.join('\n  .'));
});

test('the sidebar footer exists, because the user block is inserted into it', () => {
  /*
   * Named explicitly as well as covered by the sweep above, because this is the specific contract
   * that was broken and the sweep alone does not say WHY the element has to stay. An empty <div>
   * in the markup reads like something safe to tidy away; it is the only place the signed-in
   * user's name and the sign-out button have to live.
   */
  assert.match(shell, /class="sidebar-footer"/, 'o rodapé é o ponto de montagem do bloco do usuário');
  assert.match(app, /querySelector\('\.sidebar-footer'\)/);
  assert.match(app, /if \(!footer\)/, 'e a ausência dele nunca mais pode lançar');
});

test('the sign-out button has somewhere to be', () => {
  // The visible half of the same failure: no footer, no user block, no way to log out.
  assert.match(app, /id="logoutBtn"/);
  assert.match(app, /getElementById\('logoutBtn'\)/);
});
