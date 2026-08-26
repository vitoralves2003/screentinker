'use strict';

/*
 * WHEN A NOTA FISCAL GETS ISSUED, AND WHEN IT DELIBERATELY DOES NOT.
 *
 * One document per closed month, issued after the money actually arrives. Everything hard about
 * this is in the "does not" half.
 *
 * ── AFTER PAYMENT, NEVER BEFORE ──────────────────────────────────────────────────────────────
 * A nota fiscal declares that a service was rendered AND paid for. Issuing it when the charge goes
 * out would generate tax on money that may never come, for a customer who may be about to be
 * suspended for not paying it. And it does not undo cleanly: cancelling an NFS-e is a municipal
 * procedure with a deadline, not a delete.
 *
 * ── ONCE, EVER ───────────────────────────────────────────────────────────────────────────────
 * Two notas for one month is not a duplicate record, it is declared revenue that was never earned,
 * and somebody's accountant finds it in a reconciliation months later. Asaas can send PAYMENT_
 * RECEIVED and PAYMENT_CONFIRMED for the same money, a webhook can be retried, and the operator can
 * press a button — so the guard is on the row itself and does not depend on anyone behaving.
 *
 * ── AND IT STANDS DOWN RATHER THAN GUESSING ──────────────────────────────────────────────────
 * With no service code and no rates there is nothing to emit that would be correct. It refuses,
 * says which piece is missing, and leaves the invoice paid and clean — because a rejected document
 * is one the system believes exists and the city does not, and that gap is found by an accountant
 * rather than by anybody here.
 */

const { db } = require('../db/database');
const integrations = require('../lib/integration-settings');
const asaas = require('./asaas');

/* Terminal for our purposes: a document that exists, or is on its way, must not be asked for
 * again. ERROR is deliberately NOT here — a failed emission is exactly what a retry is for. */
const ALREADY = new Set(['SCHEDULED', 'SYNCHRONIZED', 'AUTHORIZED', 'PROCESSING_CANCELLATION']);

/*
 * Why this invoice cannot have a nota issued right now, or null when it can.
 *
 * Returned as a REASON rather than a boolean so the caller can log something a person can act on.
 * "Emission skipped" in a log at 2am is the message that gets ignored for a quarter.
 */
function blocker(invoice, cfg) {
  if (!cfg.enabled) return 'nota fiscal desligada nas integrações';
  if (!cfg.serviceCode) return 'sem código de serviço municipal';
  if (!asaas.configured()) return 'Asaas sem chave configurada';

  if (!invoice) return 'fatura não encontrada';
  if (invoice.status !== 'paid') return `fatura ainda não paga (${invoice.status})`;
  if (!invoice.asaas_charge_id) return 'fatura sem cobrança no Asaas';
  if (!(invoice.amount_cents > 0)) return 'fatura sem valor';
  if (invoice.nfse_id && ALREADY.has(invoice.nfse_status)) return `nota já emitida (${invoice.nfse_status})`;

  /*
   * The recipient has to be somebody. A nota fiscal without a tax id is not a document with a gap
   * in it — the municipal service refuses the whole submission, and the refusal arrives as an
   * opaque code long after the person who could fill the field in has stopped looking.
   */
  const ws = db.prepare('SELECT billing_tax_id FROM workspaces WHERE id = ?').get(invoice.workspace_id);
  if (!ws || !ws.billing_tax_id) return 'cliente sem CPF/CNPJ cadastrado';

  return null;
}

/* Write back whatever Asaas said about the document, in one place, so the columns cannot drift
 * apart across the several paths that learn about it (emission, webhook, manual reconcile). */
function record(invoiceId, nfse) {
  db.prepare(`UPDATE workspace_invoices
                 SET nfse_id = ?, nfse_status = ?, nfse_number = ?,
                     nfse_pdf_url = ?, nfse_xml_url = ?, nfse_error = NULL,
                     nfse_requested_at = COALESCE(nfse_requested_at, strftime('%s','now'))
               WHERE id = ?`)
    .run(nfse.id || null, nfse.status || null, nfse.number || null,
      nfse.pdfUrl || null, nfse.xmlUrl || null, invoiceId);
}

/*
 * Issue the nota for one invoice.
 *
 * Never throws: this runs inside a webhook handler, and an exception there turns into a non-200
 * that makes Asaas retry the PAYMENT event — replaying a settlement to fix a tax document, which
 * is the wrong lever entirely. The outcome comes back as a value instead.
 *
 * @returns {{issued: boolean, reason?: string, nfse_id?: string, status?: string}}
 */
async function issueFor(invoiceId) {
  const cfg = integrations.nfse();
  const invoice = db.prepare('SELECT * FROM workspace_invoices WHERE id = ?').get(invoiceId);

  const why = blocker(invoice, cfg);
  if (why) {
    console.log(`[nfse] ${invoiceId}: não emitida — ${why}`);
    return { issued: false, reason: why };
  }

  try {
    const nfse = await asaas.createNfse(invoice, cfg);
    record(invoiceId, nfse);
    console.log(`[nfse] ${invoiceId}: emitida ${nfse.id} (${nfse.status})`);
    return { issued: true, nfse_id: nfse.id, status: nfse.status };
  } catch (err) {
    /*
     * The failure is STORED, not just logged. A nota that could not be issued is money already
     * received with no document behind it — the single thing the operator must be able to find,
     * and a line in yesterday's container log is not findable.
     */
    db.prepare('UPDATE workspace_invoices SET nfse_error = ?, nfse_status = ? WHERE id = ?')
      .run(String(err.message).slice(0, 500), 'ERROR', invoiceId);
    console.error(`[nfse] ${invoiceId}: falhou — ${err.message}`);
    return { issued: false, reason: err.message };
  }
}

/*
 * Everything that Asaas told us about a document, from a webhook.
 *
 * Matched on nfse_id rather than the charge: a document can be cancelled and re-issued, and the
 * charge would then point at two of them.
 */
function applyWebhook(nfse) {
  if (!nfse || !nfse.id) return false;
  const row = db.prepare('SELECT id FROM workspace_invoices WHERE nfse_id = ?').get(nfse.id);
  if (!row) return false;

  if (nfse.status === 'ERROR') {
    db.prepare('UPDATE workspace_invoices SET nfse_status = ?, nfse_error = ? WHERE id = ?')
      .run('ERROR', String(nfse.statusDescription || nfse.error || 'erro na emissão').slice(0, 500), row.id);
    return true;
  }

  record(row.id, nfse);
  return true;
}

/*
 * The months that are paid and have no document. Two jobs in one list: it is what a retry sweep
 * works through, and it is the number the operator needs to see — revenue received with nothing
 * issued against it is the gap that matters, and it is invisible until it is counted.
 */
function pending(limit = 50) {
  return db.prepare(`
    SELECT i.*, w.name AS workspace_name
      FROM workspace_invoices i
      JOIN workspaces w ON w.id = i.workspace_id
     WHERE i.status = 'paid'
       AND i.amount_cents > 0
       AND (i.nfse_id IS NULL OR i.nfse_status = 'ERROR')
     ORDER BY i.month DESC
     LIMIT ?`).all(limit);
}

module.exports = { issueFor, applyWebhook, pending, blocker, ALREADY };
