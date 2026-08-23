// One-time signup emails (Slice 1):
//   (a) a personal welcome email to the new user, and
//   (b) an admin notification to Dan so no signup goes unnoticed.
//
// Fired fire-and-forget from all three signup paths (local /register, /google,
// /microsoft) at the point a NEW user is created. Reuses the single Microsoft
// Graph transport in ./email (no second mail path).
//
// Gating & safety:
//   - Hosted-instance only: skipped when SELF_HOSTED=true so self-host operators
//     never emit mail from our domain (and never CC Dan on their signups).
//   - Idempotent: users.welcome_email_sent_at is stamped after the send block;
//     a non-null value short-circuits, so a user is only ever emailed once.
//   - sendEmail() never throws, so a Graph hiccup is logged (per-email
//     {sent, reason}) but never blocks or fails the signup request.
//
// No retry logic by design: there is no path that re-enters the new-user branch
// for an existing user, so a failed Graph send is surfaced in the logs and left
// alone rather than retried (that code would be dead).

const { db } = require('../db/database');
const { sendEmail } = require('./email');
const { getClientIp } = require('./activity');
const config = require('../config');

// Admin signup-notify recipient. Sourced from env (not hardcoded) so the
// hosted .com address never ships in open-source code: a self-hoster who
// configures Graph but forgets SELF_HOSTED=true would otherwise fire their
// users' signup PII into our inbox. Unset -> admin notify is skipped entirely
// (the user's welcome email is unaffected). Hosted prod sets this env var.
const ADMIN_NOTIFY_TO = process.env.ADMIN_NOTIFY_EMAIL || null;

/*
 * Resolved against this install rather than hardcoded: a self-hosted deployment must not send its
 * users to loopplayer.com.br, and the canonical origin is already pinned by APP_URL for the
 * verification and invite links further down.
 */
function links() {
  const base = (process.env.APP_URL || '').replace(/\/+$/, '') || 'https://player.loopplayer.com.br';
  return {
    player: `${base}/player`,
    help: `${base}/app#/help`,
    dashboard: `${base}/app`,
  };
}

function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Plain-text body. Pure ASCII on purpose: "->" not the arrow glyph, "-" not the
// bullet glyph, straight apostrophes, no em-dashes. Unicode in text/plain gets
// mangled by some clients and hurts deliverability on a new sending pattern.
function welcomeText(name) {
  const L = links();
  return `Olá ${name},

Obrigado por criar sua conta no Loop Player.

Uma coisa que vale saber logo: o Loop Player é tocado por uma pessoa só. Não
existe fila de atendimento nem robô de chamado. Se você responder este e-mail,
ele chega direto em mim e eu respondo.

O jeito mais rápido de ver funcionando é colocar algo numa tela. Dá para
transformar qualquer navegador em uma tela em cerca de um minuto:

  -> ${L.player}

Abra isso no aparelho que você quer usar como tela, pareie pelo painel, e
pronto.

Vai usar um aparelho Android de verdade? O passo a passo está na Ajuda, dentro
do painel:

  -> ${L.help}

Se algo não estiver claro ou não funcionar, é só responder. Eu leio todos.

- Vitor
Loop Player`;
}

function welcomeHtml(name) {
  const L = links();
  return `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.6;color:#222;max-width:560px">
<p>Olá ${htmlEscape(name)},</p>
<p>Obrigado por criar sua conta no Loop Player.</p>
<p>Uma coisa que vale saber logo: o Loop Player é tocado por uma pessoa só. Não existe fila de atendimento nem robô de chamado. Se você responder este e-mail, ele chega direto em mim e eu respondo.</p>
<p>O jeito mais rápido de ver funcionando é colocar algo numa tela. Dá para transformar qualquer navegador em uma tela em cerca de um minuto:</p>
<p><a href="${L.player}" style="font-weight:600">Abrir o player no navegador</a></p>
<p>Abra isso no aparelho que você quer usar como tela, pareie pelo painel, e pronto.</p>
<p>Vai usar um aparelho Android de verdade? O passo a passo está na <a href="${L.help}">Ajuda dentro do painel</a>.</p>
<p>Se algo não estiver claro ou não funcionar, é só responder. Eu leio todos.</p>
<p>- Vitor<br>Loop Player</p>
</div>`;
}

