'use strict';

/*
 * The product's own identity on the pages a customer sees before they trust it.
 *
 * The login screen and the legal pages were the upstream project's: another company's name, its
 * support address, its GitHub, and terms governed by the law of Wisconsin with a jurisdiction
 * clause naming a county in the United States. None of that fails a test suite or throws in a
 * browser — it just quietly tells every visitor they are buying from somebody else.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const front = (...p) => fs.readFileSync(path.join(ROOT, 'frontend', ...p), 'utf8');

const LEGAL = ['terms.html', 'privacy.html', 'third-party.html'];

test('no legal page speaks for the upstream company any more', () => {
  for (const f of LEGAL) {
    const html = front('legal', f);
    assert.doesNotMatch(html, /screentinker/i, `${f} still names the upstream product`);
    assert.doesNotMatch(html, /Wisconsin|Kenosha/i, `${f} still points at the upstream jurisdiction`);
  }
});

test('the legal pages carry this company, in Portuguese', () => {
  for (const f of LEGAL) {
    const html = front('legal', f);
    assert.match(html, /lang="pt-BR"/, `${f} must declare Portuguese`);
    assert.match(html, /Loop Player/, `${f} must name the product`);
    assert.match(html, /contato@loopplayer\.com\.br/, `${f} must give a contact that exists`);
  }
  // Only the two contract documents need the registered entity; the licence notices do not.
  for (const f of ['terms.html', 'privacy.html']) {
    const html = front('legal', f);
    assert.match(html, /VITOR ALVES DE OLIVEIRA/, `${f} must name the operating entity`);
    assert.match(html, /53\.336\.433\/0001-89/, `${f} must carry the CNPJ`);
  }
});

test('the terms elect a Brazilian forum and keep the consumer exception', () => {
  /*
   * A forum clause that ignores the CDC is worse than none: it reads as enforceable and is not,
   * which is exactly the sort of thing that gets an entire contract looked at sideways.
   */
  const terms = front('legal', 'terms.html');
  assert.match(terms, /Comarca de <strong>Montanha/, 'the elected forum must be the real one');
  assert.match(terms, /8\.078\/1990/, 'and it must not pretend to override the consumer code');
});

test('the privacy policy is written against the LGPD, not a foreign statute', () => {
  const privacy = front('legal', 'privacy.html');
  assert.match(privacy, /13\.709\/2018/, 'the LGPD must be the governing law');
  assert.doesNotMatch(privacy, /2258A|NCMEC/, 'US reporting statutes do not bind a Brazilian operator');
  assert.match(privacy, /art\.\s*33/, 'hosting abroad is an international transfer and must say so');
  assert.match(privacy, /Estados Unidos/, 'and must say WHERE the data actually is');
});

test('the child-protection clause is anchored in Brazilian law', () => {
  // The obligation is real and stays; it was simply written for a different country's operator.
  const terms = front('legal', 'terms.html');
  assert.match(terms, /8\.069\/1990|Estatuto da Criança/, 'the ECA is the applicable statute');
  assert.doesNotMatch(terms, /18 U\.S\.C|NCMEC/);
});

test('the login page has a brand mark, and a fallback for a white-label install', () => {
  /*
   * The logo comes from branding, so a reseller keeps their own. What must not come back is a
   * width cap that squeezes the wordmark into something that reads as a broken image.
   */
  const login = front('js', 'views', 'login.js');
  assert.match(login, /branding\.logo_url/, 'the mark is branding-driven');
  assert.match(login, /height:56px/, 'sized by height, so the aspect ratio survives');
  assert.doesNotMatch(login, /max-height:48px;max-width:200px/, 'the old cap distorted the wordmark');
  assert.match(login, /<svg[^>]*viewBox="0 0 24 24"[\s\S]{0,400}<rect x="2" y="3"/,
    'the outline glyph must remain for an install with no logo at all');
});

test('the name is not printed twice when the logo already says it', () => {
  /*
   * The wordmark IS the name, so an <h1> repeating it underneath reads as a mistake. It is
   * conditional rather than deleted: an install whose branding carries no logo falls back to an
   * outline glyph, and there the heading is the only thing identifying the page.
   */
  const login = front('js', 'views', 'login.js');
  assert.match(login, /\$\{branding\.logo_url \? '' : `<h1/,
    'the heading must be conditional on there being no logo');
  assert.match(login, /alt="\$\{brandEsc\(brandName\)\}"/,
    'and the name must survive for a screen reader, as the image alt');
});

test('the trial notice is gone, string and all', () => {
  const login = front('js', 'views', 'login.js');
  assert.doesNotMatch(login, /trial_notice/);
  for (const loc of ['pt', 'en', 'es', 'fr', 'de', 'it']) {
    assert.doesNotMatch(front('js', 'i18n', `${loc}.js`), /auth\.trial_notice/,
      `${loc}.js still carries the removed notice`);
  }
});

test('a fresh install ships with the Loop Player logo rather than the glyph', () => {
  const branding = fs.readFileSync(path.join(ROOT, 'server', 'lib', 'branding.js'), 'utf8');
  assert.match(branding, /logo_url: '\/assets\/loop-player-logo\.png'/);
  assert.ok(fs.existsSync(path.join(ROOT, 'frontend', 'assets', 'loop-player-logo.png')),
    'the default must point at a file that is actually shipped');
});

test('the dead support-access box is gone from the login page', () => {
  /*
   * It posted to /api/auth/support, which does not exist — 404. Real break-glass is a JWT minted
   * by scripts/reset-admin.js and presented as an ordinary bearer token (lib/recovery-grant.js),
   * so this was a second, broken door on the one page every visitor sees.
   */
  const login = front('js', 'views', 'login.js');
  assert.doesNotMatch(login, /supportDetails|supportLoginBtn|auth\/support/);

  // And its strings went with it, in every locale — an orphaned key is a control waiting to be
  // "restored" by someone who finds the translation and assumes it belongs to something.
  for (const loc of ['pt', 'en', 'es', 'fr', 'de', 'it']) {
    const dict = front('js', 'i18n', `${loc}.js`);
    assert.doesNotMatch(dict, /auth\.support_access|auth\.support_token_placeholder|auth\.support_authenticate/,
      `${loc}.js still carries the removed control's strings`);
  }
});

test('the real break-glass path still exists, so nothing was locked out by removing that box', () => {
  // Removing a login control is only safe while the mechanism it pretended to offer is intact.
  const grants = fs.readFileSync(path.join(ROOT, 'server', 'lib', 'recovery-grant.js'), 'utf8');
  assert.match(grants, /module\.exports/);
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'reset-admin.js')),
    'the script that mints a recovery token must still be there');
});
