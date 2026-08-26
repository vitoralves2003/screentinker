'use strict';

/*
 * WHAT THE TENANT IS TOLD ABOUT THEIR BILL.
 *
 * Until now, nothing. A tenant found out they owed money when the panel stopped saving — the
 * invoice existed, dunning ran, the workspace was suspended, and the only thing that reached the
 * person paying was a 403. Two of them sat suspended over six invoices that had never been issued,
 * which is a bill nobody sent and a door nobody could open.
 *
 * These tests pin the rules that decide what appears, and above all the one that must never drift
 * from services/tenant-invoicing.js: a month with no charge issued is not overdue. If this file
 * said "vencida" where dunning says "not owed", the banner would be threatening a customer with a
 * consequence the system had already decided not to apply.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-notice-' + crypto.randomBytes(4).toString('hex'));
process.env.JWT_SECRET = 'invoice-notice-test-secret';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { noticeFor, daysBetween } = require('../lib/invoice-notice');

const AT = Date.parse('2026-08-26T12:00:00-03:00');   // a plain afternoon in São Paulo
let seq = 0;

/* A workspace with invoices, built fresh per test so no test can lean on another's rows. */
function workspace(invoices, subscriptionStatus = 'active') {
  const id = `ws-notice-${++seq}`;
  db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES ('u-notice','notice@t','x','user')").run();
  db.prepare("INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES ('o-notice','O','u-notice')").run();
  db.prepare(`INSERT INTO workspaces (id, organization_id, name, created_by, subscription_status)
              VALUES (?, 'o-notice', ?, 'u-notice', ?)`).run(id, `Notice ${seq}`, subscriptionStatus);
  for (const inv of invoices) {
    db.prepare(`INSERT INTO workspace_invoices
        (id, workspace_id, month, amount_cents, currency, due_date, invoice_url, status)
        VALUES (?, ?, ?, ?, 'BRL', ?, ?, ?)`)
      .run(`${id}-${inv.month}`, id, inv.month, inv.amount_cents ?? 40000,
        inv.due_date ?? null, inv.invoice_url ?? null, inv.status ?? 'open');
  }
  return id;
}

test('nada devendo, nada a dizer', () => {
  /* A home page that always carries a bar about money teaches the reader to skip the bar. */
  assert.equal(noticeFor(workspace([]), AT), null);
  assert.equal(noticeFor(workspace([{ month: '2026-07', status: 'paid', due_date: '2026-08-05', invoice_url: 'u' }]), AT), null);
  assert.equal(noticeFor(workspace([{ month: '2026-07', status: 'void', due_date: '2026-08-05', invoice_url: 'u' }]), AT), null);
});

test('uma fatura de R$ 0,00 não vira aviso', () => {
  /* Free tiers and exempt months close as real rows. "Você deve R$ 0,00" is noise wearing the
     costume of a warning. */
  assert.equal(noticeFor(workspace([{ month: '2026-07', amount_cents: 0, due_date: '2026-09-05', invoice_url: 'u' }]), AT), null);
});

test('emitida e ainda no prazo: avisa sem alarmar', () => {
  const n = noticeFor(workspace([{ month: '2026-08', due_date: '2026-09-05', invoice_url: 'https://asaas/x' }]), AT);
  assert.equal(n.state, 'due');
  assert.equal(n.days_overdue, 0);
  assert.equal(n.invoice_url, 'https://asaas/x');
});

test('UMA FATURA SEM COBRANÇA EMITIDA NUNCA ESTÁ VENCIDA', () => {
  /*
   * THE INCIDENT THIS IS THE RECORD OF. Six invoices were computed and closed, no Asaas charge was
   * ever created for any of them, and the tenants were suspended anyway. owingSince() in
   * services/tenant-invoicing.js now carries `AND i.invoice_url IS NOT NULL` for that reason.
   *
   * This asserts the banner agrees. The month is old enough to be far past any due date, and it
   * still must not be called overdue: the customer never received a deadline, so there is none to
   * have missed. What they get is the truth — the month closed, this is the amount, nothing is
   * late — which is also the state that tells the operator something is stuck.
   */
  const n = noticeFor(workspace([{ month: '2026-01', due_date: '2026-02-05', invoice_url: null }]), AT);

  assert.equal(n.state, 'uninvoiced');
  assert.equal(n.days_overdue, 0, 'sem cobrança enviada não existe atraso');
  assert.equal(n.stage, 'none');
  assert.equal(n.invoice_url, null);
});

