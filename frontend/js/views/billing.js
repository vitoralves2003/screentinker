import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';

/*
 * Loop OS subscription page.
 *
 * Rewritten for licence-day billing. The previous version rendered `price_monthly` and drove
 * Stripe checkout — neither of which applies now: these plans have no flat monthly price (the
 * amount is licence-days × price per screen, closed monthly), so every plan read "Grátis" and
 * the upgrade button, gated on `price_monthly > 0`, never rendered at all. There was no way to
 * subscribe from the UI.
 *
 * The page now answers the three questions a customer actually has: what am I on, what is this
 * month costing me so far, and what do I owe.
 */

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
function money(v, currency) {
  if (currency && currency !== 'BRL') return `${currency} ${Number(v).toFixed(2)}`;
  return BRL.format(Number(v) || 0);
}

function planPrice(p) {
  if (!(p.price_per_device > 0)) return `<span style="font-size:24px">${t('billing.free')}</span>`;
  return `${money(p.price_per_device, p.currency)}<span style="font-size:13px;color:var(--text-secondary);font-weight:400">${t('billing.per_screen')}</span>`;
}

function check(on, label) {
  return on
    ? `<div style="color:var(--success)">&#10003; ${label}</div>`
    : `<div style="color:var(--text-muted)">&#10007; ${label}</div>`;
}

function invoiceStatusChip(status) {
  const map = {
    paid:     ['var(--success)', t('billing.inv.paid')],
    open:     ['var(--warning)', t('billing.inv.open')],
    past_due: ['var(--danger)', t('billing.inv.past_due')],
    unpaid:   ['var(--danger)', t('billing.inv.unpaid')],
  };
  const [color, label] = map[status] || ['var(--text-muted)', status];
  return `<span style="color:${color};font-weight:600">${label}</span>`;
}

/*
 * The way out of a dunning banner.
 *
 * invoice_url is the Asaas hosted page (Pix, boleto or card, the payer chooses). Without it the
 * product told a tenant to "settle this to restore access" and gave them a table of text — the
 * link existed on the charge all along and was simply never stored. Absent only while a charge
 * is still being created, and then there is genuinely nothing to click yet.
 *
 * rel="noopener" and a new tab: this is a payment page, and it must not be able to reach back
 * into the session that opened it.
 */
function payLink(invoice) {
  if (!invoice.invoice_url || invoice.status === 'paid') return '';
  return `<a class="btn btn-secondary btn-sm" href="${esc(invoice.invoice_url)}" target="_blank" rel="noopener"
             style="text-decoration:none;white-space:nowrap">${t('billing.pay')}</a>`;
}

function bannerPayButton(invoice) {
  if (!invoice) return '';
  return `<div style="margin-top:10px"><a class="btn btn-primary btn-sm" href="${esc(invoice.invoice_url)}"
            target="_blank" rel="noopener" style="text-decoration:none">${t('billing.pay_now')}</a></div>`;
}

/*
 * The nota fiscal for one month, from the customer's side.
 *
 * Only ever a LINK or nothing. A tenant does not need to know that a document is SCHEDULED or
 * SYNCHRONIZED — those are stages of a municipal web service, and showing them would invite a
 * support call about a word that means nothing outside a tax office. What they need is the PDF,
 * the moment it exists.
 *
 * An emission that FAILED is deliberately silent here too. It is the operator's problem to fix,
 * not the customer's to worry about, and there is nothing the customer could do with the news.
 */
function nfseCell(i) {
  if (!i.nfse_pdf_url) return '<span style="color:var(--text-muted)">—</span>';
  return `<a href="${esc(i.nfse_pdf_url)}" target="_blank" rel="noopener noreferrer"
             style="color:var(--accent-ink)">${esc(i.nfse_number || t('billing.nfse_view'))}</a>`;
}

