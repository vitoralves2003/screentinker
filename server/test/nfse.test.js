'use strict';

/*
 * WHEN A NOTA FISCAL IS ISSUED, AND WHEN IT MUST NOT BE.
 *
 * Every rule here costs real money or real trouble when it breaks, and none of them announce
 * themselves — a wrong nota is found by an accountant in a reconciliation, months later, not by
 * anyone using this product.
 *
 *   - TWICE is not a duplicate record. It is declared revenue that was never earned, and undoing
 *     it is a municipal cancellation procedure with a deadline, not a delete.
 *   - BEFORE PAYMENT generates tax on money that may never arrive, for a customer who may be
 *     about to be suspended for not sending it.
 *   - WITH HALF A CONFIGURATION produces a document the system believes exists and the city
 *     rejected.
 *
 * So the pipeline refuses far more often than it acts, and these tests are mostly about the
 * refusals being right.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-nfse-' + crypto.randomBytes(4).toString('hex'));
process.env.JWT_SECRET = 'nfse-test-secret';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const integrations = require('../lib/integration-settings');

/* Asaas is replaced so the emission body can be READ. What crosses to them is the whole point:
 * a test that only checks our own columns proves the half that was never in doubt. */
const asaasPath = require.resolve('../services/asaas');
const calls = [];
let nextResponse = { id: 'nf_1', status: 'SCHEDULED', number: null, pdfUrl: null, xmlUrl: null };
let nextError = null;
require.cache[asaasPath] = {
  id: asaasPath, filename: asaasPath, loaded: true,
  exports: {
    configured: () => true,
    createNfse: async (invoice, cfg) => {
      calls.push({ invoice, cfg });
      if (nextError) throw new Error(nextError);
      return nextResponse;
    },
  },
};

const nfse = require('../services/nfse');

let seq = 0;
function seed({ status = 'paid', charge = 'pay_1', amount = 40000, taxId = '11222333000181', nfseId = null, nfseStatus = null } = {}) {
  const id = `inv-nf-${++seq}`;
  const ws = `ws-nf-${seq}`;
  db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES ('u-nf','nf@t','x','user')").run();
  db.prepare("INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES ('o-nf','O','u-nf')").run();
  db.prepare('INSERT INTO workspaces (id,organization_id,name,created_by,billing_tax_id) VALUES (?,?,?,?,?)')
    .run(ws, 'o-nf', ws, 'u-nf', taxId);
  db.prepare(`INSERT INTO workspace_invoices
      (id, workspace_id, month, amount_cents, due_date, status, asaas_charge_id, nfse_id, nfse_status, avg_screens)
      VALUES (?, ?, '2026-07', ?, '2026-08-05', ?, ?, ?, ?, 4)`)
    .run(id, ws, amount, status, charge, nfseId, nfseStatus);
  return id;
}

/* A complete, emit-able configuration. */
function configure({ enabled = 'true', code = '1.05' } = {}) {
  integrations.savePlain(integrations.K.nfseEnabled, enabled);
  integrations.savePlain(integrations.K.nfseServiceCode, code);
  integrations.savePlain(integrations.K.nfseServiceName, 'Licenciamento de software');
  integrations.savePlain(integrations.K.nfseIss, '2,5');
}

beforeEach(() => { calls.length = 0; nextError = null; nextResponse = { id: 'nf_' + Date.now(), status: 'SCHEDULED' }; });

test('sem configuração fiscal, não emite — e diz o que falta', async () => {
  /*
   * Não é uma falha: é uma recusa. Um sistema que tentasse emitir com meia configuração produziria
   * um documento que ele acha que existe e a prefeitura recusou — e essa diferença é descoberta na
   * contabilidade, não aqui.
   */
  integrations.savePlain(integrations.K.nfseEnabled, 'false');
  let r = await nfse.issueFor(seed());
  assert.equal(r.issued, false);
  assert.match(r.reason, /desligada/);

  integrations.savePlain(integrations.K.nfseEnabled, 'true');
  integrations.savePlain(integrations.K.nfseServiceCode, '');
  r = await nfse.issueFor(seed());
  assert.equal(r.issued, false);
  assert.match(r.reason, /código de serviço/, 'a recusa precisa nomear a peça que falta');
  assert.equal(calls.length, 0, 'nada pode ter ido para o Asaas');
});

test('alíquota zero é resposta válida e não conta como configuração incompleta', () => {
  /*
   * Simples Nacional, ou uma cidade onde o ISS é retido pelo tomador. Usar "taxa zero" como sinal
   * de formulário inacabado impediria de emitir exatamente quem está certo.
   */
  configure();
  integrations.savePlain(integrations.K.nfseIss, '0');
  assert.equal(integrations.nfse().ready, true);
  assert.equal(integrations.nfse().taxes.iss, 0);
});

test('vírgula decimal é o que o contador escreve', () => {
  configure();
  integrations.savePlain(integrations.K.nfseIss, '2,5');
  assert.equal(integrations.nfse().taxes.iss, 2.5);

  // E o que não é número vira zero, nunca NaN: um NaN numa carga tributária ou é recusado pela
  // prefeitura ou, pior, aceito.
  integrations.savePlain(integrations.K.nfseCofins, 'três por cento');
  assert.equal(integrations.nfse().taxes.cofins, 0);
});

