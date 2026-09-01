/*
 * THE BILL, SAID OUT LOUD, ON THE PAGE THE APP OPENS ON.
 *
 * Until now a tenant found out they owed money when the panel stopped working. The invoice existed,
 * dunning ran, the workspace was suspended, and the only thing that reached the person paying was a
 * 403 on the next thing they tried to save. Nowhere in the product did it say a bill was waiting.
 *
 * ── WHY IT CANNOT BE DISMISSED ───────────────────────────────────────────────────────────────
 * A close button on this would be closed once, by reflex, on the day it first appeared, and never
 * seen again through the week that ends in a suspension. It goes away when the invoice is paid.
 * That is the only thing it responds to, and that is deliberate.
 *
 * ── AND WHY IT IS NOT ALWAYS RED ─────────────────────────────────────────────────────────────
 * Most of the time this says "your invoice for August, due on the 5th", which is not an emergency
 * and must not dress like one. A bar that shouts every month is a bar the reader stops seeing, and
 * the month it genuinely matters is the month they have trained themselves to scroll past. The tone
 * escalates with the actual state: quiet while it is merely due, amber once it is late, red only
 * when access is actually being withheld.
 */

import { esc } from '../utils.js';

/*
 * SO PORTUGUES desde a Etapa 4 -- nao ha idioma a consultar.
 *
 * Aqui havia um mapa de sete idiomas e uma chamada a `getLanguage()`, que a remocao do i18n
 * (d4ac147) apagou sem levar esta linha junto. A faixa so desenha quando ha fatura em aberto,
 * entao o erro ficou dormindo: quando acordou, derrubou a pagina inteira (261 bytes em #app) --
 * e justamente para o assinante que esta prestes a ser lembrado de pagar.
 */
const LOCALE_PT = 'pt-BR';

function money(cents, currency) {
  const v = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat(LOCALE_PT, { style: 'currency', currency: currency || 'BRL' }).format(v);
  } catch {
    // An unknown currency code must not take the warning down with it.
    return `${currency || ''} ${v.toFixed(2)}`.trim();
  }
}

/*
 * "2026-07" as a person says it. Built from explicit parts rather than new Date("2026-07"), which
 * parses as UTC midnight and renders as JUNE anywhere west of Greenwich — every Brazilian reader.
 */
function monthLabel(month) {
  const [y, m] = String(month || '').split('-').map(Number);
  if (!y || !m) return month || '—';
  return new Intl.DateTimeFormat(LOCALE_PT, { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1));
}

