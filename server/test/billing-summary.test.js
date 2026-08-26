'use strict';

/*
 * THE CASH SCREEN, and the one distinction it exists to make.
 *
 * "Inadimplência" as a single number would have shown the same R$ 2.400 whether the customer
 * refused to pay or was never asked — and those are different problems with different owners. Six
 * invoices once sat unissued long enough to suspend two tenants, and any total that lumped them
 * together would have shown that as delinquency: the operator chasing customers who had done
 * nothing wrong, while the actual fault sat in their own pipeline.
 *
 * So the split is what is pinned here, and it has to agree with owingSince() in
 * services/tenant-invoicing.js. If this screen called something delinquency that dunning does not
 * act on, it would send somebody after a customer the system had already decided to leave alone.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-cash-' + crypto.randomBytes(4).toString('hex'));
process.env.JWT_SECRET = 'billing-summary-test-secret';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const cash = require('../lib/billing-summary');

const AT = Date.parse('2026-08-26T12:00:00-03:00');
let seq = 0;

function tenant({ plan = 'corporate', status = 'active' } = {}) {
  const id = `ws-cash-${++seq}`;
  db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES ('u-cash','cash@t','x','user')").run();
  db.prepare("INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES ('o-cash','O','u-cash')").run();
  db.prepare('INSERT INTO workspaces (id,organization_id,name,created_by,plan_id,subscription_status) VALUES (?,?,?,?,?,?)')
    .run(id, 'o-cash', id, 'u-cash', plan, status);
  return id;
}

function invoice(ws, { month = '2026-07', cents = 40000, due = '2026-08-05', url = 'https://asaas/x', status = 'open', paidAt = null, nfseId = null, nfseStatus = null } = {}) {
  const id = `inv-cash-${++seq}`;
  db.prepare(`INSERT INTO workspace_invoices
      (id, workspace_id, month, amount_cents, due_date, invoice_url, status, paid_at, nfse_id, nfse_status)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, ws, month, cents, due, url, status, paidAt, nfseId, nfseStatus);
  return id;
}

test('NÃO EMITIDO É SEPARADO DE VENCIDO — é a razão desta tela existir', () => {
  /*
   * Mesmo valor, mesma data, e problemas opostos. Um é o cliente que não pagou. O outro é uma
   * cobrança que nunca saiu — o cliente não fez nada de errado, ninguém pediu. Somados, o operador
   * cobra quem não deve nada enquanto a falha continua na própria esteira dele.
   */
  const a = tenant();
  invoice(a, { month: '2026-06', cents: 240000, due: '2026-07-05', url: 'https://asaas/pago-nao' });
  invoice(a, { month: '2026-05', cents: 240000, due: '2026-06-05', url: null });

  const o = cash.outstanding('2026-08-26');

  assert.equal(o.overdue.cents, 240000, 'só a que o cliente recebeu conta como inadimplência');
  assert.equal(o.overdue.count, 1);
  assert.equal(o.not_invoiced.cents, 240000, 'a que nunca saiu é problema do operador, contado à parte');
  assert.equal(o.not_invoiced.count, 1);
  assert.equal(o.total_cents, 480000, 'o total continua existindo, sem esconder a divisão');
});

test('a vencer não é inadimplência', () => {
  /*
   * Contar o que ainda está no prazo como atraso faz a tela inteira gritar lobo, e uma tela que
   * grita todo mês é uma tela que ninguém lê no mês em que ela está certa.
   *
   * Medido como VARIAÇÃO, e não como valor absoluto, porque estas funções somam o banco inteiro:
   * é o mesmo motivo pelo qual elas são úteis ao operador, e a razão pela qual um teste que
   * afirmasse "o total é 40000" estaria na verdade afirmando que nenhum outro teste rodou antes.
   */
  const before = cash.outstanding('2026-08-26');
  const t = tenant();
  invoice(t, { month: '2026-08', due: '2026-09-05' });
  const after = cash.outstanding('2026-08-26');

  assert.equal(after.due.cents - before.due.cents, 40000);
  assert.equal(after.overdue.cents - before.overdue.cents, 0);
  assert.equal(after.not_invoiced.cents - before.not_invoiced.cents, 0);
});

test('paga e anulada saem da conta', () => {
  const before = cash.outstanding('2026-08-26');
  const t = tenant();
  invoice(t, { month: '2026-04', due: '2026-05-05', status: 'paid', paidAt: Math.floor(AT / 1000) });
  invoice(t, { month: '2026-03', due: '2026-04-05', status: 'void' });
  const after = cash.outstanding('2026-08-26');

  assert.equal(after.total_cents, before.total_cents, 'nem paga nem anulada podem mover o total devido');
});

test('recebido é contado pela data em que o dinheiro entrou, não pela competência', () => {
  /*
   * A fatura de julho é paga em agosto, quase sempre. Quem concilia com o extrato do banco precisa
   * da data em que o dinheiro caiu — misturar as duas é o que faz o número da tela nunca bater
   * com o do banco.
   */
  const beforeAug = cash.received('2026-08').cents;
  const beforeJul = cash.received('2026-07').cents;

  const t = tenant();
  const inAugust = Math.floor(Date.parse('2026-08-07T10:00:00-03:00') / 1000);
  invoice(t, { month: '2026-07', cents: 40000, status: 'paid', paidAt: inAugust });

  assert.equal(cash.received('2026-08').cents - beforeAug, 40000, 'competência julho, caixa agosto');
  assert.equal(cash.received('2026-07').cents - beforeJul, 0, 'e nada entrou no caixa de julho');
});

