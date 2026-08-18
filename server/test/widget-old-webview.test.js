'use strict';

/*
 * Widgets have to render on the browser the PANELS actually have, not the one we develop on.
 *
 * A real panel in the field reports, in its own user agent:
 *
 *     Chrome/80.0.3987.149 (PROSK-1000, Android 10)
 *
 * February 2020. That is not an outlier — signage hardware ships a WebView and never updates it,
 * so the fleet's floor is years behind the desktop. The failure it produced was not a crash and
 * not an error in any log: the widget's data arrived (the server answered 200 with real
 * headlines), the images downloaded, and the screen showed "carregando…" for ever, because the
 * CSS that positions the content was silently ignored.
 *
 * Nothing in the build would have caught that. This does. Each property below is banned with the
 * Chrome version that introduced it, so the message says what to use instead rather than just
 * "no".
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

// Everything a PANEL renders. The dashboard is excluded on purpose: an operator sits at a current
// browser, and holding the admin UI to a 2020 baseline would cost real expressiveness for nothing.
const PANEL_FILES = [
  'server/lib/widget-kit.js',
  'server/routes/widgets.js',
  'server/player/index.html',
];

// property -> [Chrome version that shipped it, what to write instead]
const TOO_NEW = {
  'inset:': [87, 'write top/right/bottom/left in full'],
  'aspect-ratio:': [88, 'use the padding-percentage box'],
  'content-visibility:': [85, 'remove it; it is an optimisation, not a layout'],
  ':has(': [105, 'select the child directly'],
  ':is(': [88, 'write the selectors out'],
  ':where(': [88, 'write the selectors out'],
  '@container': [105, 'use a media query'],
  'dvh': [108, 'use vh'],
  'svh': [108, 'use vh'],
};

const FLOOR = 80;

for (const rel of PANEL_FILES) {
  test(`${rel} renders on the WebView the panels actually ship (Chrome ${FLOOR})`, () => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const [needle, [since, instead]] of Object.entries(TOO_NEW)) {
      const hits = src.split(needle).length - 1;
      /*
       * Two things are not violations and must not be counted as ones.
       *
       * The media FEATURES max-aspect-ratio / min-aspect-ratio are ancient and have nothing to do
       * with the aspect-ratio PROPERTY they share a name with.
       *
       * And a use guarded by CSS.supports() is exactly the right way to use a newer property: the
       * modern browser gets it, the old one takes the fallback branch. Each guard excuses the
       * probe itself and the one styling it protects.
       */
      let excused = 0;
      if (needle === 'aspect-ratio:') {
        excused += (src.split('max-aspect-ratio:').length - 1) + (src.split('min-aspect-ratio:').length - 1);
      }
      const guards = src.split("CSS.supports('" + needle.replace(':', '')).length - 1;
      excused += guards * 2;
      assert.ok(hits <= excused,
        `${needle} needs Chrome ${since}; the fleet floor is ${FLOOR}. Instead: ${instead}.`);
    }
  });
}

test('flex gap is allowed, because the kit repairs it where the browser lacks it', () => {
  const kit = fs.readFileSync(path.join(ROOT, 'server/lib/widget-kit.js'), 'utf8');
  /*
   * gap inside a flex container is Chrome 84, so it would belong in the list above — except that
   * banning it would cost eighteen readable rules and have to be remembered by every future
   * widget. The kit tests for it once at runtime and, only where it is missing, gives the children
   * the equivalent margin. Keep that shim and gap stays usable; drop it and spacing collapses on
   * every old panel with nothing to announce it.
   */
  assert.match(kit, /display:flex; gap:10px/, 'the feature probe must still be there');
  assert.match(kit, /probe\.scrollWidth >= 10/, 'and it must actually measure the result');
  assert.match(kit, /marginTop.*marginLeft|marginLeft.*marginTop/s, 'and apply the margin fallback');
});
