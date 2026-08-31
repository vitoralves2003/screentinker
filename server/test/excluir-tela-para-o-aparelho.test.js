'use strict';

/*
 * EXCLUIR A TELA PELO PAINEL TEM DE PARAR O APARELHO NA HORA.
 *
 * Regra do produto, dita pelo Vitor em 31/08/2026: "ao excluir a tela pelo painel, o certo é ele
 * parar de exibir seus conteúdos e gerar um novo código de pareamento (...) ele não pode
 * continuar rodando o que antes estava configurado nele".
 *
 * ── O QUE ACONTECIA ──────────────────────────────────────────────────────────────────────
 * A exclusão avisava o PAINEL (`dashboard:device-removed`) e nunca o aparelho. O box seguia
 * exibindo o conteúdo em cache até tentar reconectar sozinho — e só aí, ao descobrir que a linha
 * dele sumiu, recebia `device:unpaired` e se reprovisionava.
 *
 * Entre a exclusão e essa descoberta, uma tela que já não pertence a ninguém continua
 * anunciando: o conteúdo do cliente antigo, numa parede que o operador acabou de tirar do
 * sistema. Ninguém olhando para o painel tem como saber disso.
 *
 * ── POR QUE UM TESTE DE SOCKET, E NÃO UM DE ROTA ─────────────────────────────────────────
 * O que se quer garantir não é o que a rota RESPONDE — ela já respondia 200 com o defeito no
 * lugar. É o que chega no aparelho. A única forma honesta de medir isso é ter um cliente
 * conectado do outro lado, exatamente como o player fica.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const ioClient = require('../node_modules/socket.io-client');

const { freePort } = require('./helpers/free-port');
let PORT, BASE, proc, db;
const DATA_DIR = path.join(os.tmpdir(), 'st-exdel-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-exdel-' + crypto.randomBytes(4).toString('hex') + '.log');

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
});
after(() => {
  try { db && db.close(); } catch { /* */ }
  try { proc.kill('SIGKILL'); } catch { /* */ }
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * Uma conta, um workspace e uma tela pareada — o mínimo para a rota de exclusão aceitar a
 * chamada. Montado por SQL de propósito: o que está sob teste é a exclusão, e passar pelo
 * cadastro inteiro só acrescentaria formas de o teste falhar por outro motivo.
 */
function montarCenario() {
  const userId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const wsId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');

  // Senha de verdade: a sessao sai do LOGIN, e nao de um token forjado aqui. Forjar exigiria o
  // banco deste processo, que nao e o do servidor gerado -- e um token com claims incompletas
  // volta 401 sem dizer qual claim faltou.
  const bcrypt = require("bcryptjs");
  const email = `exdel-${userId.slice(0, 8)}@t.invalid`;
  const senha = "SenhaDaProva#2026";
  db.prepare("INSERT INTO users (id,email,password_hash,auth_provider,role) VALUES (?,?,?,'local','user')")
    .run(userId, email, bcrypt.hashSync(senha, 10));
  db.prepare('INSERT INTO organizations (id,name,owner_user_id) VALUES (?,?,?)')
    .run(orgId, 'Org da prova', userId);
  db.prepare('INSERT INTO organization_members (organization_id,user_id,role) VALUES (?,?,?)')
    .run(orgId, userId, 'org_owner');
  db.prepare('INSERT INTO workspaces (id,organization_id,name,created_by) VALUES (?,?,?,?)')
    .run(wsId, orgId, 'WS da prova', userId);
  db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)')
    .run(wsId, userId, 'workspace_admin');
  db.prepare(`INSERT INTO devices (id,workspace_id,user_id,name,status,device_token,created_at)
              VALUES (?,?,?,'Tela da prova','online',?,strftime('%s','now'))`)
    .run(deviceId, wsId, userId, token);

  return { userId, wsId, deviceId, token, email, senha };
}

function conectar(deviceId, token) {
  return new Promise((resolve, reject) => {
    const s = ioClient(BASE + '/device', { transports: ['websocket'], reconnection: false });
    s.on('connect', () => s.emit('device:register', { device_id: deviceId, device_token: token }));
    s.on('device:registered', () => resolve(s));
    s.on('device:auth-error', (e) => reject(new Error(e && e.error)));
    setTimeout(() => reject(new Error('register timeout')), 10000);
  });
}

test('excluir a tela avisa o aparelho NA HORA, sem esperar a próxima reconexão', async () => {
  const c = montarCenario();
  const s = await conectar(c.deviceId, c.token);

  const avisos = [];
  s.on('device:unpaired', (d) => avisos.push(d));

  await wait(300);
  assert.equal(avisos.length, 0, 'sanidade: nada de aviso antes da exclusão');

  /*
   * A exclusão pela ROTA, e não por SQL. Apagar a linha à mão provaria que o banco aceita um
   * DELETE, que nunca esteve em dúvida — o que está sob teste é o que a rota faz além disso.
   */
  const entrada = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: c.email, password: c.senha }),
  });
  const corpo = await entrada.json();
  assert.ok(corpo.token, `nao consegui entrar: ${JSON.stringify(corpo).slice(0, 200)}`);
  const sessao = corpo.token;

  const r = await fetch(`${BASE}/api/devices/${c.deviceId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${sessao}` },
  });
  assert.equal(r.status, 200, 'a exclusão respondeu 200');

  await wait(700);

  assert.equal(avisos.length, 1,
    'o aparelho precisa receber device:unpaired no instante da exclusão — sem isto ele segue '
    + 'exibindo o conteúdo em cache até tentar reconectar sozinho, e uma tela que já não é de '
    + 'ninguém continua anunciando');
  assert.equal(avisos[0].reason, 'deleted',
    'e o motivo diz o que aconteceu: replaced e not_found são outros caminhos');

  s.close();
});

test('e a linha realmente sumiu — o aviso não substitui a exclusão', async () => {
  // Um aviso sem a exclusão seria pior que nenhum dos dois: a tela pararia e voltaria na
  // reconexão seguinte, e ninguém entenderia por quê.
  const n = db.prepare("SELECT COUNT(*) c FROM devices WHERE name = 'Tela da prova'").get().c;
  assert.equal(n, 0, 'a tela foi removida do banco');
});
