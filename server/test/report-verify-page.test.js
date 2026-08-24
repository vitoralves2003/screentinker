'use strict';

/*
 * The public verification page.
 *
 * The only surface in this product an advertiser reaches without a login, which makes it the only
 * one where "who is asking" is answered by the code alone. Two things have to hold: the code is
 * the whole credential, and nothing typed into the URL comes back out as markup.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const verify = fs.readFileSync(path.join(ROOT, 'lib', 'report-verify.js'), 'utf8');

/* The route handler, on its own. */
function handler() {
  const at = server.indexOf("app.get('/verificar/:code'");
  assert.ok(at > 0, 'the verification route must exist');
  const end = server.indexOf('\n});', at);
  return server.slice(at, end);
}

test('the page is public, and rate-limited because of it', () => {
  /*
   * Public on purpose: the person checking holds a PDF and has no account here. The code is drawn
   * from a 32^9 space, so guessing is not the threat — but a page that hits the database on every
   * request and answers "found / not found" is worth a limiter regardless.
   */
  const src = handler();
  assert.doesNotMatch(src, /requireAuth/, 'an advertiser has no login and never will');
  assert.match(server, /app\.use\('\/verificar', rateLimit\(/);
});

test('nothing reaches the HTML without being escaped', () => {
  /*
   * The code comes straight off the URL and a subject name is whatever somebody called their file.
   * Both are interpolated into a template literal, which does no escaping of its own.
   */
  const src = handler();

  // Every interpolation in the page is either escaped, a date helper, or a known-safe literal.
  const interpolations = [...src.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim());
  const unescaped = interpolations.filter((x) => !(
    x.startsWith('esc(')
    || x.startsWith('d(')
    || x === 'body'
    || x === 'rows'
    || x.includes('? `')          // a nested template, whose own contents are checked below
  ));
  assert.deepEqual(unescaped, [], `these reach the page raw:\n  ${unescaped.join('\n  ')}`);

  // And the escaper covers the characters that matter, including the quote that would break out
  // of an attribute.
  assert.match(src, /replace\(\/&\/g/);
  assert.match(src, /replace\(\/</);
  assert.match(src, /&quot;/);
});

test('the not-found page echoes the code back, escaped', () => {
  // It has to show what was typed — that is how somebody spots their own typo — and that string
  // came from the URL bar.
  const src = handler();
  assert.match(src, /esc\(req\.params\.code\)/);
  assert.match(src, /status\(404\)/);
});

test('what a code resolves to is FROZEN, not re-queried', () => {
  /*
   * The whole idea. Re-running the report next month returns different numbers — the log is pruned
   * at 90 days and screens get reassigned — so checking a receipt against a live query is checking
   * whether the world has changed, not whether the paper was honest.
   */
  assert.match(verify, /summary_json/);
  assert.doesNotMatch(verify.slice(verify.indexOf('function lookup')), /FROM play_logs/,
    'verification must not touch the log it is meant to outlive');
});

test('the page says the numbers are a snapshot', () => {
  // A reader comparing them with a fresh report has to be told why the two can differ, or the
  // difference reads as one of them being wrong.
  const src = handler();
  assert.match(src, /90 dias/);
  assert.match(src, /não mudam|nao mudam/i);
});

test('nothing on the page expires', () => {
  /*
   * The competitor stamps theirs "Informações válidas até" two minutes after generation. A receipt
   * that expires while the customer is reading it proves nothing, and re-generating it produces a
   * different code for the same facts.
   */
  const src = handler();
  assert.doesNotMatch(src, /válid[ao]s? at[ée]/i);
});