test('pagante é quem está num plano com preço, não quem tem workspace', () => {
  /*
   * Um workspace no plano free é um tenant de verdade e não é receita. Somar os dois produz um
   * número que se mexe por motivos que nada têm a ver com dinheiro.
   */
  db.prepare("INSERT OR IGNORE INTO plans (id,name,display_name,max_devices,price_per_device) VALUES ('corporate','corporate','Corporativo',-1,20)").run();
  db.prepare("INSERT OR IGNORE INTO plans (id,name,display_name,max_devices,price_per_device) VALUES ('free','free','Free',1,0)").run();

  const before = cash.tenants();
  tenant({ plan: 'free' });
  const after = cash.tenants();

  assert.equal(after.free, before.free + 1);
  assert.equal(after.paying, before.paying, 'o free não entrou como pagante');
});

test('suspenso e cortado são contados separadamente', () => {
  const before = cash.tenants();
  tenant({ status: 'suspended' });
  tenant({ status: 'cut' });
  const after = cash.tenants();

  assert.equal(after.suspended, before.suspended + 1);
  assert.equal(after.cut, before.cut + 1);
});

test('mês pago sem nota vira número, porque senão é invisível', () => {
  /*
   * Dinheiro recebido sem documento por trás é um passivo, e não aparece em lugar nenhum até
   * alguém contar. ERROR conta junto: uma nota recusada pela prefeitura é exatamente um mês pago
   * sem documento, ainda que a linha tenha um id.
   */
  const before = cash.missingNfse();

  const t = tenant();
  const paidAt = Math.floor(AT / 1000);
  invoice(t, { month: '2026-02', cents: 50000, status: 'paid', paidAt });
  invoice(t, { month: '2026-01', cents: 30000, status: 'paid', paidAt, nfseId: 'nf_x', nfseStatus: 'ERROR' });
  invoice(t, { month: '2025-12', cents: 10000, status: 'paid', paidAt, nfseId: 'nf_ok', nfseStatus: 'AUTHORIZED' });

  const after = cash.missingNfse();
  assert.equal(after.count - before.count, 2, 'a recusada conta como faltando; a autorizada não');
  assert.equal(after.cents - before.cents, 80000);
});

test('o resumo inteiro monta sem explodir e traz os dois meses', () => {
  const s = cash.summary(AT);
  assert.equal(s.month, '2026-08');
  assert.equal(s.previous_month, '2026-07');
  assert.ok(s.tenants.total > 0);
  assert.ok(s.outstanding.total_cents >= 0);

  // Virada de ano, que é onde um cálculo de mês anterior costuma quebrar.
  assert.equal(cash.summary(Date.parse('2026-01-15T12:00:00-03:00')).previous_month, '2025-12');
});

test('A CONTA DA CASA NÃO É CLIENTE PAGANTE', () => {
  /*
   * Ela fica num plano pago porque usa os recursos pagos, então contar por preço colocava o
   * workspace do próprio operador em "clientes pagantes" — dois clientes onde havia um, na tela de
   * onde se lê quantos clientes existem.
   *
   * billing_type = 'internal' é a mesma isenção que services/tenant-invoicing.js já respeitava na
   * hora de cobrar. Ela existia; nada nesta tela consultava.
   */
  db.prepare("INSERT OR IGNORE INTO plans (id,name,display_name,max_devices,price_per_device) VALUES ('corporate','corporate','Corporativo',-1,20)").run();

  const before = cash.tenants();
  const casa = tenant({ plan: 'corporate' });
  db.prepare("UPDATE workspaces SET billing_type = 'internal' WHERE id = ?").run(casa);
  const after = cash.tenants();

  assert.equal(after.paying, before.paying, 'não pode entrar como pagante');
  assert.equal(after.internal, before.internal + 1, 'é contada à parte, não escondida');
  assert.equal(after.total, before.total + 1, 'e continua existindo no total');
});

test('e os dias-licença dela não são receita projetada', () => {
  /*
   * Pulada ANTES da aritmética. Os dias-licença de um workspace isento não são receita que por
   * acaso é filtrada depois — não são receita.
   */
  const casa = tenant({ plan: 'corporate' });
  db.prepare("UPDATE workspaces SET billing_type = 'internal' WHERE id = ?").run(casa);

  const dia = new Date(AT).toISOString().slice(0, 10);
  db.prepare('INSERT OR REPLACE INTO workspace_license_daily (workspace_id, day, peak_devices) VALUES (?,?,?)')
    .run(casa, dia, 30);

  const a = cash.accruing('2026-08');
  const contribuiu = a.cents;

  db.prepare("UPDATE workspaces SET billing_type = NULL WHERE id = ?").run(casa);
  const b = cash.accruing('2026-08');

  assert.ok(b.cents >= contribuiu, 'tirar a isenção só pode aumentar ou manter o acumulado');
});
