// Activation nudge (Slice 3): a once-per-user "checking in" email sent T+3 days
// after signup when the user still has zero paired screens. Daily sweep at a
// fixed UTC hour. Reuses the single Microsoft Graph transport (./email).
//
// GATING — positive hosted signal, NOT !selfHosted:
//   This is a daily BULK sweep. A self-hoster who configured Graph but forgot
//   SELF_HOSTED=true would blast their whole dormant user base with Dan-branded
//   onboarding mail. So we gate on an explicit HOSTED_INSTANCE=true: if it's not
//   set, we neither schedule nor send. Hosted prod sets the env var.
//
// Idempotency: users.activation_nudge_sent_at, stamped after each send; the
// query's "IS NULL" guard means a user is nudged at most once. Re-runs are safe.
//
// Opt-out: users who explicitly turned email alerts off (email_alerts = 0) are
// excluded; NULL/unset and on (1) both qualify via COALESCE(...,1)=1.

const { db } = require('../db/database');
const { sendEmail } = require('./email');

const NUDGE_HOUR_UTC = 15; // 15:00 UTC daily

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

// Pure-ASCII plain text (same deliverability rule as the welcome email).
function nudgeText(name) {
  const L = links();
  return `Olá ${name},

Você criou sua conta no Loop Player há alguns dias e reparei que ainda não
pareou nenhuma tela. Sem problema nenhum — só queria saber se algo travou no
caminho.

Se esbarrou em alguma dificuldade, responda contando o que aconteceu. Chega
direto em mim e eu ajudo a resolver.

Se foi só falta de tempo, o caminho mais rápido é o player no navegador.
Qualquer navegador vira uma tela em cerca de um minuto:

  -> ${L.player}

O passo a passo para aparelho Android está na Ajuda, dentro do painel:

  -> ${L.help}

E se preferir que eu não escreva de novo, é só dizer.

- Vitor
Loop Player`;
}

function nudgeHtml(name) {
  const L = links();
  return `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.6;color:#222;max-width:560px">
<p>Olá ${htmlEscape(name)},</p>
<p>Você criou sua conta no Loop Player há alguns dias e reparei que ainda não pareou nenhuma tela. Sem problema nenhum — só queria saber se algo travou no caminho.</p>
<p>Se esbarrou em alguma dificuldade, responda contando o que aconteceu. Chega direto em mim e eu ajudo a resolver.</p>
<p>Se foi só falta de tempo, o caminho mais rápido é o player no navegador. Qualquer navegador vira uma tela em cerca de um minuto:</p>
<p><a href="${L.player}" style="font-weight:600">Abrir o player no navegador</a></p>
<p>O passo a passo para aparelho Android está na <a href="${L.help}">Ajuda dentro do painel</a>.</p>
<p>E se preferir que eu não escreva de novo, é só dizer.</p>
<p>- Vitor<br>Loop Player</p>
</div>`;
}

const ELIGIBLE_SQL = `
  SELECT u.id, u.email, u.name FROM users u
  WHERE u.created_at < strftime('%s','now') - (3 * 86400)
    AND u.created_at > strftime('%s','now') - (14 * 86400)
    AND u.activation_nudge_sent_at IS NULL
    AND COALESCE(u.email_alerts, 1) = 1
    AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.user_id = u.id)
    AND NOT EXISTS (
      SELECT 1 FROM workspace_members wm
      JOIN devices d2 ON d2.workspace_id = wm.workspace_id
      WHERE wm.user_id = u.id)
`;

function isHosted() {
  return process.env.HOSTED_INSTANCE === 'true';
}

// Run one sweep. Exported so the dev verify harness can drive it directly
// without waiting for 15:00 UTC. Returns the number of nudges sent.
async function runActivationNudgeSweep() {
  if (!isHosted()) return 0; // defense in depth (scheduler is also gated)
  const users = db.prepare(ELIGIBLE_SQL).all();
  console.log(`[NUDGE] sweep: ${users.length} eligible user(s)`);
  let sent = 0;
  for (const u of users) {
    const name = (u.name && u.name.trim()) ? u.name.trim() : u.email.split('@')[0];
    const r = await sendEmail({
      to: u.email,
      fromName: 'Vitor · Loop Player',
      rawSubject: true,
      subject: 'Como está indo com o Loop Player?',
      text: nudgeText(name),
      html: nudgeHtml(name),
    });
    console.log(`[NUDGE] nudge -> ${u.email}: ${JSON.stringify(r)}`);
    // Stamp after the send (no retry, same discipline as the welcome email).
    db.prepare("UPDATE users SET activation_nudge_sent_at = strftime('%s','now') WHERE id = ?").run(u.id);
    sent++;
  }
  return sent;
}

function msUntilNextRun() {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), NUDGE_HOUR_UTC, 0, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

// Self-correcting daily scheduler (recompute next 15:00 UTC each run; no drift,
// no node-cron dependency). Gated on HOSTED_INSTANCE.
function startActivationNudge() {
  if (!isHosted()) {
    console.log('[NUDGE] HOSTED_INSTANCE not set - activation nudge sweep disabled');
    return;
  }
  const schedule = () => {
    const delay = msUntilNextRun();
    console.log(`[NUDGE] next activation-nudge sweep in ~${Math.round(delay / 60000)} min (15:00 UTC daily)`);
    setTimeout(() => {
      runActivationNudgeSweep().catch(e => console.error('[NUDGE] sweep error:', e.message));
      schedule();
    }, delay);
  };
  schedule();
}

module.exports = { startActivationNudge, runActivationNudgeSweep };
