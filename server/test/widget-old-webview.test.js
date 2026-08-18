'use strict';

/*
 * Widgets have to render on the browser the PANELS actually have, not the one we develop on.
 *
 * A real panel in the field reports, in its own user agent:
 *
 *     Chrome/80.0.3987.149 (PROSK-1000, Android 10)
 *
 * February 2020. That is not an outlier — signage hardware ships a WebView and never updates it,
 * so the fleet's floor sits years behind the desktop. What that produced was not a crash and not
 * an error in any log: the data arrived (the server answered 200 with real headlines and a real
 * Mega-Sena draw), the images downloaded, and the screen showed "carregando…" for ever, because
 * the CSS that positions and paints the content was silently discarded.
 *
 * Two rounds were needed, which is why the check below has the shape it has. The first version
 * listed PROPERTY names and fixed the news widget. The lottery stayed broken, because its balls
 * are painted with color-mix() — a FUNCTION, which a list of properties never sees. So both are
 * checked, and both with a word boundary: "round(" is a substring of "background(", and a guard
 * that cries wolf is a guard the next person in a hurry deletes.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

// Everything a PANEL renders. The dashboard is excluded deliberately: an operator sits at a
// current browser, and holding the admin UI to a 2020 baseline would cost real expressiveness
// for nobody's benefit.
const PANEL_FILES = [
  'server/lib/widget-kit.js',
  'server/routes/widgets.js',
  'server/player/index.html',
];

const FLOOR = 80;

// name -> [Chrome version that shipped it, what to write instead]
const PROPERTIES = {
  'inset': [87, 'write top/right/bottom/left in full'],
  'aspect-ratio': [88, 'use the padding-percentage box, or guard it with CSS.supports()'],
  'content-visibility': [85, 'drop it; it is an optimisation, not layout'],
  'container-type': [105, 'use a media query'],
  'accent-color': [93, 'style the control directly'],
  'text-wrap': [114, 'use explicit line breaks'],
  'inset-inline': [87, 'use left/right'],
  'inset-block': [87, 'use top/bottom'],
};

const FUNCTIONS = {
  'color-mix': [111, 'compute the blend on the server with kit.mix()'],
  'oklch': [111, 'use rgb() or a hex value'],
  'oklab': [111, 'use rgb() or a hex value'],
  'lch': [111, 'use rgb() or a hex value'],
  'lab': [111, 'use rgb() or a hex value'],
  // CSS also has round() and mod() (Chrome 125), and they are deliberately NOT listed. Both are
  // ordinary JavaScript identifiers — this codebase defines its own mod(a,n) and calls
  // Math.round() — and no amount of boundary matching separates a CSS call from a JS one inside
  // a file that is both. A guard that cries wolf is a guard the next person deletes, and nobody
  // reaches for CSS round() anyway.
};

/* Comments explain the bans and therefore name the banned things. Strip them before looking. */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
}

/* A use wrapped in CSS.supports() is the correct way to reach for something newer: the modern
   browser takes it, the old one takes the fallback. Each guard excuses its own probe and the one
   declaration it protects. */
function guarded(src, name) {
  return (src.split(`CSS.supports('${name}`).length - 1) * 2;
}

for (const rel of PANEL_FILES) {
  test(`${rel} renders on the WebView the panels actually ship (Chrome ${FLOOR})`, () => {
    const src = code(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

    for (const [name, [since, instead]] of Object.entries(PROPERTIES)) {
      // A property: a boundary, the name, then the colon. That boundary is what keeps "inset"
      // from matching "inset-inline" and, more usefully, keeps "aspect-ratio" from matching the
      // ancient "max-aspect-ratio" MEDIA FEATURE, which is unrelated and fine.
      const hits = (src.match(new RegExp(`(^|[^a-zA-Z0-9_.-])${name}\\s*:`, 'g')) || []).length;
      assert.ok(hits <= guarded(src, name),
        `${name} needs Chrome ${since}; the fleet floor is ${FLOOR}. Instead: ${instead}.`);
    }

    for (const [name, [since, instead]] of Object.entries(FUNCTIONS)) {
      // A call, with the same boundary plus the dot: "round(" lives inside
      // "background(", and Math.round() is JavaScript, not a CSS function.
      const hits = (src.match(new RegExp(`(^|[^a-zA-Z0-9_.-])${name}\\s*\\(`, 'g')) || []).length;
      assert.ok(hits <= guarded(src, name),
        `${name}() needs Chrome ${since}; the fleet floor is ${FLOOR}. Instead: ${instead}.`);
    }
  });
}

test('flex gap survives, because the kit repairs it where the browser lacks it', () => {
  const kit = fs.readFileSync(path.join(ROOT, 'server/lib/widget-kit.js'), 'utf8');
  /*
   * gap inside a flex container is Chrome 84, so by the rule above it would be banned — except
   * that banning it costs eighteen rules their one readable expression of spacing, and has to be
   * remembered by every widget written afterwards. So the kit probes for it once at runtime and,
   * only where it is missing, gives the children the equivalent margin. Keep the probe and gap
   * stays usable everywhere; delete it and spacing silently collapses on every old panel.
   */
  assert.match(kit, /display:flex; gap:10px/, 'the feature probe must still be there');
  assert.match(kit, /probe\.scrollWidth >= 10/, 'and it must actually measure the result');
  assert.match(kit, /marginTop[\s\S]{0,200}marginLeft|marginLeft[\s\S]{0,200}marginTop/,
    'and apply the margin fallback in both directions');
});

test('the colour blend the panels cannot compute is computed here instead', () => {
  const kit = require('../lib/widget-kit.js');
  assert.equal(typeof kit.mix, 'function', 'kit.mix is what replaced color-mix()');
  // Against an opaque colour: a flat blend, which is what a gradient stop needs.
  assert.equal(kit.mix('#20DF91', 82, '#000'), 'rgb(26, 183, 119)');
  // Against transparent it means "this colour, at that alpha".
  assert.equal(kit.mix('#20DF91', 60, 'transparent'), 'rgba(32, 223, 145, 0.600)');
  // Anything unparseable comes back untouched, so a var() or a colour name still renders.
  assert.equal(kit.mix('var(--accent)', 50, '#000'), 'var(--accent)');
});