export async function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>${t('billing.title')}</h1>
        <div class="subtitle">${t('billing.subtitle')}</div>
      </div>
    </div>
    <div id="billingContent"><div class="empty-state"><h3>${t('common.loading')}</h3></div></div>
  `;

  try {
    const [sub, plans] = await Promise.all([api.getSubscription(), api.getPlans()]);
    const content = document.getElementById('billingContent');
    const cur = sub.current_month;
    const suspended = sub.subscription?.status === 'suspended';
    const pastDue = sub.subscription?.status === 'past_due';
    // The bill that caused the banner: oldest first, because that is the one whose grace period
    // ran out. `invoices` arrives newest-first from the API.
    const owing = [...(sub.invoices || [])].reverse().find((i) => i.status !== 'paid' && i.invoice_url);

    content.innerHTML = `
      ${suspended ? `
      <div style="background:var(--bg-secondary);border:1px solid var(--danger);border-left-width:4px;border-radius:var(--radius);padding:14px 16px;margin-bottom:16px">
        <div style="font-size:14px;font-weight:600;color:var(--danger)">${t('billing.suspended_title')}</div>
        <div style="font-size:13px;color:var(--text-secondary);margin-top:4px">${t('billing.suspended_body')}</div>
        ${bannerPayButton(owing)}
      </div>` : pastDue ? `
      <div style="background:var(--bg-secondary);border:1px solid var(--warning);border-left-width:4px;border-radius:var(--radius);padding:14px 16px;margin-bottom:16px">
        <div style="font-size:14px;font-weight:600;color:var(--warning)">${t('billing.past_due_title')}</div>
        <div style="font-size:13px;color:var(--text-secondary);margin-top:4px">${t('billing.past_due_body', { n: sub.subscription.suspend_after_days })}</div>
        ${bannerPayButton(owing)}
      </div>` : ''}

      <div class="settings-section">
        <h3>${t('billing.current_plan')}</h3>
        <div style="display:flex;align-items:center;gap:16px;margin-bottom:16px">
          <div style="font-size:28px;font-weight:700;color:var(--accent-ink)">${esc(sub.plan.display_name)}</div>
          ${sub.plan.price_per_device > 0
            ? `<span style="font-size:14px;color:var(--text-secondary)">${money(sub.plan.price_per_device, sub.plan.currency)}${t('billing.per_screen')}</span>`
            : ''}
          ${sub.self_hosted ? `<span style="background:var(--success-dim);color:var(--success);padding:4px 10px;border-radius:12px;font-size:11px;font-weight:500">${t('billing.self_hosted')}</span>` : ''}
        </div>
        <div class="info-grid" style="margin-bottom:0">
          <div class="info-card">
            <div class="info-card-label">${t('billing.devices')}</div>
            <div class="info-card-value">${sub.usage.devices} <span style="font-size:14px;color:var(--text-secondary)">/ ${sub.plan.max_devices === -1 ? t('billing.unlimited') : sub.plan.max_devices}</span></div>
            ${sub.plan.max_devices > 0 ? `
            <div class="progress-bar">
              <div class="progress-bar-fill ${sub.usage.devices / sub.plan.max_devices > 0.8 ? 'warning' : 'success'}"
                   style="width:${Math.min(100, (sub.usage.devices / sub.plan.max_devices) * 100)}%"></div>
            </div>` : ''}
          </div>
          <div class="info-card">
            <div class="info-card-label">${t('billing.storage')}</div>
            <div class="info-card-value small">${sub.usage.storage_mb} MB <span style="color:var(--text-secondary)">/ ${sub.plan.max_storage_mb === -1 ? t('billing.unlimited') : sub.plan.max_storage_mb + ' MB'}</span></div>
            ${sub.plan.max_storage_mb > 0 ? `
            <div class="progress-bar">
              <div class="progress-bar-fill ${sub.usage.storage_mb / sub.plan.max_storage_mb > 0.8 ? 'warning' : 'success'}"
                   style="width:${Math.min(100, (sub.usage.storage_mb / sub.plan.max_storage_mb) * 100)}%"></div>
            </div>` : ''}
          </div>
          <div class="info-card">
            <div class="info-card-label">${t('billing.features')}</div>
            <div style="font-size:13px;margin-top:4px">
              ${check(sub.plan.widgets_enabled, t('billing.feat.widgets'))}
              ${check(sub.plan.sublists_enabled, t('billing.feat.sublists'))}
              ${check(sub.plan.layouts_enabled, t('billing.feat.layouts'))}
            </div>
          </div>
        </div>
      </div>

      ${sub.billed === false ? `
      <div class="settings-section">
        <h3>${t('billing.not_billed_title')}</h3>
        <p style="color:var(--text-secondary);font-size:13px;margin:0">${t('billing.not_billed_body')}</p>
      </div>` : ''}

      ${cur ? `
      <div class="settings-section">
        <h3>${t('billing.this_month')}</h3>
        <p style="color:var(--text-muted);font-size:12px;margin:-4px 0 14px">
          ${t('billing.this_month_help', { day: sub.subscription.due_day })}
        </p>
        <div class="info-grid" style="margin-bottom:0">
          <div class="info-card">
            <div class="info-card-label">${t('billing.accrued')}</div>
            <div class="info-card-value">${money(cur.amount, cur.currency)}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">
              ${t('billing.days_elapsed', { a: cur.days_elapsed, b: cur.days_in_month })}
            </div>
          </div>
          <div class="info-card">
            <div class="info-card-label">${t('billing.avg_screens')}</div>
            <div class="info-card-value">${cur.avg_screens}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">
              ${t('billing.license_days', { n: cur.license_days })}
              ${cur.min_devices > 0 ? ` &middot; ${t('billing.min_note', { n: cur.min_devices })}` : ''}
            </div>
          </div>
          <div class="info-card">
            <div class="info-card-label">${t('billing.projected')}</div>
            <div class="info-card-value">${money(cur.projected_amount, cur.currency)}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('billing.projected_help')}</div>
          </div>
        </div>
      </div>` : ''}

      <div class="settings-section">
        <h3>${t('billing.company')}</h3>
        <p style="color:var(--text-muted);font-size:12px;margin-bottom:14px">${t('billing.company_help')}</p>
        <div id="companyForm"><p style="color:var(--text-muted);font-size:13px">${t('common.loading')}</p></div>
      </div>

      ${sub.invoices?.length ? `
      <div class="settings-section">
        <h3>${t('billing.invoices')}</h3>
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead>
              <tr style="text-align:left;color:var(--text-muted);font-size:11px;text-transform:uppercase">
                <th style="padding:8px 12px 8px 0">${t('billing.col_month')}</th>
                <th style="padding:8px 12px 8px 0">${t('billing.col_avg')}</th>
                <th style="padding:8px 12px 8px 0">${t('billing.col_amount')}</th>
                <th style="padding:8px 12px 8px 0">${t('billing.col_due')}</th>
                <th style="padding:8px 0">${t('billing.col_status')}</th>
                <th style="padding:8px 0">${t('billing.col_nfse')}</th>
                <th style="padding:8px 0"></th>
              </tr>
            </thead>
            <tbody>
              ${sub.invoices.map(i => `
                <tr style="border-top:1px solid var(--border)">
                  <td style="padding:10px 12px 10px 0">${esc(i.month)}</td>
                  <td style="padding:10px 12px 10px 0;color:var(--text-secondary)">${i.avg_screens} ${t('billing.devices_lc')}</td>
                  <td style="padding:10px 12px 10px 0;font-weight:600">${money(i.amount, i.currency)}</td>
                  <td style="padding:10px 12px 10px 0;color:var(--text-secondary)">${esc(i.due_date || '—')}</td>
                  <td style="padding:10px 0">${invoiceStatusChip(i.status)}</td>
                  <td style="padding:10px 0">${nfseCell(i)}</td>
                  <td style="padding:10px 0;text-align:right">${payLink(i)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>` : ''}

      <div class="settings-section">
        <h3>${t('billing.available_plans')}</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(240px, 1fr));gap:16px">
          ${plans.map(p => `
            <div style="background:var(--bg-secondary);border:${p.id === sub.plan.id ? '2px solid var(--accent-ink)' : '1px solid var(--border)'};border-radius:var(--radius-lg);padding:20px;position:relative">
              ${p.id === sub.plan.id ? `<div style="position:absolute;top:-10px;right:12px;background:var(--accent);color:white;padding:2px 10px;border-radius:10px;font-size:11px;font-weight:500">${t('billing.current')}</div>` : ''}
              <div style="font-size:18px;font-weight:700;margin-bottom:4px">${esc(p.display_name)}</div>
              <div style="font-size:24px;font-weight:700;color:var(--accent-ink);margin-bottom:4px">${planPrice(p)}</div>
              <div style="font-size:11px;color:var(--text-muted);min-height:16px;margin-bottom:10px">
                ${p.min_devices > 0 ? t('billing.min_devices', { n: p.min_devices, total: money(p.min_devices * p.price_per_device, p.currency) }) : (p.price_per_device > 0 ? t('billing.prorated') : '')}
              </div>
              <div style="font-size:13px;color:var(--text-secondary);line-height:2">
                <div>${p.max_devices === -1 ? t('billing.unlimited_devices') : `${p.max_devices} ${t('billing.devices_lc')}`}</div>
                <div>${p.max_storage_mb === -1 ? t('billing.unlimited') : (p.max_storage_mb >= 1024 ? (p.max_storage_mb / 1024) + ' GB' : p.max_storage_mb + ' MB')} ${t('billing.storage_lc')}</div>
                ${check(p.widgets_enabled, t('billing.feat.widgets'))}
                ${check(p.sublists_enabled, t('billing.feat.sublists'))}
                ${check(p.layouts_enabled, t('billing.feat.layouts'))}
              </div>
              ${!sub.self_hosted && p.id !== sub.plan.id ? `
                <button class="btn ${p.price_per_device > 0 ? 'btn-primary' : 'btn-secondary'} btn-sm plan-pick"
                        data-plan="${esc(p.id)}" data-paid="${p.price_per_device > 0 ? '1' : '0'}"
                        data-name="${esc(p.display_name)}" style="width:100%;margin-top:14px">
                  ${p.price_per_device > 0 ? t('billing.choose') : t('billing.downgrade')}
                </button>` : ''}
            </div>
          `).join('')}
        </div>
        ${sub.self_hosted ? `<p style="color:var(--text-muted);font-size:12px;margin-top:12px">${t('billing.self_hosted_note')}</p>` : ''}
      </div>
    `;

    loadCompanyForm();

    // Whether the workspace already has a payer on file decides if the tax-id form is needed.
    const hasTaxId = !!sub.subscription?.asaas_customer_id;
    content.querySelectorAll('.plan-pick').forEach((btn) => {
      btn.addEventListener('click', () => {
        const paid = btn.dataset.paid === '1';
        if (paid && !hasTaxId) return openTaxIdModal(btn.dataset.plan, btn.dataset.name, container);
        confirmPlan(btn.dataset.plan, btn.dataset.name, {}, container);
      });
    });

  } catch (err) {
    const el = document.getElementById('billingContent');
    if (el) el.innerHTML = `<div class="empty-state"><h3>${t('billing.failed_to_load')}</h3><p>${esc(err.message)}</p></div>`;
  }
}

