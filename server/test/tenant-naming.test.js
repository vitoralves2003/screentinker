'use strict';

/*
 * WHAT A TENANT IS CALLED.
 *
 * Every account that ever signed up produced a workspace named "Default". The admin list was a
 * column of identical rows, the customer's own sidebar said "Default" back at them, and support
 * had nothing to search for — the one label used to tell one customer from another named nobody.
 *
 * Two rules replace it, and the second one has a cost that was weighed and accepted:
 *
 *   AT SIGNUP the tenant takes the person's name, falling back to their e-mail. Ugly beats
 *   anonymous: a tenant this product cannot name is a tenant nobody can find.
 *
 *   ON COMPANY DATA it takes the company's name, automatically, WITHOUT asking — and overwrites a
 *   name the customer chose. That is a real loss and it is deliberate: a rename that waits for
 *   somebody to press a button is a rename that mostly does not happen, and support has to be able
 *   to find "the Padaria" by searching for the Padaria.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tname-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'tenant-naming-test-secret';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { db } = require('../db/database');

/* Asaas stubbed out: naming is the subject, and a customer sync failing must not decide it. */
const asaasPath = require.resolve('../services/asaas');
require.cache[asaasPath] = {
  id: asaasPath, filename: asaasPath, loaded: true,
  exports: { configured: () => false, syncCustomer: async () => 'cus', ensureCustomer: async () => 'cus' },
};

const { generateToken } = require('../middleware/auth');
let server, base, token;

const save = async (body) => {
  const res = await fetch(`${base}/api/subscription/billing-profile`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'x-workspace-id': 'ws-name', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

const nameOf = () => db.prepare('SELECT name FROM workspaces WHERE id = ?').get('ws-name').name;

before(async () => {
  db.prepare("INSERT INTO users (id,email,name,password_hash,role) VALUES ('u-name','ze@padaria.com','Zé da Silva','x','user')").run();
  db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('o-name','O','u-name')").run();
  db.prepare("INSERT INTO workspaces (id,organization_id,name,created_by) VALUES ('ws-name','o-name','Zé da Silva','u-name')").run();
  db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('ws-name','u-name','workspace_admin')").run();

  token = generateToken(db.prepare('SELECT id,email,role FROM users WHERE id = ?').get('u-name'), null);

  const app = express();
  app.use(express.json());
  app.use('/api/subscription', require('../routes/subscription'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

test('NENHUM tenant se chama "Default" — nem no cadastro, nem no banco', () => {
  /*
   * A regra inteira em uma linha. "Default" não é um nome ruim, é a AUSÊNCIA de nome vestida de
   * nome: passa por qualquer validação, aparece igual em toda linha da lista, e some no meio de
   * outros vinte iguais exatamente quando alguém precisa achar um.
   *
   * O cadastro é lido do código-fonte porque o caminho que o cria depende de OAuth e sessão, e o
   * que precisa ser garantido é que a string literal não voltou.
   */
  const auth = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.ok(!/INSERT INTO workspaces[^;]*'Default'/.test(auth),
    'o cadastro voltou a criar workspace chamado "Default"');

  assert.equal(db.prepare("SELECT COUNT(*) n FROM workspaces WHERE name = 'Default'").get().n, 0,
    'a migração precisa ter renomeado todos');
});

test('o nome fantasia vira o nome do tenant, sozinho', async () => {
  const r = await save({ billing_trade_name: 'Padaria do Zé', billing_legal_name: 'Zé Comércio de Alimentos LTDA' });

  assert.equal(r.status, 200);
  assert.equal(r.json.renamed, 'Padaria do Zé');
  assert.equal(nameOf(), 'Padaria do Zé');
});

test('a razão social é a reserva, não a primeira escolha', async () => {
  /*
   * "Zé Comércio de Alimentos LTDA" pertence à nota fiscal. Na barra lateral de alguém, todo dia,
   * pelos próximos cinco anos, não — por isso o nome fantasia manda quando existe.
   */
  await save({ billing_trade_name: '', billing_legal_name: 'Zé Comércio de Alimentos LTDA' });
  assert.equal(nameOf(), 'Zé Comércio de Alimentos LTDA');

  await save({ billing_trade_name: 'Padaria do Zé' });
  assert.equal(nameOf(), 'Padaria do Zé', 'preencher o fantasia depois retoma o comando');
});

test('salvar sem mudar o nome não renomeia nada', async () => {
  /*
   * Uma linha de auditoria por telefone corrigido transforma o log num lugar onde ninguém acha
   * nada — e o aviso "sua conta agora se chama X" para um X que não mudou é o tipo de coisa que
   * faz o cliente ligar perguntando o que aconteceu.
   */
  const r = await save({ billing_phone: '1140028922' });
  assert.equal(r.json.renamed, null);
  assert.equal(nameOf(), 'Padaria do Zé');
});

test('SOBRESCREVE um nome escolhido pelo cliente — a decisão, escrita', async () => {
  /*
   * Isto não é efeito colateral, é o pedido. A alternativa — nunca sobrescrever — foi levantada e
   * recusada: encontrar o cliente no suporte venceu.
   *
   * Deixado como teste, e não só como comentário, porque é a linha que alguém vai querer mudar um
   * dia depois de um cliente reclamar. Quando esse dia chegar, isto falha e força a conversa em
   * vez de deixar o comportamento virar acidente.
   */
  db.prepare("UPDATE workspaces SET name = 'Loja Centro' WHERE id = 'ws-name'").run();

  await save({ billing_trade_name: 'Padaria do Zé' });
  assert.equal(nameOf(), 'Padaria do Zé', 'o nome da empresa manda, mesmo sobre um escolhido a dedo');
});

test('a troca fica no log de atividade, com o nome antigo', () => {
  /*
   * Um cliente que liga dizendo "minha conta mudou de nome sozinha" precisa de uma resposta, e a
   * resposta é quem salvou o quê e quando.
   */
  const row = db.prepare(
    "SELECT details FROM activity_log WHERE action = 'workspace_renamed_from_company' ORDER BY id DESC LIMIT 1"
  ).get();

  assert.ok(row, 'a renomeação automática tem de deixar rastro');
  assert.match(row.details, /Loja Centro -> Padaria do Zé/);
});