function fmtUtc(unixSec) {
  return new Date(unixSec * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function fmtCentral(unixSec) {
  return new Date(unixSec * 1000).toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function adminText({ name, email, orgName, signupUnix, ip, country, userAgent }) {
  return `Novo cadastro no Loop Player.

Name:       ${name}
Email:      ${email}
Org:        ${orgName}
Plan:       pro (14-day trial)
Signed up:  ${fmtUtc(signupUnix)}  (${fmtCentral(signupUnix)} America/Chicago)
IP:         ${ip || 'unknown'}
Country:    ${country || 'unknown'}
User agent: ${userAgent || 'unknown'}`;
}

// Public entry point. `user` only needs `.id`; everything else is re-read from
// the row so the caller's column selection doesn't matter. `req` supplies the
// client IP (CF-aware), Cloudflare's free CF-IPCountry header, and user agent.
function sendSignupEmails(user, req) {
  try {
    // Hosted instance only.
    if (config.selfHosted) return;

    const row = db.prepare(
      'SELECT email, name, created_at, welcome_email_sent_at FROM users WHERE id = ?'
    ).get(user.id);
    if (!row || row.welcome_email_sent_at) return; // unknown or already handled

    const email = row.email;
    const name = (row.name && row.name.trim()) ? row.name.trim() : email.split('@')[0];
    const signupUnix = row.created_at || Math.floor(Date.now() / 1000);

    // Workspace name is always "Default" at signup, so use the org name instead.
    const orgRow = db.prepare(
      'SELECT name FROM organizations WHERE owner_user_id = ? ORDER BY created_at ASC LIMIT 1'
    ).get(user.id);
    const orgName = orgRow ? orgRow.name : `${name}'s organization`;

    const ip = getClientIp(req);
    const country = (req && req.headers && req.headers['cf-ipcountry']) || 'unknown';
    const userAgent = (req && req.headers && req.headers['user-agent']) || 'unknown';

    (async () => {
      const w = await sendEmail({
        to: email,
        fromName: 'Vitor · Loop Player',
        rawSubject: true,
        subject: 'Bem-vindo ao Loop Player',
        text: welcomeText(name),
        html: welcomeHtml(name),
      });
      console.log(`[SIGNUP-EMAIL] welcome -> ${email}: ${JSON.stringify(w)}`);

      if (ADMIN_NOTIFY_TO) {
        const a = await sendEmail({
          to: ADMIN_NOTIFY_TO,
          rawSubject: true,
          subject: `New signup: ${email}`,
          text: adminText({ name, email, orgName, signupUnix, ip, country, userAgent }),
        });
        console.log(`[SIGNUP-EMAIL] admin-notify (${email}) -> ${ADMIN_NOTIFY_TO}: ${JSON.stringify(a)}`);
      } else {
        console.log('[SIGNUP-EMAIL] admin notify skipped (ADMIN_NOTIFY_EMAIL unset)');
      }

      // Stamp after the send block regardless of per-email outcome (no retry):
      // marks this user handled so we never double-send.
      db.prepare("UPDATE users SET welcome_email_sent_at = strftime('%s','now') WHERE id = ?")
        .run(user.id);
    })().catch(e => console.error(`[SIGNUP-EMAIL] unexpected failure for ${email}: ${e.message}`));
  } catch (e) {
    // Never let signup-email bookkeeping affect the signup request itself.
    console.error(`[SIGNUP-EMAIL] setup failed: ${e.message}`);
  }
}

// Email-verification message. Unlike the welcome/admin-notify pair above this is NOT
// hosted-only — a self-hoster with SMTP configured should still verify their own users.
// sendEmail() self-gates on isConfigured() and never throws, so an unconfigured instance
// simply no-ops (and the caller has already decided not to hard-gate in that case).
function verifyEmailBody(name, url) {
  const text = `Olá ${name},

Confirme seu e-mail para terminar de configurar sua conta no Loop Player:

${url}

O link vale por 24 horas. Se não foi você que criou esta conta, pode ignorar este e-mail.`;
  // Near-black on the brand green: white would be 1.8:1, the same trap as the app's buttons.
  const html = `<p>Olá ${htmlEscape(name)},</p>
<p>Confirme seu e-mail para terminar de configurar sua conta no Loop Player:</p>
<p><a href="${htmlEscape(url)}" style="display:inline-block;background:#20DF91;color:#04231A;font-weight:600;padding:10px 18px;border-radius:6px;text-decoration:none">Confirmar meu e-mail</a></p>
<p style="color:#666;font-size:13px">Ou cole este endereço no navegador:<br>${htmlEscape(url)}<br><br>O link vale por 24 horas. Se não foi você que criou esta conta, pode ignorar este e-mail.</p>`;
  return { text, html };
}

async function sendVerificationEmail(user, token, req) {
  // Same public-origin resolution as workspace invites: APP_URL pins the canonical origin
  // in prod; otherwise derive from the (proxy-aware) request. The link hits the API GET
  // route, which flips the flag and redirects into the app.
  const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  const url = `${base}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  const { text, html } = verifyEmailBody(user.name || user.email, url);
  return sendEmail({ to: user.email, subject: 'Confirme seu e-mail — Loop Player', text, html });
}

function escapeHtml(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

async function sendPasswordResetEmail(user, token, req) {
  // Same public-origin resolution as verification/invites. The link lands on the SPA,
  // which posts the token back to /api/auth/reset-password with the new password — the
  // token is never redeemed by a bare GET, so a link-prefetching mail client cannot
  // consume it.
  const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  const url = `${base}/app#/reset-password?token=${encodeURIComponent(token)}`;
  const who = user.name || user.email;
  const text = `Olá ${who},

Alguém pediu para redefinir a senha da sua conta no Loop Player.

Abra este link para escolher uma nova senha (vale por 1 hora e serve uma vez só):
${url}

Se não foi você, pode ignorar este e-mail — sua senha não foi alterada.`;
  const html = `<p>Olá ${escapeHtml(who)},</p>
<p>Alguém pediu para redefinir a senha da sua conta no Loop Player.</p>
<p><a href="${escapeHtml(url)}">Escolher uma nova senha</a> &mdash; o link vale por 1 hora e serve uma vez só.</p>
<p style="color:#666">Se não foi você, pode ignorar este e-mail &mdash; sua senha não foi alterada.</p>`;
  return sendEmail({ to: user.email, subject: 'Redefinir sua senha — Loop Player', text, html });
}

module.exports = { sendSignupEmails, sendVerificationEmail, sendPasswordResetEmail };