test('vencida conta os dias e diz o que vem a seguir', () => {
  // Venceu em 20/08; hoje é 26/08 -> 6 dias. Suspende com 5, corta com 10.
  const n = noticeFor(workspace([{ month: '2026-07', due_date: '2026-08-20', invoice_url: 'https://asaas/y' }]), AT);

  assert.equal(n.state, 'overdue');
  assert.equal(n.days_overdue, 6);
  assert.equal(n.suspend_in_days, 0, 'o prazo de suspensão já passou');
  assert.equal(n.cut_in_days, 4, 'ainda faltam 4 dias para o corte');
});

test('o estágio vem do workspace, não da data', () => {
  /*
   * services/tenant-invoicing.js é quem suspende, e roda em horário. Se o aviso deduzisse o
   * estágio da data, ele anunciaria ao cliente que o painel está bloqueado enquanto o painel
   * ainda funciona — e a primeira coisa que ele faria era testar, e funcionaria, e a partir daí
   * o aviso não vale nada.
   */
  const late = { month: '2026-07', due_date: '2026-08-01', invoice_url: 'https://asaas/z' };

  assert.equal(noticeFor(workspace([late], 'active'), AT).stage, 'none', 'atrasada mas ainda não suspensa');
  assert.equal(noticeFor(workspace([late], 'suspended'), AT).stage, 'suspended');
  assert.equal(noticeFor(workspace([late], 'cut'), AT).stage, 'cut');
});

test('a mais antiga lidera, e o total não esconde as outras', () => {
  /*
   * Mostrar a mais recente colocaria uma fatura que vence semana que vem no topo enquanto a que
   * está prestes a suspender o cliente fica calada. E um cliente devendo três meses não pode ser
   * avisado de um só e surpreendido pelo resto.
   */
  const n = noticeFor(workspace([
    { month: '2026-06', amount_cents: 40000, due_date: '2026-07-05', invoice_url: 'a' },
    { month: '2026-07', amount_cents: 45000, due_date: '2026-08-05', invoice_url: 'b' },
    { month: '2026-08', amount_cents: 50000, due_date: '2026-09-05', invoice_url: 'c' },
  ]), AT);

  assert.equal(n.month, '2026-06', 'a mais antiga é a que o dunning persegue');
  assert.equal(n.outstanding_count, 3);
  assert.equal(n.outstanding_cents, 135000);
  assert.equal(n.amount_cents, 40000, 'o valor em destaque é o da fatura que lidera');
});

test('vence hoje não é vence ontem, mesmo às nove da noite', () => {
  /*
   * A ARMADILHA DO FUSO. Às 21h de São Paulo já é o dia seguinte em UTC. Uma conta que virasse
   * instantes em vez de dias diria "vencida" para uma fatura que vence hoje, durante três horas,
   * toda noite — e o cliente veria um aviso de atraso enquanto ainda está no prazo.
   */
  const nightInSP = Date.parse('2026-08-26T21:30:00-03:00');
  const n = noticeFor(workspace([{ month: '2026-08', due_date: '2026-08-26', invoice_url: 'https://asaas/hoje' }]), nightInSP);

  assert.equal(n.state, 'due', 'ainda é dia 26 em São Paulo');
  assert.equal(n.days_overdue, 0);
});

test('daysBetween conta dias de calendário, incluindo virada de mês', () => {
  assert.equal(daysBetween('2026-08-26', '2026-08-26'), 0);
  assert.equal(daysBetween('2026-08-31', '2026-09-01'), 1);
  assert.equal(daysBetween('2026-02-28', '2026-03-01'), 1, '2026 não é bissexto');
  assert.equal(daysBetween('2026-09-05', '2026-08-26'), -10, 'ainda no prazo dá negativo');
});
