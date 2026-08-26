'use strict';

/*
 * WHERE THE ASAAS KEY AND THE MAIL SERVER LIVE — and why they stopped living in a file.
 *
 * Both were environment variables. Changing the Asaas account meant editing .env on the server and
 * restarting the container, which is a deploy to swap a token; and the operator could not see, from
 * inside the product, whether a key was even set. It was not set. The empty ASAAS_API_KEY is why no
 * charge has ever been issued, and nothing on any screen said so.
 *
 * Now they are rows in app_settings, secrets sealed with lib/secretbox (AES-256-GCM), and the
 * environment becomes the SEED rather than the source: whatever is in .env applies until somebody
 * saves a value in the panel, and from then on the database answers. Nothing breaks on the way
 * over, and an install that never opens the screen keeps behaving exactly as it did.
 *
 * ── THE ROTATION TRAP, stated once and loudly ────────────────────────────────────────────────
 * secretbox derives its key from JWT_SECRET. Rotate that and every stored secret here becomes
 * undecryptable — the Asaas key, the SMTP password, and the same for TOTP and SSO, which already
 * used it. Nothing is corrupted and nothing is lost except the ability to read them back: they
 * have to be typed in again. decryptOrNull() below returns null rather than throwing, so the
 * screen can say "unreadable — enter it again" instead of the server failing to boot.
 */

/*
 * config is required PER CALL, not captured at load.
 *
 * It reads process.env directly, and anything that reloads it — the email-transport tests bust its
 * require cache to drive services/email.js under different environments — would otherwise leave
 * this module holding the object from the first load, quietly answering with stale values. The
 * same property that makes the panel work without a restart has to hold for the environment seed.
 */
const cfg = () => require('../config');
const appSettings = require('./app-settings');
const secretbox = require('./secretbox');

const K = {
  asaasKey: 'integr.asaas.api_key',
  asaasBase: 'integr.asaas.base_url',
  asaasWebhook: 'integr.asaas.webhook_token',
  smtpHost: 'integr.smtp.host',
  smtpPort: 'integr.smtp.port',
  smtpSecure: 'integr.smtp.secure',
  smtpUser: 'integr.smtp.user',
  smtpPass: 'integr.smtp.password',
  smtpFrom: 'integr.smtp.from',
};

/*
 * A counter that moves on every write, so a consumer holding an expensive object built from these
 * values knows to rebuild it. services/email.js caches a nodemailer transporter; without this it
 * would keep using the old mail server after the operator changed it, and the change would look
 * like it silently did nothing.
 */
let revision = 0;
function bump() { revision += 1; }

function decryptOrNull(stored) {
  if (!stored) return null;
  try { return secretbox.decrypt(stored); } catch { return null; }
}

const raw = (key) => appSettings.get(key, undefined);
const secret = (key) => decryptOrNull(appSettings.get(key, undefined));

/* ── Asaas ─────────────────────────────────────────────────────────────────────────────────── */

function asaas() {
  return {
    apiKey: secret(K.asaasKey) || cfg().asaas.apiKey,
    baseUrl: raw(K.asaasBase) || cfg().asaas.baseUrl,
    webhookToken: secret(K.asaasWebhook) || cfg().asaas.webhookToken,
    // Not configurable from the panel: it is the payment method OFFERED, and letting the payer
    // choose is the right default for every Brazilian tenant this bills.
    billingType: cfg().asaas.billingType,
  };
}

/*
 * SANDBOX AND PRODUCTION AS A CHOICE, not a URL to be typed.
 *
 * A hand-typed base URL is a way to point live billing at a test account by dropping a character,
 * and to discover it a month later in a bank statement.
 */
const ASAAS_ENDPOINTS = {
  sandbox: 'https://api-sandbox.asaas.com/v3',
  production: 'https://api.asaas.com/v3',
};

/* Which of the two an arbitrary stored URL is, for display. */
function asaasMode(url) {
  const u = String(url || '');
  if (u.includes('sandbox')) return 'sandbox';
  if (u.includes('asaas.com')) return 'production';
  return 'custom';
}

/* ── SMTP ──────────────────────────────────────────────────────────────────────────────────── */

function smtp() {
  const port = raw(K.smtpPort);
  return {
    host: raw(K.smtpHost) || cfg().smtpHost,
    port: port ? parseInt(port, 10) : cfg().smtpPort,
    secure: raw(K.smtpSecure) !== undefined ? raw(K.smtpSecure) === 'true' : cfg().smtpSecure,
    user: raw(K.smtpUser) !== undefined ? raw(K.smtpUser) : cfg().smtpUser,
    password: secret(K.smtpPass) || cfg().smtpPassword,
    from: raw(K.smtpFrom) || cfg().smtpFrom,
  };
}

/* ── writing ───────────────────────────────────────────────────────────────────────────────── */

/*
 * An empty string means LEAVE IT ALONE, never "erase it".
 *
 * The screen cannot show a secret back — so the field it renders is empty, and a plain save would
 * wipe the key every time somebody changed the port next to it. Clearing is a separate, explicit
 * act (`clear`), which is what deleting a credential should be.
 */
function saveSecret(key, value) {
  if (value === undefined || value === null || value === '') return false;
  appSettings.set(key, secretbox.encrypt(String(value).trim()));
  bump();
  return true;
}

function savePlain(key, value) {
  if (value === undefined || value === null) return false;
  appSettings.set(key, String(value));
  bump();
  return true;
}

function clear(key) {
  appSettings.set(key, '');
  bump();
}

/*
 * What the panel is allowed to know about a secret: that it exists, and enough of its tail to tell
 * two keys apart. Never the value — this crosses the network to a browser, and a credential that
 * can be read back is a credential that can be copied out of a support screenshot.
 */
function describeSecret(key) {
  const stored = appSettings.get(key, undefined);
  if (!stored) return { configured: false, readable: true, hint: '' };
  const plain = decryptOrNull(stored);
  if (plain === null) {
    // JWT_SECRET rotated, or the row was corrupted. Say so, so the fix is "type it again" rather
    // than a silent failure at the moment a customer is being charged.
    return { configured: true, readable: false, hint: '' };
  }
  return { configured: true, readable: true, hint: plain.length > 6 ? `…${plain.slice(-4)}` : '…' };
}

module.exports = {
  K, asaas, smtp, asaasMode, ASAAS_ENDPOINTS,
  saveSecret, savePlain, clear, describeSecret,
  revision: () => revision,
};