/*
 * WHO THE NOTA FISCAL IS MADE OUT TO.
 *
 * A charge needs a name and a tax id, and that was all this product ever asked for. A nota fiscal
 * needs the rest — the legal name on the registration and a full address — because a municipal web
 * service rejects an emission missing either, and there is no partial credit. There was nowhere in
 * the product to put any of it.
 *
 * WHY IT IS NOT A REQUIRED FORM. A tenant who never asks for a nota fiscal is never asked for any
 * of this. Making it a gate would tax everybody for something most of them will not use, and the
 * fields that matter are exactly the ones somebody has to go and look up.
 */
async function loadCompanyForm() {
  const host = document.getElementById('companyForm');
  if (!host) return;

  let p;
  try { p = await api.getBillingProfile(); }
  catch { host.innerHTML = ''; return; }   // a member without billing rights simply sees nothing

  const v = (x) => esc(x == null ? '' : String(x));
  const field = (id, label, value, extra = '') => `
    <div class="form-group">
      <label style="font-size:12px;color:var(--text-secondary)">${esc(label)}</label>
      <input type="text" id="${id}" class="input" value="${v(value)}" ${extra}>
    </div>`;

  host.innerHTML = `
    <div class="form-grid">
      <div class="form-group" style="grid-column:1/-1">
        <label style="font-size:12px;color:var(--text-secondary)">${t('billing.legal_name')}</label>
        <input type="text" id="cLegalName" class="input" value="${v(p.billing_legal_name)}"
               placeholder="${v(p.fallback_name)}">
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">
          ${t('billing.legal_name_hint', { name: v(p.fallback_name) })}
        </div>
      </div>
      ${field('cTaxId', t('billing.tax_id'), p.billing_tax_id, 'inputmode="numeric" placeholder="00.000.000/0000-00"')}
      ${field('cMunicipal', t('billing.municipal_inscription'), p.billing_municipal_inscription)}
      ${field('cEmail', t('billing.billing_email'), p.billing_contact_email, 'placeholder="financeiro@empresa.com.br"')}
      ${field('cPhone', t('billing.phone'), p.billing_phone, 'inputmode="numeric"')}
      ${field('cCep', t('billing.postal_code'), p.billing_postal_code, 'inputmode="numeric" placeholder="00000-000"')}
      ${field('cAddress', t('billing.address'), p.billing_address)}
      ${field('cNumber', t('billing.address_number'), p.billing_address_number)}
      ${field('cComplement', t('billing.complement'), p.billing_complement)}
      ${field('cProvince', t('billing.province'), p.billing_province)}
    </div>
    <div style="display:flex;gap:10px;align-items:center;margin-top:14px;flex-wrap:wrap">
      <button class="btn btn-primary btn-sm" id="companySave">${t('common.save')}</button>
      <span id="companyResult" style="font-size:12px"></span>
    </div>`;

  document.getElementById('companySave')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const out = document.getElementById('companyResult');
    const say = (text, ok) => { if (out) { out.textContent = text; out.style.color = ok ? 'var(--success)' : 'var(--danger)'; } };

    const val = (id) => document.getElementById(id)?.value ?? '';
    btn.disabled = true;
    try {
      const r = await api.saveBillingProfile({
        billing_legal_name: val('cLegalName'),
        billing_tax_id: val('cTaxId'),
        billing_municipal_inscription: val('cMunicipal'),
        billing_contact_email: val('cEmail'),
        billing_phone: val('cPhone'),
        billing_postal_code: val('cCep'),
        billing_address: val('cAddress'),
        billing_address_number: val('cNumber'),
        billing_complement: val('cComplement'),
        billing_province: val('cProvince'),
      });

      /*
       * The save and the SYNC are reported separately, because they can genuinely differ. Saying
       * only "saved" is what makes the failure impossible to unpick later: the address is right on
       * this screen and wrong on the document, with nothing anywhere explaining the gap.
       */
      if (r.synced === false && r.sync_error) say(t('billing.saved_not_synced', { error: r.sync_error }), false);
      else say(t('billing.saved'), true);
    } catch (e) {
      say(e.message, false);
    } finally {
      btn.disabled = false;
    }
  });
}

