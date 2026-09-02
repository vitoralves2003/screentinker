'use strict';

/*
 * O ESPELHO DE IDENTIDADE responde o que o /dashboard da casa nova pergunta (02/09).
 *
 * dashboardSocket.js decidia salas e permissões perguntando a lib/tenancy a cada conexão.
 * A casa nova não tem este SQLite, então a pergunta é respondida AQUI, pela mesma lib, e
 * viaja no retrato. Este teste guarda a forma do retrato e três respostas que, erradas,
 * não dariam erro: o membro entra só na sua workspace com o papel dela; o dono da
 * organização entra em todas as da organização como acting_as; a plataforma entra em
 * todas. E o porteiro: sem o claim de escopo, 403 — mesmo com o segredo certo.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');

const DATA_DIR = path.join(os.tmpdir(), 'st-espelho-' + crypto.randomBytes(4).toString('hex'));
process.env.DATA_DIR = DATA_DIR;
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'segredo-do-espelho-em-teste';
fs.mkdirSync(path.join(DATA_DIR, 'db'), { recursive: true });

const jwt = require('jsonwebtoken');
const express = require('express');
const { db } = require('../db/database');
const config = require('../config');
const { espelhoAuth } = require('../middleware/espelho');

let servidor; let porta;
const ids = {};

before(async () => {
  for (const k of ['membro', 'dono', 'staff', 'wsA', 'wsB', 'wsOutra', 'org', 'orgOutra']) ids[k] = crypto.randomUUID();
  db.prepare("INSERT INTO users (id,email,password_hash,role) VALUES (?,?,'x','user')").run(ids.membro, 'membro@t.invalid');
  db.prepare("INSERT INTO users (id,email,password_hash,role,must_change_password) VALUES (?,?,'x','user',1)").run(ids.dono, 'dono@t.invalid');
  db.prepare("INSERT INTO users (id,email,password_hash,role) VALUES (?,?,'x','platform_admin')").run(ids.staff, 'staff@t.invalid');
  db.prepare('INSERT INTO organizations (id,name,owner_user_id,widget_sandbox_isolation_disabled) VALUES (?,?,?,1)').run(ids.org, 'Org', ids.dono);
  db.prepare('INSERT INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(ids.orgOutra, 'Outra', ids.staff);
  db.prepare("INSERT INTO workspaces (id,organization_id,name,created_by,subscription_status) VALUES (?,?,?,?,'cut')").run(ids.wsA, ids.org, 'A', ids.dono);
  db.prepare('INSERT INTO workspaces (id,organization_id,name,created_by) VALUES (?,?,?,?)').run(ids.wsB, ids.org, 'B', ids.dono);
  db.prepare('INSERT INTO workspaces (id,organization_id,name,created_by) VALUES (?,?,?,?)').run(ids.wsOutra, ids.orgOutra, 'Outra', ids.staff);
  db.prepare("INSERT INTO organization_members (organization_id,user_id,role) VALUES (?,?,'org_owner')").run(ids.org, ids.dono);
  db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,'workspace_editor')").run(ids.wsA, ids.membro);

  const app = express();
  app.use('/api/sistema/espelho-identidade', espelhoAuth, require('../routes/espelho-identidade'));
  servidor = http.createServer(app);
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  porta = servidor.address().port;
});
after(async () => {
  await new Promise((r) => servidor.close(r));
  try { db.close(); } catch { /* */ }
});

function pedir(token) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: porta, path: '/api/sistema/espelho-identidade', headers: { Authorization: 'Bearer ' + token } }, (res) => {
      let corpo = '';
      res.on('data', (c) => { corpo += c; });
      res.on('end', () => resolve({ status: res.statusCode, corpo: corpo ? JSON.parse(corpo) : null }));
    }).on('error', reject);
  });
}

const tokenDeSistema = (claims) => jwt.sign(claims, config.jwtSecret, { algorithm: 'HS256', expiresIn: 120 });

test('sem o escopo do espelho, o porteiro recusa mesmo com o segredo certo', async () => {
  const r = await pedir(tokenDeSistema({ sistema: 'gestao', escopo: 'contratos' }));
  assert.equal(r.status, 403);
});

test('o retrato traz acessos, bloqueio de senha e a isolação do sandbox por workspace', async () => {
  const r = await pedir(tokenDeSistema({ sistema: 'gestao', escopo: 'espelho-identidade' }));
  assert.equal(r.status, 200);
  const { workspaces, usuarios } = r.corpo;

  const wsA = workspaces.find((w) => w.id === ids.wsA);
  assert.equal(wsA.subscription_status, 'cut');
  assert.equal(wsA.widget_sandbox_isolation_disabled, 1, 'a flag vem da organização');
  assert.equal(workspaces.find((w) => w.id === ids.wsOutra).widget_sandbox_isolation_disabled, 0);

  const membro = usuarios.find((u) => u.id === ids.membro);
  assert.deepEqual(membro.acessos, [{ workspace_id: ids.wsA, workspace_role: 'workspace_editor', acting_as: false }]);
  assert.equal(membro.must_change_password, 0);

  const dono = usuarios.find((u) => u.id === ids.dono);
  assert.equal(dono.must_change_password, 1);
  assert.deepEqual(
    dono.acessos.map((a) => a.workspace_id).sort(),
    [ids.wsA, ids.wsB].sort(),
    'o dono da organização entra nas duas dela e em nenhuma outra',
  );
  assert.ok(dono.acessos.every((a) => a.acting_as === true && a.workspace_role === null));

  const staff = usuarios.find((u) => u.id === ids.staff);
  assert.equal(staff.role, 'platform_admin');
  assert.ok(staff.acessos.some((a) => a.workspace_id === ids.wsOutra && a.acting_as));
  assert.ok(staff.acessos.some((a) => a.workspace_id === ids.wsA && a.acting_as));
});
