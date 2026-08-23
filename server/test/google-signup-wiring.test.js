'use strict';

/*
 * Signing up with a Google account.
 *
 * This needed no new code — the OIDC machinery already covers it end to end, and turning it on is
 * two environment variables. That is a fine answer, but it is also a fragile one to leave
 * undefended: nothing in the suite exercises the Google path while the credentials are unset, so
 * any of the four links in the chain could be broken by an unrelated change and nobody would find
 * out until a customer could not sign up.
 *
 * The four links, one test each:
 *   1. GOOGLE_CLIENT_ID alone registers the provider
 *   2. the login page is told about it, without ever being told the secret
 *   3. the callback creates the account for an address nobody has seen before
 *   4. and that account gets an organization, which is what makes it a tenant
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const oidcProviders = require('../lib/oidc-providers');

test('GOOGLE_CLIENT_ID alone is enough to register the provider', () => {
  // list() takes its environment as an argument, so this asserts against the real function rather
  // than against a copy of its rules.
  const providers = oidcProviders.list({ GOOGLE_CLIENT_ID: 'abc.apps.googleusercontent.com' });
  const google = providers.find((p) => p.slug === 'google');
  assert.ok(google, 'the button appears from the client id alone');
  assert.equal(google.issuer, 'https://accounts.google.com');
  assert.match(google.scopes, /openid/);
  assert.match(google.scopes, /email/);
  assert.equal(google.assumeEmailVerified, false, 'Google sends email_verified, so nothing is assumed');
});

test('no client id, no provider — and no half-configured button', () => {
  /*
   * A button that leads to a broken authorization request is worse than no button: the visitor
   * blames the product for a configuration that was never finished.
   */
  assert.deepEqual(oidcProviders.list({}).filter((p) => p.slug === 'google'), []);
  assert.deepEqual(oidcProviders.list({ GOOGLE_CLIENT_SECRET: 'só-o-segredo' }).filter((p) => p.slug === 'google'), []);
});

test('the browser is told the provider exists and never told the secret', () => {
  const shown = oidcProviders.publicList({
    GOOGLE_CLIENT_ID: 'abc.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'NAO-PODE-VAZAR',
  });
  const google = shown.find((p) => p.slug === 'google');
  assert.ok(google, 'the login page needs to know it is there to draw the button');
  const serialized = JSON.stringify(shown);
  assert.ok(!serialized.includes('NAO-PODE-VAZAR'), 'the secret must never reach a browser');
  assert.ok(!serialized.includes('apps.googleusercontent.com'), 'nor the client id — nothing there uses it');
});

/*
 * The last two links are in routes/auth.js and need a full OIDC round trip to exercise for real,
 * which would mean standing up a fake identity provider. Pinned by reading the code instead: less
 * than a live test, and enough to catch the specific removals that would silently break signup.
 */
const auth = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');

test('an address nobody has seen before gets an account, not a refusal', () => {
  const fn = auth.slice(auth.indexOf('function upsertFederatedUser'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /if \(!existing\)/, 'the first-time branch must exist');
  assert.match(body, /INSERT INTO users/, 'and it must create the account');
  assert.match(body, /isNew: true/);
});

test('the new account gets an organization, which is what makes it a tenant', () => {
  /*
   * Without this the person signs in successfully and lands in nothing: no workspace, so no
   * screens, no files, no playlists. It reads as the product being broken rather than as a
   * missing step.
   */
  const cb = auth.slice(auth.indexOf("router.get('/oidc/:slug/callback'"));
  const body = cb.slice(0, cb.indexOf('\n}));'));
  assert.match(body, /ensureDefaultOrgForUser\(user, \{ allowCreate: config\.autoCreateOrgOnSignup \}\)/);
  assert.match(body, /sendSignupEmails\(user, req\)/, 'and is welcomed like any other signup');
});

test('an existing password account is not taken over by a Google login', () => {
  /*
   * The rule that keeps "sign in with Google" from being an account-takeover: someone who knows an
   * address must not be able to claim it by holding a Google account with the same name on it.
   */
  const fn = auth.slice(auth.indexOf('function upsertFederatedUser'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /account_exists_local/);
});
