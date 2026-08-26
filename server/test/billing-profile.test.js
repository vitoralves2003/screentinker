'use strict';

/*
 * THE TENANT'S COMPANY DETAILS, over HTTP.
 *
 * WHAT THIS GUARDS. A charge needs a name and a tax id; a nota fiscal needs the legal name and a
 * full address. There was nowhere in the product to put either, so the first emission would have
 * failed against a municipal web service with a message nobody here could act on.
 *
 * The wiring is what is checked, not the arithmetic — br-fiscal is tested on its own. What goes
 * wrong in a route is never clever: it is a field that silently does not save, an empty string that
 * erases an address nobody meant to clear, or a save that reports success while the copy Asaas
 * holds — the one the document is actually built from — still says something else.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bprof-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'billing-profile-test-secret';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { db } = require('../db/database');

/*
 * The Asaas client is replaced before the router loads it. The point is not to avoid the network —
 * it is to SEE the body, because the whole reason these columns exist is what they become on the
 * far side, and a test that only reads our own database proves the half that was never in doubt.
 */
const asaasPath = require.resolve('../services/asaas');
const sent = [];
require.cache[asaasPath] = {
  id: asaasPath, filename: asaasPath, loaded: true,
  exports: {
    configured: () => true,
    syncCustomer: async (workspaceId) => {
      const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
      if (!ws.billing_tax_id) throw new Error('no tax id');
      sent.push(ws);
      return 'cus_test';
    },
    ensureCustomer: async () => 'cus_test',
  },
};

const { generateToken } = require('../middleware/auth');
let server, base, token;

