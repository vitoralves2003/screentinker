'use strict';

/*
 * The theme, as a set of rules the stylesheet has to keep obeying.
 *
 * The app is a dark rail with a light application, and the two halves are held apart by nothing
 * but discipline: one token family for the sidebar, another for everything else. Discipline
 * decays, so it is written down here.
 *
 * THE FAILURE THIS GUARDS AGAINST is not "the wrong shade of grey". It is a colour written as a
 * literal — #fff, #3B82F6, rgba(255,255,255,.06) — which belongs to whichever theme the person
 * writing it had on screen at the time, and which no theme change can reach. The app already
 * carried a whole second accent colour that way: --primary was referenced eight times, defined
 * nowhere, and fell through to the blue of the project this was forked from.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'frontend');
const vars = fs.readFileSync(path.join(ROOT, 'css', 'variables.css'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'css', 'main.css'), 'utf8');
/*
 * A BARRA E O QUARTO ARQUIVO, e a razao de ela estar aqui e o que mudou nesta etapa.
 *
 * A paleta do rail vivia em variables.css como --sidebar-*, e main.css a lia. Agora a barra e
 * um componente com Shadow DOM montado pelos DOIS modulos, e ele carrega a propria paleta --
 * de proposito: ler a variavel do hospedeiro faria a barra mudar de cor conforme o modulo,
 * que e exatamente o defeito que o componente existe para acabar.
 *
 * Entao os testes do rail passaram a medir AQUI. Continuassem lendo variables.css, mediriam
 * doze variaveis que ninguem le -- verdes para sempre, sobre nada.
 */
const barra = fs.readFileSync(path.join(ROOT, 'components', 'loop-sidebar.js'), 'utf8');

function appScripts() {
  const out = [];
  for (const dir of ['views', 'components']) {
    const d = path.join(ROOT, 'js', dir);
    for (const f of fs.readdirSync(d)) {
      if (f.endsWith('.js')) out.push([path.join(dir, f), fs.readFileSync(path.join(d, f), 'utf8')]);
    }
  }
  return out;
}