/* "2026-09-05" as a date. Same trap, same fix: the parts go in as local, so the day cannot slip. */
function dayLabel(day) {
  const [y, m, d] = String(day || '').split('-').map(Number);
  if (!y || !m || !d) return day || '—';
  return new Intl.DateTimeFormat(LOCALE_PT, { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(y, m - 1, d));
}

/*
 * Each state's headline, body, and how loud it is.
 *
 * `stage` outranks the date: it is read from the workspace, which is what services/tenant-invoicing
 * actually suspends. A banner that announced a block the job had not performed yet would be telling
 * somebody their panel is dead while it still works — and the first thing they would do is check.
 */
function content(n) {
  const amount = money(n.amount_cents, n.currency);
  const month = monthLabel(n.month);

  if (n.state === 'uninvoiced') {
    return {
      tone: 'info',
      title: `Fatura de ${month} — ${amount}`,
      body: 'A cobrança ainda não foi enviada. Nada está em atraso — avisaremos assim que ela estiver disponível.',
    };
  }

  if (n.state === 'due') {
    return {
      tone: 'info',
      title: `Fatura de ${month} — ${amount}`,
      body: n.due_date ? `Vence em ${dayLabel(n.due_date)}.` : '',
    };
  }

  if (n.stage === 'cut') {
    return { tone: 'danger', title: 'Acesso interrompido por fatura vencida', body: `Fatura de ${month}, ${amount}. Regularize o pagamento para restabelecer o serviço.` };
  }

  if (n.stage === 'suspended') {
    return {
      tone: 'danger',
      title: 'Painel bloqueado por fatura vencida',
      // The screens keep playing. Said first, because it is the question a shopkeeper actually has
      // when a panel tells them they are blocked, and the answer is reassuring.
      body: `Suas telas continuam exibindo o conteúdo já publicado. Regularize o pagamento para voltar a editar. ${n.cut_in_days > 0 ? `${(n.cut_in_days) === 1 ? `O acesso será interrompido em ${n.cut_in_days} dia.` : `O acesso será interrompido em ${n.cut_in_days} dias.`}` : ''}`.trim(),
    };
  }

  // Late, and nothing has been withheld yet — the window where paying still costs nothing but a
  // minute. So: how late, and what happens if it stays that way.
  const next = n.suspend_in_days > 0 ? `${(n.suspend_in_days) === 1 ? `O painel será bloqueado em ${n.suspend_in_days} dia.` : `O painel será bloqueado em ${n.suspend_in_days} dias.`}` : 'O painel pode ser bloqueado a qualquer momento.';
  return {
    tone: 'warning',
    title: `Fatura de ${month} está vencida — ${amount}`,
    body: `${`Venceu em ${dayLabel(n.due_date)}, há ${`${(n.days_overdue) === 1 ? `${n.days_overdue} dia` : `${n.days_overdue} dias`}`}.`} ${next}`,
  };
}

/*
 * Blue, amber, red — three of the four status colours the rest of the product already uses, doing
 * the same job here. Green is deliberately absent: this banner has no cheerful state, only absence.
 *
 * Every one of these is a token that EXISTS in variables.css. The first draft reached for
 * --bg-elevated with --bg-card behind it, which reads as careful and is not: a fallback to cover a
 * token nobody ever defined means the first value is decoration, and the day somebody defines it
 * the banner changes colour for reasons no one is looking for.
 */
const TONE = {
  info: { border: 'var(--info)' },
  warning: { border: 'var(--warning)' },
  danger: { border: 'var(--danger)' },
};

/*
 * The banner, or '' when there is nothing owed — which is the common case, and the page then
 * carries no bar at all rather than a cheerful "tudo em dia" nobody asked for.
 *
 * @param {object|null} n the `billing` block from /devices/overview
 */
export function invoiceBanner(n) {
  if (!n || !n.state) return '';

  const c = content(n);
  const tone = TONE[c.tone] || TONE.info;

  // More than one month open. Named, not enumerated: a home page is not a statement of account,
  // and a tenant owing three months must still not be told about one and surprised by the rest.
  const more = n.outstanding_count > 1
    ? `<div style="font-size:12px;color:var(--text-muted);margin-top:6px">
         ${esc(`${(n.outstanding_count - 1) === 1 ? `Mais ${n.outstanding_count - 1} fatura em aberto — total ${money(n.outstanding_cents, n.currency)}.` : `Mais ${n.outstanding_count - 1} faturas em aberto — total ${money(n.outstanding_cents, n.currency)}.`}`)}
       </div>`
    : '';

  /*
   * The link opens the payment page the charge already has. There is no button when no charge was
   * issued — sending somebody to pay a bill that does not exist yet is worse than saying nothing.
   * rel=noopener because it is an external origin holding a payment session.
   */
  const action = n.invoice_url
    ? `<a href="${esc(n.invoice_url)}" target="_blank" rel="noopener noreferrer"
          class="btn ${c.tone === 'info' ? 'btn-secondary' : 'btn-primary'} btn-sm"
          style="white-space:nowrap">${esc('Ver fatura')}</a>`
    : '';

  return `
    <div role="status" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;
         justify-content:space-between;margin-bottom:16px;padding:14px 16px;
         background:var(--bg-card);border:1px solid var(--border);border-left:4px solid ${tone.border};
         border-radius:8px">
      <div style="flex:1;min-width:240px">
        <div style="font-weight:600;font-size:14px">${esc(c.title)}</div>
        ${c.body ? `<div style="font-size:13px;color:var(--text-secondary);margin-top:4px">${esc(c.body)}</div>` : ''}
        ${more}
      </div>
      ${action}
    </div>`;
}