const call = async (method, body) => {
  const res = await fetch(`${base}/api/subscription/billing-profile`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'x-workspace-id': 'ws-prof',
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

before(async () => {
  db.prepare("INSERT INTO users (id,email,password_hash,role) VALUES ('u-prof','prof@t','x','user')").run();
  db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('o-prof','O','u-prof')").run();
  db.prepare("INSERT INTO workspaces (id,organization_id,name,created_by) VALUES ('ws-prof','o-prof','Padaria do Zé','u-prof')").run();
  db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('ws-prof','u-prof','workspace_admin')").run();

  token = generateToken(db.prepare('SELECT id,email,role FROM users WHERE id = ?').get('u-prof'), null);

  const app = express();
  app.use(express.json());
  app.use('/api/subscription', require('../routes/subscription'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

test('começa vazio, e diz qual nome a nota levaria hoje', async () => {
  const r = await call('GET');
  assert.equal(r.status, 200);
  assert.equal(r.json.billing_legal_name, null);
  assert.equal(r.json.fallback_name, 'Padaria do Zé',
    'sem razão social, o formulário precisa mostrar o que sairia no documento em vez de um campo vazio');
  assert.equal(r.json.synced, false);
});

test('um CNPJ com um dígito trocado é recusado ANTES de virar nota fiscal', async () => {
  /*
   * O erro que este teste existe para impedir: o número passa por todo campo de texto do caminho e
   * falha semanas depois, na emissão, quando o cliente já pagou e quem digitou fechou a página.
   */
  const r = await call('PUT', { billing_tax_id: '11.222.333/0001-82' });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'INVALID_TAX_ID');

  const ws = db.prepare('SELECT billing_tax_id FROM workspaces WHERE id = ?').get('ws-prof');
  assert.equal(ws.billing_tax_id, null, 'nada pode ter sido gravado');
});

test('CEP com sete dígitos e e-mail sem arroba também param aqui', async () => {
  assert.equal((await call('PUT', { billing_postal_code: '0131010' })).json.code, 'INVALID_CEP');
  assert.equal((await call('PUT', { billing_contact_email: 'zé arroba padaria' })).json.code, 'INVALID_EMAIL');
});

test('salva, guarda só dígitos, e manda para o Asaas', async () => {
  sent.length = 0;
  const r = await call('PUT', {
    billing_legal_name: 'Padaria do Zé Comércio de Alimentos LTDA',
    billing_tax_id: '11.222.333/0001-81',
    billing_postal_code: '01310-100',
    billing_address: 'Avenida Paulista',
    billing_address_number: '1578',
    billing_province: 'Bela Vista',
    billing_contact_email: 'financeiro@padariadoze.com.br',
  });

  assert.equal(r.status, 200);
  assert.equal(r.json.synced, true, 'salvar sem avisar que o Asaas não recebeu é o bug que isto evita');
  assert.equal(r.json.sync_error, null);

  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get('ws-prof');
  assert.equal(ws.billing_tax_id, '11222333000181', 'pontuação é apresentação; guarda-se o número');
  assert.equal(ws.billing_postal_code, '01310100');
  assert.equal(ws.billing_legal_name, 'Padaria do Zé Comércio de Alimentos LTDA');

  assert.equal(sent.length, 1, 'o Asaas tem de ser avisado no mesmo ato');
  assert.equal(sent[0].billing_address, 'Avenida Paulista');
});

test('um campo que não veio fica como está; um campo vazio é apagado de propósito', async () => {
  /*
   * A DIFERENÇA IMPORTA. O formulário manda tudo que desenha, então "" é alguém olhando para o
   * campo e decidindo limpá-lo. Ausência é um cliente de API que nunca teve aquele campo — e
   * tratar os dois igual apaga o endereço de quem só quis corrigir o telefone.
   */
  await call('PUT', { billing_phone: '1140028922' });
  let ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get('ws-prof');
  assert.equal(ws.billing_address, 'Avenida Paulista', 'o endereço não foi tocado');
  assert.equal(ws.billing_phone, '1140028922');

  await call('PUT', { billing_complement: '' });
  ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get('ws-prof');
  assert.equal(ws.billing_complement, null, 'vazio limpa');
  assert.equal(ws.billing_address, 'Avenida Paulista', 'e só o campo enviado');
});

test('quando o Asaas recusa, o salvamento vale e a tela é avisada', async () => {
  /*
   * O estado que confunde é ter corrigido aqui enquanto o documento ainda carrega o valor antigo.
   * Silenciar isso foi o que tornou o comportamento anterior impossível de desemaranhar: certo na
   * tela, errado na nota, sem nada em lugar nenhum explicando a diferença.
   */
  const original = require.cache[asaasPath].exports.syncCustomer;
  require.cache[asaasPath].exports.syncCustomer = async () => { throw new Error('CEP não encontrado'); };

  const r = await call('PUT', { billing_address_number: '1578-A' });
  assert.equal(r.status, 200, 'os dados do cliente são dele: recusar a gravação puniria a pessoa errada');
  assert.equal(r.json.synced, false);
  assert.match(r.json.sync_error, /CEP não encontrado/);

  const ws = db.prepare('SELECT billing_address_number FROM workspaces WHERE id = ?').get('ws-prof');
  assert.equal(ws.billing_address_number, '1578-A', 'gravado mesmo assim');

  require.cache[asaasPath].exports.syncCustomer = original;
});

test('o cadastro fiscal de outro cliente não se lê pedindo por ele', async () => {
  /*
   * A PERGUNTA QUE IMPORTA. Isto é o CNPJ, o endereço e a inscrição municipal de uma empresa real
   * — não é configuração, é documento. O jeito de vazar nunca é um ataque elaborado: é um header
   * aceito sem conferir de quem o workspace é.
   *
   * O esperado NÃO é um erro. resolveTenancy cai no workspace do próprio usuário quando o pedido
   * não resolve, então 200 é correto — desde que o corpo seja o cadastro DELE. Um teste que só
   * olhasse o código de status não saberia distinguir as duas coisas, e é justamente a diferença
   * entre funcionar e vazar.
   */
  db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES ('u-outro','outro@t','x','user')").run();
  db.prepare("INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES ('o-outro','Outra','u-outro')").run();
  db.prepare(`INSERT OR IGNORE INTO workspaces
      (id,organization_id,name,created_by,billing_legal_name,billing_tax_id)
      VALUES ('ws-outro','o-outro','Concorrente','u-outro','Concorrente Comercio LTDA','52998224725')`).run();
  db.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role) VALUES ('ws-outro','u-outro','workspace_admin')").run();

  const res = await fetch(`${base}/api/subscription/billing-profile`, {
    headers: { Authorization: `Bearer ${token}`, 'x-workspace-id': 'ws-outro' },
  });
  const body = await res.json().catch(() => ({}));

  assert.notEqual(body.billing_legal_name, 'Concorrente Comercio LTDA', 'a razão social do vizinho vazou');
  assert.notEqual(body.billing_tax_id, '52998224725', 'o CNPJ do vizinho vazou');
  if (res.status === 200) {
    assert.equal(body.fallback_name, 'Padaria do Zé', 'caiu no próprio workspace, que é o certo');
  }
});