/*
 * Comments removed, so a rule can be explained without breaking itself. Block comments cover both
 * CSS and JS; the line form is JS only, and is matched with the quote-safe restriction that it
 * must start the line — a "//" inside a URL string is not a comment.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

const defined = new Set([...vars.matchAll(/^\s*(--[a-z-]+)\s*:/gm)].map((m) => m[1]));

/* WCAG 2.1 relative luminance, so the numbers in variables.css can be checked rather than trusted. */
function luminance(hex) {
  const c = hex.replace('#', '');
  const full = c.length === 3 ? [...c].map((x) => x + x).join('') : c;
  const v = [0, 2, 4].map((i) => {
    const s = parseInt(full.slice(i, i + 2), 16) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const token = (name) => (new RegExp(`^\\s*${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})`, 'm').exec(vars) || [])[1];
/* O mesmo, lido do componente: e la que a paleta do rail mora. */
const tokenDaBarra = (name) =>
  (new RegExp(`^\\s*${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})`, 'm').exec(barra) || [])[1];

/* ---------------------------------------------------------------- tokens exist */

test('every token the app asks for is actually defined', () => {
  /*
   * THE BUG THIS PINS. --primary and --info were used eight times between them and defined
   * nowhere, so each use silently fell through to its literal fallback — the fork's #3B82F6. The
   * product carried a second accent colour that nobody had chosen and no theme could change.
   *
   * An undefined LENGTH is worse still: --radius-md had no fallback at all, so the declaration
   * was simply invalid and the element got no radius — a square card among rounded ones.
   */
  /*
   * SEM COMENTÁRIO, e isto já custou uma rodada — a terceira vez neste projeto que uma prova
   * acusa a própria prosa.
   *
   * Quando `--sidebar-width` saiu de variables.css, este teste continuou acusando "usado e não
   * definido". O único lugar que ainda o citava era um comentário em main.css explicando POR QUE
   * a variável saiu. O arquivo já tinha `stripComments` justamente para isto; esta varredura é
   * que não o usava.
   */
  const used = new Set();
  for (const [, src] of [['main.css', main], ...appScripts()]) {
    for (const m of stripComments(src).matchAll(/var\((--[a-z-]+)/g)) used.add(m[1]);
  }
  const missing = [...used].filter((v) => !defined.has(v));
  assert.deepEqual(missing, [], `usados e não definidos: ${missing.join(', ')}`);
});

test('no var() carries a fallback colour', () => {
  /*
   * Every fallback in this codebase was a DARK literal — var(--bg-card, #111827). Harmless while
   * the token resolves, and worse than harmless if it ever does not: the fallback paints the old
   * theme into the new page, and the result looks like a design decision rather than a fault.
   * The answer to a missing token is a defined token, which the test above enforces.
   */
  const offenders = [];
  for (const [name, src] of [['css/main.css', main], ...appScripts()]) {
    for (const m of stripComments(src).matchAll(/var\(--[a-z-]+,\s*(#[0-9a-fA-F]{3,8}|rgba?\()/g)) {
      offenders.push(`${name}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n  '));
});

/* ---------------------------------------------------------------- the two halves */

test('a folha da aplicacao nao le mais nenhum token do rail', () => {
  /*
   * ESTE TESTE MUDOU DE PERGUNTA, e a antiga tinha deixado de significar algo.
   *
   * Ela era: "um valor --sidebar-* so pode ser lido por um seletor que E o rail". Fazia sentido
   * quando main.css desenhava a barra. Agora quem a desenha e o componente, com paleta propria,
   * e main.css nao le NENHUM token do rail -- a versao anterior deste teste passaria varrendo
   * uma lista vazia, verde para sempre, sobre nada.
   *
   * A pergunta que sobrou e mais simples e mais forte: a folha da aplicacao nao toca na paleta
   * do rail, ponto. No dia em que um card do conteudo pedir --sidebar-bg porque quis um painel
   * escuro, as duas paletas voltam a ser uma.
   */
  const offenders = [];

  for (const m of main.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/var\(--sidebar-/.test(m[2])) continue;
    offenders.push(m[1].replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').trim().slice(-70));
  }

  assert.deepEqual(offenders, [],
    'estes leem um token do rail, que nao e mais deles:\n  ' + offenders.join('\n  '));

  // E a paleta esta no componente, com o valor de sempre.
  assert.equal(tokenDaBarra('--bg'), '#031525', 'a cor do rail mudou de valor');
});

test('the page ground is light and the rail is dark', () => {
  const ground = token('--bg-primary');
  assert.ok(luminance(ground) > 0.7, `--bg-primary ${ground} should be a light ground`);
  assert.ok(luminance(tokenDaBarra('--bg')) < 0.05, 'the rail should stay dark');
});

/* ---------------------------------------------------------------- measured contrast */

test('body text clears AA against both the page and a card', () => {
  const ground = token('--bg-primary');
  const card = token('--bg-card');
  for (const name of ['--text-primary', '--text-secondary', '--text-muted']) {
    for (const [surface, hex] of [['página', ground], ['cartão', card]]) {
      const r = contrast(token(name), hex);
      assert.ok(r >= 4.5, `${name} sobre ${surface}: ${r.toFixed(2)}:1 (mínimo 4,5)`);
    }
  }
});

test('every status colour is legible as text, which none of the old ones were', () => {
  /*
   * #22C55E measured 2.28:1 on a white card and #F59E0B measured 2.15:1. Both read perfectly on
   * the old dark ground; both became decoration on this one. A status that cannot be read is a
   * status that is not being reported.
   */
  const card = token('--bg-card');
  for (const name of ['--success', '--danger', '--warning', '--info']) {
    const r = contrast(token(name), card);
    assert.ok(r >= 4.5, `${name}: ${r.toFixed(2)}:1 sobre cartão`);
  }
});

test('the brand green is used as a surface, never as ink', () => {
  /*
   * THE MEASUREMENT THE WHOLE PALETTE TURNS ON. #20DF91 on white is 1.75:1 — it fails as text,
   * and fails again as a border, where the bar is only 3:1. So it keeps the one job it is good
   * at: a filled surface, with --accent-on over it. Everything read as ink takes --accent-ink.
   */
  const white = token('--bg-card');
  assert.ok(contrast(token('--accent'), white) < 3,
    'if the brand green ever passes on white, this rule can be revisited — until then it cannot be ink');
  assert.ok(contrast(token('--accent-on'), token('--accent')) >= 4.5,
    'text on a filled brand button');
  assert.ok(contrast(token('--accent-ink'), white) >= 4.5,
    'the ink green has to be readable, which is its entire reason for existing');
});

test('the rail\'s own colours still hold against the rail', () => {
  const rail = tokenDaBarra('--bg');
  assert.ok(contrast(tokenDaBarra('--texto'), rail) >= 4.5);
  assert.ok(contrast(tokenDaBarra('--marca'), rail) >= 4.5,
    'the brand green is at its best here — which is what lets it be sober in the content area');
});

/* ---------------------------------------------------------------- no literals creeping back */

test('no colour is written as a literal outside the places that earn it', () => {
  /*
   * Three kinds of literal are legitimate and everything else is a theme waiting to break:
   *
   *   #000 / #0003        a media surface — a video, a screenshot, a scrim over one. Dark whatever
   *                       the page does, because the thing behind it is.
   *   #fff                white ON one of those scrims, or on a filled status colour.
   *   the sidebar block   still a dark theme, and correct there.
   */
  const allowed = /^#(fff|ffffff|000|000000|0003)$/i;
  const offenders = [];

  for (const [name, src] of appScripts()) {
    src.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      for (const m of line.matchAll(/(?:color|background|border[a-z-]*|fill|stroke)\s*:\s*(#[0-9a-fA-F]{3,8})/g)) {
        if (!allowed.test(m[1])) offenders.push(`${name}:${i + 1} ${m[0]}`);
      }
    });
  }

  assert.deepEqual(offenders, [],
    `cor literal fora de token:\n  ${offenders.join('\n  ')}`);
});

test('nenhum veu branco sobrou na folha da aplicacao', () => {
  /*
   * Num fundo escuro um veu branco e um realce; neste, nao e nada. Seis deles estavam espalhados
   * pelo conteudo e simplesmente nao renderizavam.
   *
   * ANTES ESTE TESTE ABRIA UMA EXCECAO para o bloco da barra, recortando 4000 caracteres a
   * partir de "/* Sidebar" e olhando o resto. A barra saiu de main.css: a excecao virou um
   * recorte de posicao -1 -- que nao explodia, so media um pedaco arbitrario do arquivo.
   *
   * Sem barra na folha, nao ha excecao a abrir. O veu que sobrevive vive no componente, onde o
   * fundo e escuro de verdade.
   */
  assert.doesNotMatch(main, /rgba\(255,\s*255,\s*255/,
    'um veu branco fora do rail e invisivel numa pagina clara');

  assert.match(barra, /rgba\(255,\s*255,\s*255/,
    'o veu do rail mora no componente agora');
});

/* ---------------------------------------------------------------- runtime overrides */

/*
 * NOTHING REPAINTS THE THEME AT RUNTIME.
 *
 * This section used to test the white-label engine, which applied a stored brand by writing custom
 * properties onto <html> as an INLINE style — and an inline style beats every stylesheet. That is
 * what made the light theme look half-finished in production: a tenant row still holding
 * bg_color #06111e from the dark era repainted the page ground dark while every other token came
 * from the new palette. Dark text on a dark page, with nothing in the CSS to explain it.
 *
 * The engine is gone: Loop Player is one product with one brand, so there is no stored colour to
 * apply and no reason for any script to touch a token. What survives is the rule underneath it,
 * now stated for the whole app rather than for two files — because the failure was never really
 * about branding, it was about a value that no stylesheet could reach.
 */

test('no script writes a surface or text token', () => {
  const offenders = [];
  for (const [name, src] of appScripts()) {
    for (const m of src.matchAll(/setProperty\(\s*['"`](--[a-z-]+)/g)) {
      const tok = m[1];
      if (/^--(bg|text|border|surface)/.test(tok)) offenders.push(`${name}: ${tok}`);
    }
  }
  assert.deepEqual(offenders, [],
    'estes repintam o tema em tempo de execução:\n  ' + offenders.join('\n  '));
});

test('the white-label engine is gone, not merely unused', () => {
  /*
   * Checked as files rather than as behaviour, because a dormant copy is exactly how this comes
   * back: the modules were imported from app.js and from a pre-paint <script> in the shell, and
   * either one restored by a later merge would silently start overriding the palette again.
   */
  for (const f of ['brand-prime.js', 'branding.js']) {
    assert.ok(!fs.existsSync(path.join(ROOT, 'js', f)), `frontend/js/${f} deveria ter sido removido`);
  }
  const shell = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.doesNotMatch(shell, /brand-prime|ssr-brand/, 'a casca não carrega mais um repintador');
});


/* ---------------------------------------------------------------- the surface/ink rule, enforced */

test('the brand green is never READ — not as text, not as a border', () => {
  /*
   * THE RULE EXISTED AND NOTHING ENFORCED IT.
   *
   * variables.css states it in capitals: #20DF91 is a surface, never ink. The test above proves
   * the VALUE fails as text (1.75:1 on white) — and for months that was the whole of the
   * enforcement, so 49 declarations went on reading it anyway: links, active tabs, the plan name,
   * the price, focus rings, card outlines. The rule was true about the token and false about the
   * product.
   *
   * Anchored on the PROPERTY, because that is what decides whether a colour is being read or
   * looked at. `background`, `accent-color` and a color-mix() tint are all fills and stay on
   * --accent, where the green is at its best.
   *
   * The negative lookbehind matters: `accent-color:` ends in "color" and paints a range input's
   * filled track, which is a surface.
   */
  const PATTERNS = [
    /(?<![-\w])color\s*:\s*var\(--accent\)/g,
    /border(?:-(?:bottom|top|left|right))?-color\s*:\s*var\(--accent\)/g,
    /border(?:-(?:bottom|top|left|right))?\s*:\s*\d+px\s+solid\s+var\(--accent\)/g,
  ];

  const offenders = [];
  for (const [name, src] of [['css/main.css', main], ...appScripts()]) {
    for (const re of PATTERNS) {
      for (const m of src.matchAll(re)) offenders.push(`${name}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [],
    'a marca está sendo lida, não olhada — use --accent-ink:\n  ' + offenders.join('\n  '));
});

/* ---------------------------------------------------------------- the rail's own status colours */

test('the rail has status colours that work on the rail', () => {
  /*
   * A SECOND TRIAD, because the first one cannot serve here.
   *
   * The content palette was darkened until each colour passed as text on a WHITE card. Measured
   * against the rail, --danger is 2.81:1 — under the 3:1 bar for a coloured mark — which is why
   * the offline count sank into the sidebar instead of jumping off it. Same hues, taken the other
   * way.
   */
  /*
   * A TRIADE VIROU UMA COR SO, e nao por descuido: com a barra virando componente, as unicas
   * regras que liam --sidebar-warning e --sidebar-success eram o status de conexao e o selo de
   * versao, que sairam junto. Sobrou o vermelho, que a pilula de atencao usa.
   *
   * As duas nao foram reintroduzidas "por simetria": um token definido sem ninguem que o leia e
   * a proxima pessoa achando que existe uma regra onde nao existe.
   */
  const rail = tokenDaBarra('--bg');
  const r = contrast(tokenDaBarra('--perigo'), rail);
  assert.ok(r >= 4.5, `--perigo: ${r.toFixed(2)}:1 contra a rail`);

  // And the content triad is confirmed unusable here, so nobody "simplifies" this away later.
  assert.ok(contrast(token('--danger'), rail) < 3,
    'se --danger algum dia passar na rail, esta regra pode ser revista — até lá não pode');
});

test('the fleet alert is a readable line on the rail, not a pill', () => {
  /*
   * IT WAS A BADGE, AND THE BADGE HAD TWO PROBLEMS.
   *
   * The colour one: it used --danger, which is tuned for a white card and measures 2.81:1 against
   * the rail, so the warning sank into the sidebar instead of jumping off it.
   *
   * The wording one, which mattered more: a red circle containing "1" asks a question. One what?
   * A line reading "1 tela offline" has already answered it, and it sits under the workspace name
   * where the eye lands after establishing whose screens these are.
   *
   * The pill needed a fill one step darker than the rail's danger ink — white on #EF4444 is
   * 3.76:1 and fails an 11px label. A line needs no fill at all, so --sidebar-danger is read
   * directly, at 4.90:1, and the extra token went with the pill.
   */
  /*
   * MUDOU DE ARQUIVO E DE NOME: era `.fleet-alert` em main.css, e virou `.atencao` dentro do
   * componente. O raciocinio acima nao mudou uma virgula -- por isso o teste seguiu junto em vez
   * de ser apagado.
   */
  const alerta = /\.atencao\s*\{([^}]*)\}/.exec(barra);
  assert.ok(alerta, 'o componente deve definir .atencao');
  assert.match(alerta[1], /color:\s*var\(--perigo\)/,
    'a linha usa o vermelho da rail, não o do conteúdo');

  assert.doesNotMatch(barra, /nav-badge/, 'o balão foi substituído pela linha');
  assert.doesNotMatch(main, /\.fleet-alert/, 'a versão em main.css saiu quando a barra virou componente');

  // atenção — a pílula só é emitida quando há telas em atenção.
  assert.match(barra, /atencao > 0 \?/,
    'a pílula é condicional: um indicador permanente deixa de ser lido');
});

/* ---------------------------------------------------------------- one word, one colour */

test('a state means the same colour everywhere it appears', () => {
  /*
   * "Provisioning" wore three different colours in three files — amber on the dot, grey on the
   * row label, grey on the row stripe. A screen waiting to be paired is mid-setup, not a fault,
   * and amber made every fresh install look like an alert.
   *
   * Read out of the stylesheet rather than asserted as a list of hexes, so the test is about
   * AGREEMENT and keeps holding when the palette moves.
   */
  const valueOf = (selector, prop) => {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, (c) => "\\" + c);
    const m = new RegExp(`${esc}\\s*\\{[^}]*\\b${prop}\\s*:\\s*([^;}]+)`).exec(main);
    assert.ok(m, `${selector} não define ${prop}`);
    return m[1].trim();
  };

  const dot = valueOf('.status-dot.provisioning', 'background');
  const label = valueOf('.row-state.provisioning', 'color');
  assert.equal(dot, label, 'o ponto e o rótulo discordam sobre "provisionando"');

  // The one thing it must NOT be is the alert colour: nothing is wrong.
  assert.doesNotMatch(dot, /--warning/, 'aguardar pareamento não é um alerta');
});