test('fatura não paga não gera nota', async () => {
  /*
   * A nota declara serviço prestado E pago. Emitir na cobrança geraria imposto sobre dinheiro que
   * pode nunca chegar — do cliente que talvez esteja prestes a ser suspenso por não mandá-lo.
   */
  configure();
  const r = await nfse.issueFor(seed({ status: 'open' }));
  assert.equal(r.issued, false);
  assert.match(r.reason, /ainda não paga/);
  assert.equal(calls.length, 0);
});

test('NUNCA DUAS VEZES PELO MESMO MÊS', async () => {
  /*
   * O Asaas manda PAYMENT_RECEIVED e PAYMENT_CONFIRMED pelo mesmo dinheiro, um webhook pode ser
   * reentregue, e o operador pode apertar um botão. A guarda fica na própria linha e não depende
   * de ninguém se comportar.
   */
  configure();
  const id = seed();

  const first = await nfse.issueFor(id);
  assert.equal(first.issued, true);
  assert.equal(calls.length, 1);

  const second = await nfse.issueFor(id);
  assert.equal(second.issued, false, 'duas notas pelo mesmo mês é receita declarada que não existiu');
  assert.match(second.reason, /já emitida/);
  assert.equal(calls.length, 1, 'o Asaas não pode ter sido chamado de novo');
});

test('mas uma que deu ERRO pode ser tentada de novo', async () => {
  /*
   * ERROR não é terminal, e essa distinção é o motivo de guardar o status do Asaas em vez de um
   * booleano: uma emissão que falhou é precisamente o que uma nova tentativa existe para resolver.
   */
  configure();
  const id = seed({ nfseId: 'nf_velha', nfseStatus: 'ERROR' });
  const r = await nfse.issueFor(id);
  assert.equal(r.issued, true);
  assert.equal(calls.length, 1);
});

test('cliente sem CPF/CNPJ para antes de virar recusa da prefeitura', async () => {
  configure();
  const r = await nfse.issueFor(seed({ taxId: null }));
  assert.equal(r.issued, false);
  assert.match(r.reason, /CPF\/CNPJ/);
});

test('a falha fica GRAVADA, não só no log', async () => {
  /*
   * Uma nota que não saiu é dinheiro recebido sem documento — a única coisa que o operador precisa
   * conseguir achar. Uma linha no log do contêiner de ontem não é achável.
   */
  configure();
  const id = seed();
  nextError = 'código de serviço não pertence ao município';

  const r = await nfse.issueFor(id);
  assert.equal(r.issued, false);

  const row = db.prepare('SELECT nfse_status, nfse_error FROM workspace_invoices WHERE id = ?').get(id);
  assert.equal(row.nfse_status, 'ERROR');
  assert.match(row.nfse_error, /não pertence ao município/);

  // E aparece na lista do que está pendente, que é onde alguém olha.
  assert.ok(nfse.pending().some((i) => i.id === id));
});

test('o webhook atualiza a nota pelo id dela, e ERROR guarda o motivo', () => {
  configure();
  const id = seed();
  db.prepare("UPDATE workspace_invoices SET nfse_id = 'nf_hook', nfse_status = 'SCHEDULED' WHERE id = ?").run(id);

  assert.equal(nfse.applyWebhook({ id: 'nf_hook', status: 'AUTHORIZED', number: '2026/141', pdfUrl: 'https://x/pdf' }), true);
  let row = db.prepare('SELECT * FROM workspace_invoices WHERE id = ?').get(id);
  assert.equal(row.nfse_status, 'AUTHORIZED');
  assert.equal(row.nfse_number, '2026/141');
  assert.equal(row.nfse_pdf_url, 'https://x/pdf');

  /*
   * A RECUSA DA PREFEITURA. Sem tratar isto, a linha fica com o status que a criação devolveu e um
   * documento recusado continua lendo como emitido — a falha que mais importa e a que ninguém
   * pensaria em procurar.
   */
  nfse.applyWebhook({ id: 'nf_hook', status: 'ERROR', statusDescription: 'Inscrição municipal inválida' });
  row = db.prepare('SELECT nfse_status, nfse_error FROM workspace_invoices WHERE id = ?').get(id);
  assert.equal(row.nfse_status, 'ERROR');
  assert.match(row.nfse_error, /Inscrição municipal inválida/);

  assert.equal(nfse.applyWebhook({ id: 'nf_que_nao_existe', status: 'AUTHORIZED' }), false);
  assert.equal(nfse.applyWebhook(null), false);
});

test('o que vai para o Asaas é o valor da fatura, não um número digitado aqui', async () => {
  configure();
  const id = seed({ amount: 135000 });
  await nfse.issueFor(id);

  const { invoice, cfg } = calls[0];
  assert.equal(invoice.amount_cents, 135000, 'a nota tem de declarar o que foi cobrado');
  assert.equal(invoice.asaas_charge_id, 'pay_1', 'pendurada na cobrança, para não haver duas cópias do número');
  assert.equal(cfg.serviceCode, '1.05');
  assert.equal(cfg.taxes.iss, 2.5);
});