/*
 * Collect the payer's CPF/CNPJ before the first paid plan.
 *
 * Asked here rather than at signup because a workspace only needs it at the moment it starts
 * paying — and asked BEFORE the plan is set rather than at month close, because discovering an
 * unusable tax id when there is already a month owed leaves a debt that cannot be charged.
 */
function openTaxIdModal(planId, planName, container) {
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000';
  modal.innerHTML = `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;max-width:420px;width:92vw">
      <h3 style="margin-bottom:6px;color:var(--text-primary)">${t('billing.tax_modal_title', { plan: esc(planName) })}</h3>
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">${t('billing.tax_modal_help')}</p>
      <label style="font-size:12px;color:var(--text-secondary)">${t('billing.tax_id')}</label>
      <input type="text" id="taxIdInput" class="input" placeholder="000.000.000-00" style="width:100%;margin:4px 0 12px" inputmode="numeric">
      <label style="font-size:12px;color:var(--text-secondary)">${t('billing.billing_email')}</label>
      <input type="email" id="billingEmailInput" class="input" placeholder="financeiro@empresa.com.br" style="width:100%;margin:4px 0 18px">
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-secondary" id="taxCancel">${t('common.cancel')}</button>
        <button class="btn btn-primary" id="taxConfirm">${t('billing.confirm')}</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector('#taxIdInput').focus();

  const close = () => modal.remove();
  modal.querySelector('#taxCancel').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  modal.querySelector('#taxConfirm').addEventListener('click', async () => {
    const taxId = modal.querySelector('#taxIdInput').value.replace(/\D/g, '');
    // 11 digits = CPF, 14 = CNPJ. Checked here only to catch a typo before the round trip;
    // the server refuses a paid plan without one regardless.
    if (taxId.length !== 11 && taxId.length !== 14) {
      showToast(t('billing.tax_invalid'), 'error');
      return;
    }
    const email = modal.querySelector('#billingEmailInput').value.trim();
    close();
    confirmPlan(planId, planName, { tax_id: taxId, billing_email: email || undefined }, container);
  });
}

async function confirmPlan(planId, planName, extra, container) {
  try {
    await api.setPlan({ plan_id: planId, ...extra });
    showToast(t('billing.toast.plan_changed', { plan: planName }), 'success');
    // Re-render rather than patching: the plan change moves usage limits, feature ticks and the
    // month-in-progress figures all at once.
    render(container);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

export function cleanup() {}
