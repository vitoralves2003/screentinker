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

test('quem esta na sessao, e a saida, continuam tendo onde morar', () => {
  /*
   * O CONTRATO E O MESMO; O LUGAR MUDOU.
   *
   * Eram dois testes sobre `.sidebar-footer` no index.html: o rodape era o unico lugar onde o
   * nome de quem entrou e o botao de sair podiam viver, e um <div> vazio na marcacao parece
   * algo seguro de arrumar. A frase continua valendo, so que o rodape agora e do componente.
   *
   * Os dois ficaram vermelhos quando a barra virou componente e assim permaneceram por duas
   * etapas, no meio de outros vermelhos que ninguem olhava. E o custo de deixar vermelho de
   * pe: o proximo vermelho, o de verdade, chega num lugar onde ninguem mais olha.
   */
  const barra = fs.readFileSync(path.join(ROOT, 'components', 'loop-sidebar.js'), 'utf8');

  assert.match(barra, /class="pessoa"/, 'o componente desenha quem esta na sessao');
  assert.match(barra, /class="sair"/, 'e a saida');

  // O componente nao sabe COMO sair -- isso e do hospedeiro, e e diferente nos dois modulos.
  assert.match(barra, /new CustomEvent\('sair'/, 'ele avisa, nao decide');
  assert.match(app, /addEventListener\('sair'/, 'e a Operacao escuta');
});
