'use strict';

/*
 * Three things a light page exposed that a dark one had been hiding.
 *
 * None of them was caused by the theme. The theme only stopped them being invisible, which is the
 * useful part: a control nobody can use and a colour nobody can read both survive indefinitely on
 * a dark ground where everything is a little dim anyway.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const layoutView = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'views', 'layout-editor.js'), 'utf8');
const reportsView = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'views', 'reports.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'frontend', 'css', 'main.css'), 'utf8');
const layoutRoute = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'layouts.js'), 'utf8');

/* WCAG contrast, and alpha compositing, because these colours sit on top of others. */
function luminance(hex) {
  const c = hex.replace('#', '');
  const v = [0, 2, 4].map((i) => {
    const s = parseInt(c.slice(i, i + 2), 16) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function over(fg, alpha, bg) {
  const ch = (h) => [0, 2, 4].map((i) => parseInt(h.replace('#', '').slice(i, i + 2), 16));
  const [f, b] = [ch(fg), ch(bg)];
  return '#' + f.map((c, i) => Math.round(c * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('');
}

test('the delete button is only offered to somebody the server would obey', () => {
  /*
   * THE ONE THAT MATTERED. routes/layouts.js refuses to delete a template unless the caller holds
   * a platform role — so on all eleven built-in templates this button was an action that could not
   * succeed, offered to exactly the people the server turns away.
   *
   * Worse than a dead control: the note at the top of layout-editor.js records that these local
   * fetches used to RESOLVE on a 403, so the refusal reported "Layout deleted" and the template
   * stayed where it was.
   */
  assert.match(layoutRoute, /layout\.is_template && !PLATFORM_ROLES\.includes\(req\.user\.role\)/,
    'the server rule this mirrors');
  assert.match(layoutView, /!isTemplate \|\| isPlatformAdmin\(\)/,
    'the button must be gated on the same condition the server enforces');
  assert.match(layoutView, /import \{ esc, isPlatformAdmin \}/);
});

test('deleting is not dressed as the thing you came to do', () => {
  // Eleven filled red buttons across a grid of system templates competed with the primary action
  // on every card. The colour still says destructive; the weight no longer says "press me".
  assert.match(layoutView, /class="btn btn-quiet btn-sm" data-delete-layout/);

  const rule = css.slice(css.indexOf('.btn-quiet {'), css.indexOf('\n}', css.indexOf('.btn-quiet {')));
  assert.match(rule, /background:\s*transparent/, 'quiet means unfilled');
  assert.match(rule, /color:\s*var\(--danger\)/, 'and still unmistakably destructive');
  assert.match(css, /\.btn-quiet:hover[\s\S]{0,120}background:\s*var\(--danger-dim\)/,
    'it may go solid on hover, where the intent is already deliberate');
});

test('a layout preview is a diagram, not another accent colour', () => {
  /*
   * The zone fill was rgba(59,130,246,…) — the fork's blue, surviving the colour sweep because it
   * was written as an rgba() inside a JS string rather than as a hex. Its label measured 3.81:1.
   */
  /*
   * Swept across the WHOLE app, and for the rgba form specifically.
   *
   * That form is how this blue survived two previous sweeps: written as rgba() inside a
   * JavaScript string it is assembled at render time, so a search for #3B82F6 never sees it and
   * no CSS tool ever parses it. Four files were still carrying it after the hex sweep had
   * reported itself clean.
   */
  const BLUE = /59[ ,]+130[ ,]+246/;
  const swept = [];
  for (const dir of ['views', 'components']) {
    const d = path.join(ROOT, 'frontend', 'js', dir);
    for (const f of fs.readdirSync(d)) {
      if (f.endsWith('.js')) swept.push([`${dir}/${f}`, fs.readFileSync(path.join(d, f), 'utf8')]);
    }
  }
  swept.push(['css/main.css', css]);

  const offenders = swept.filter(([, src]) => BLUE.test(src)).map(([n]) => n);
  assert.deepEqual(offenders, [], 'o azul do template sobreviveu em: ' + offenders.join(', '));

  const fill = over('#0F172A', 0.05, '#F7F9FB');   // the new neutral fill over the page
  assert.ok(contrast('#475569', fill) >= 4.5,
    `the zone label is ${contrast('#475569', fill).toFixed(2)}:1 on its own fill`);
  assert.match(layoutView, /color:var\(--text-secondary\);overflow:hidden/,
    'and it uses the token that measurement chose');
});

test('"offline" is one colour, defined once', () => {
  /*
   * The screen list colours state through .row-state — offline red, degraded amber, awaiting blue.
   * The report had a private green-or-grey rule and painted offline GREY, so the same fact wore
   * two colours on two pages and neither told you which was right.
   */
  const chip = reportsView.slice(reportsView.indexOf('function statusChip'), reportsView.indexOf('\n}', reportsView.indexOf('function statusChip')));
  assert.match(chip, /class="row-state \$\{esc\(s\)\}"/,
    'the report must reuse the classes rather than restate the rule');
  assert.doesNotMatch(chip, /var\(--success\)|var\(--text-muted\)/,
    'no second definition of the colour language');

  // And every state either page can produce has a colour.
  for (const state of ['offline', 'degraded', 'awaiting', 'provisioning', 'online', 'published', 'draft']) {
    assert.match(css, new RegExp(`\.row-state\.${state} \{`), `.row-state.${state} must be defined`);
  }
});

test('a state nobody has named still prints as itself', () => {
  /*
   * Um estado sem nome aparece COMO ELE MESMO -- "provisioning" na celula -- e nao como uma
   * celula vazia nem como um identificador que parece defeito.
   *
   * A forma mudou junto com o dicionario: era "t(key) === key ? s : t(key)", o idioma do "se nao
   * ha traducao, mostre o valor cru". Virou uma tabela com reserva. A regra e a mesma.
   *
   * E vale registrar como isso quase se perdeu: ao inlinar as traducoes, os dois t() foram
   * desembrulhados e a linha virou `(key) === key`, que e sempre verdade -- a tabela deixou de
   * ser consultada e TODO estado passou a aparecer cru. Nao dava erro; so dizia "offline" onde
   * dizia "Offline", numa tela que poucos abrem.
   */
  const chip = reportsView.slice(reportsView.indexOf('function statusChip'), reportsView.indexOf('\n}', reportsView.indexOf('function statusChip')));
  assert.match(chip, /STATUS\[s\] \|\| s/,
    'a reserva e o que impede a celula de sair vazia');
});
