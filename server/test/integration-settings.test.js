'use strict';

/*
 * THE ASAAS KEY AND THE MAIL SERVER, out of the .env file and onto a screen.
 *
 * WHAT THIS FIXES. Both were environment variables: swapping the Asaas account meant editing a file
 * on the server and restarting the container — a deploy, to change a token. And nothing inside the
 * product said whether a key was set at all. It was not, for months, and that silence is the whole
 * reason no invoice was ever charged: the billing pipeline ran, computed, published rows, and could
 * not issue a single charge.
 *
 * The rules pinned here are the ones that decide whether this is safe to use:
 *   - the environment is a SEED, and the database wins once something is saved;
 *   - a blank field means "leave it alone", never "erase it";
 *   - a secret never comes back out;
 *   - and a rotated JWT_SECRET reports itself instead of failing silently.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-integr-' + crypto.randomBytes(4).toString('hex'));
process.env.JWT_SECRET = 'integration-settings-test-secret';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const integrations = require('../lib/integration-settings');
const appSettings = require('../lib/app-settings');

test('the environment seeds it, and a saved value takes over', () => {
  /*
   * The migration path. An install that never opens the screen has to keep behaving exactly as it
   * did, or upgrading silently turns off somebody's billing.
   */
  process.env.ASAAS_API_KEY = 'from-the-env';
  delete require.cache[require.resolve('../config')];
  assert.equal(integrations.asaas().apiKey, 'from-the-env');

  integrations.saveSecret(integrations.K.asaasKey, 'from-the-panel');
  assert.equal(integrations.asaas().apiKey, 'from-the-panel');

  delete process.env.ASAAS_API_KEY;
  delete require.cache[require.resolve('../config')];
});

test('a blank field leaves the stored secret alone', () => {
  /*
   * THE TRAP THIS AVOIDS. The form cannot render a secret back, so its field is empty on every
   * visit. A plain save would therefore wipe the Asaas key every time somebody changed the
   * environment dropdown beside it — and the next monthly close would issue nothing, silently.
   */
  integrations.saveSecret(integrations.K.asaasKey, 'keep-me');

  for (const blank of ['', null, undefined]) {
    assert.equal(integrations.saveSecret(integrations.K.asaasKey, blank), false);
    assert.equal(integrations.asaas().apiKey, 'keep-me', `"${blank}" apagou a chave`);
  }
});

test('erasing is a separate, explicit act', () => {
  integrations.saveSecret(integrations.K.asaasKey, 'goodbye');
  integrations.clear(integrations.K.asaasKey);
  assert.equal(integrations.asaas().apiKey, '');
  assert.equal(integrations.describeSecret(integrations.K.asaasKey).configured, false);
});

test('a secret is described, never returned', () => {
  /*
   * describeSecret is what crosses the network to a browser. A credential that can be read back is
   * a credential that leaves in a support screenshot — so the panel gets "there is one" and the
   * last four characters, which is enough to tell two keys apart and useless for anything else.
   */
  integrations.saveSecret(integrations.K.asaasKey, '$aact_prod_000abcdef1234');
  const d = integrations.describeSecret(integrations.K.asaasKey);

  assert.equal(d.configured, true);
  assert.equal(d.readable, true);
  assert.equal(d.hint, '…1234');
  assert.ok(!JSON.stringify(d).includes('aact_prod'), 'o valor não pode viajar');
});

test('a secret sealed under a different JWT_SECRET reports itself as unreadable', () => {
  /*
   * THE ROTATION TRAP, made visible. secretbox derives its key from JWT_SECRET; rotate it and every
   * stored secret becomes undecryptable — here, and in TOTP and SSO, which already used the same
   * box. Nothing is corrupted and the fix is to type them in again, but only if the screen SAYS so.
   *
   * Simulated by storing something that is not a valid sealed box, which is what a rotated key
   * makes every existing row look like.
   */
  appSettings.set(integrations.K.smtpPass, 'bm90LWEtdmFsaWQtYm94');
  const d = integrations.describeSecret(integrations.K.smtpPass);

  assert.equal(d.configured, true, 'a linha existe');
  assert.equal(d.readable, false, 'e o painel tem de dizer que não consegue lê-la');
  assert.equal(d.hint, '');
});

test('the environment is chosen, not typed', () => {
  /*
   * A hand-typed base URL is how live billing ends up pointed at a test account by one missing
   * character — discovered a month later, in a bank statement.
   */
  assert.deepEqual(Object.keys(integrations.ASAAS_ENDPOINTS).sort(), ['production', 'sandbox']);
  assert.match(integrations.ASAAS_ENDPOINTS.sandbox, /sandbox/);
  assert.doesNotMatch(integrations.ASAAS_ENDPOINTS.production, /sandbox/);

  assert.equal(integrations.asaasMode('https://api-sandbox.asaas.com/v3'), 'sandbox');
  assert.equal(integrations.asaasMode('https://api.asaas.com/v3'), 'production');
});

test('every write moves the revision, so cached clients rebuild', () => {
  /*
   * services/email.js caches a nodemailer transporter. Without this it would keep delivering to the
   * previous mail server after the operator changed it — the form saves, the test passes against
   * the OLD server, and nothing on screen explains why.
   */
  const before = integrations.revision();
  integrations.savePlain(integrations.K.smtpHost, 'smtp.hostinger.com');
  assert.ok(integrations.revision() > before);

  const mid = integrations.revision();
  integrations.saveSecret(integrations.K.smtpPass, '');       // a no-op must not move it
  assert.equal(integrations.revision(), mid);
});

test('SMTP falls back to the environment field by field, not all or nothing', () => {
  /*
   * An operator who fills in only the host must not lose the port that was already working. Each
   * field resolves on its own, which also means a half-filled form cannot produce a mail server
   * that is neither the old one nor the new one.
   */
  process.env.SMTP_PORT = '587';
  process.env.SMTP_FROM = 'env@example.com';
  delete require.cache[require.resolve('../config')];

  integrations.savePlain(integrations.K.smtpHost, 'smtp.panel.example');

  const c = integrations.smtp();
  assert.equal(c.host, 'smtp.panel.example', 'o painel venceu onde foi preenchido');
  assert.equal(c.port, 587, 'e o ambiente segue respondendo onde não foi');
  assert.equal(c.from, 'env@example.com');

  delete process.env.SMTP_PORT;
  delete process.env.SMTP_FROM;
  delete require.cache[require.resolve('../config')];
});
