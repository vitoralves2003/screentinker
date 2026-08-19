'use strict';

/*
 * Nothing this server hands to the public may name the product this one was forked from.
 *
 * Found live, on the customer-facing domain, long after the rebrand was "finished":
 *
 *   GET /                                -> the upstream project's marketing homepage: its
 *                                           name, its positioning, its pricing tiers
 *   GET /compare/xibo-alternative.html   -> "Best Xibo Alternative (2026): <upstream> vs Xibo",
 *                                           and four more selling that product against rivals
 *   GET /guides/*, /integrations/*       -> twelve more SEO pages, same
 *   GET /api-docs.html                   -> "<upstream> API Reference"
 *   the dashboard, in five of seven languages -> "Install the <upstream> app on your TV"
 *
 * All of it HTTP 200 from the domain paying customers are given, and none of it reachable from
 * inside the app - which is exactly why it survived: nobody clicks their way there, so a rebrand
 * done by walking the UI finds none of it.
 *
 * A rebrand is not a state you reach, it is a property you keep. It is checked here so the next
 * person to copy a file down from upstream trips over it before the customers do.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const FRONTEND = path.join(ROOT, 'frontend');

const OTHER_BRAND = /screentinker/i;

/*
 * WIRE VALUES are exempt, and that is the rule rather than a hole in it.
 *
 * Each of these is matched, byte for byte, by something outside the file it lives in:
 *
 *   'screentinker-export-v1'   stamped inside every backup ever exported; rename it and those
 *                              files stop importing, which shows nobody anything
 *   'screentinker-preview'     the postMessage channel between dashboard and preview iframe,
 *                              both ends of which have to agree
 *   'screentinker'             a sync_backend value already written in customers' databases
 *   backend_screentinker       an i18n KEY compared against that value; the translated TEXT
 *                              beside it is the part a person reads
 *
 * Nobody ever sees one of them. What people see is prose, and prose is what is banned - so the
 * exemption is deliberately narrow: quoted, and entirely lowercase. Anything that reads as a
 * NAME (capitalised, or loose in a sentence) is still caught.
 */
function stripWireValues(src) {
  // Quoted, and entirely lowercase: an identifier, not a sentence. A translation KEY qualifies
  // as much as a protocol string - the key is machine-facing, its value is the prose.
  return src.replace(/['"`][a-z0-9_.-]*screentinker[a-z0-9_.-]*['"`]/g, "''");
}

/*
 * Two files are known to still name the other product, and both are deliberate:
 *
 *   legal/*.html   the Terms of Service and Privacy Policy. These are not a branding problem,
 *                  they are a legal one: they name the other company, place the agreement under
 *                  the laws of Wisconsin, and give that company's support address as the contact
 *                  - while being linked from the login page and from Configurações, where every
 *                  paying tenant can read them. Rewriting them is the operator's decision (which
 *                  entity, which jurisdiction, LGPD rather than the US framing), not a mechanical
 *                  find-and-replace, so they are left exactly as found and flagged instead.
 *
 *   landing.html   still the upstream marketing page, but no longer SERVED: `/` redirects to the
 *                  app unless HOMEPAGE_ENABLED is set. Kept as a skeleton for a real Loop Player
 *                  homepage; whoever writes that page removes it from this list.
 *
 * The list is asserted EXACTLY, so it fails both ways: a new offender fails, and cleaning one up
 * without deleting its line here fails too. That is the point - the exemption expires by itself.
 */
const KNOWN_PENDING = [
  'frontend/landing.html',
  'frontend/legal/privacy.html',
  'frontend/legal/terms.html',
  'frontend/legal/third-party.html',
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'vendor') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(html|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function offenders() {
  const found = [];
  for (const file of walk(FRONTEND)) {
    if (!OTHER_BRAND.test(stripWireValues(fs.readFileSync(file, 'utf8')))) continue;
    found.push(path.relative(ROOT, file).split(path.sep).join('/'));
  }
  return found.sort();
}

test('no page or string the dashboard serves names the product this was forked from', () => {
  assert.deepEqual(offenders(), KNOWN_PENDING,
    'anything here beyond the known-pending list is another product\u2019s name, live on this ' +
    'domain, in front of paying customers');
});

test('the marketing pages selling another product are gone, and stay gone', () => {
  for (const dir of ['compare', 'guides', 'integrations']) {
    assert.equal(fs.existsSync(path.join(FRONTEND, dir)), false,
      `frontend/${dir}/ was public SEO for the upstream project, served from this domain`);
  }
});

test('the front door does not open onto a marketing page by default', () => {
  const cfg = fs.readFileSync(path.join(ROOT, 'server', 'config.js'), 'utf8');
  /*
   * The default has to be OFF. landing.html is still the other product's page; while it is, `/`
   * must redirect to the app. Whoever rewrites it turns HOMEPAGE_ENABLED on, and in doing so
   * takes responsibility for what the page says.
   */
  assert.match(cfg, /homepageEnabled:[\s\S]{0,400}HOMEPAGE_ENABLED/,
    'the homepage must be opt-IN, not opt-out');
  assert.doesNotMatch(cfg, /disableHomepage:/,
    'the old opt-out default is what put another company\u2019s shopfront on this domain');
});
