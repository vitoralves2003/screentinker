'use strict';

/*
 * THE HUNDRED-AND-FIRST SCREEN.
 *
 * The fleet list paged at 100 and returned a bare array, so a workspace with 101 screens was
 * served 100 of them and told nothing — no total, no flag, no error. The missing screen was on no
 * page, in no filter, and in no count, and the only way to notice was to count rows by hand on
 * the page whose entire job is to list every screen.
 *
 * Nothing about that failure is visible from the inside. The request succeeds, the JSON is valid,
 * the page renders, and one shop's panel is simply absent from the system that manages it. This
 * fixture therefore has 137 devices: enough that a fix which merely raised the page size to 100
 * would still fail, and enough to cross the boundary more than once.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { db } = require('../db/database');

const FLEET = 137;
let server, base;

const get = async (qs = '') => {
  const res = await fetch(`${base}/devices${qs}`);
  return { status: res.status, headers: res.headers, json: await res.json() };
};

before(async () => {
  db.prepare("INSERT INTO users (id,email,password_hash,role) VALUES ('u-f','f@t','x','user')").run();
  db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('o-f','O','u-f')").run();
  db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('ws-f','o-f','Fleet')").run();
  db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('ws-other','o-f','Outro')").run();

  const ins = db.prepare("INSERT INTO devices (id,user_id,workspace_id,name,status) VALUES (?,?,?,?,'online')");
  for (let i = 1; i <= FLEET; i++) ins.run(`d${String(i).padStart(3, '0')}`, 'u-f', 'ws-f', `Tela ${i}`);

  // Uma tela ainda pareando — que ENTRA na lista e na conta, porque é isso que a página de telas
  // mostra — e uma de outro cliente, que não entra em nenhuma das duas.
  db.prepare("INSERT INTO devices (id,user_id,workspace_id,name,status) VALUES ('d-prov','u-f','ws-f','Pareando','provisioning')").run();
  db.prepare("INSERT INTO devices (id,user_id,workspace_id,name,status) VALUES ('d-other','u-f','ws-other','Do vizinho','online')").run();

  const app = express();
  app.use((req, _res, next) => { req.user = { id: 'u-f', role: 'user' }; req.workspaceId = 'ws-f'; next(); });
  app.use('/devices', require('../routes/devices'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

/* A frota como esta rota a define: tudo do workspace, inclusive a que ainda está pareando. */
const LISTED = FLEET + 1;

test('a resposta DIZ quantas telas existem, mesmo servindo menos', () => {
  return get().then((r) => {
    assert.equal(r.status, 200);
    assert.equal(r.json.length, 100, 'a página continua limitada, o que é correto');
    assert.equal(r.headers.get('x-total-count'), String(LISTED),
      'sem isto, quem chama não tem como saber que está olhando uma frota parcial');
  });
});

test('a contagem conta exatamente o que a lista lista', async () => {
  /*
   * A ARMADILHA QUE ISTO PEGOU. A primeira versão da contagem foi copiada do /overview, que exclui
   * telas em pareamento porque responde "tem algo caído". Aqui isso punha 137 no cabeçalho ao lado
   * de 138 linhas — um número brigando com a coisa que ele conta, que é pior do que o silêncio que
   * veio substituir.
   *
   * O vizinho continua de fora, e isso não é sobre paginação: é o isolamento entre clientes.
   */
  const r = await get('?limit=500');
  assert.equal(r.headers.get('x-total-count'), String(r.json.length),
    'cabeçalho e corpo têm de contar a mesma coisa');
  assert.ok(r.json.some((d) => d.id === 'd-prov'), 'a que está pareando aparece na lista');
  assert.ok(!r.json.some((d) => d.id === 'd-other'), 'a tela do vizinho não pode aparecer');
});

test('paginando até o fim, todas as 137 aparecem — e cada uma uma vez só', async () => {
  /*
   * O que o cliente faz agora. A dobra em offset também é o que pega um servidor que aceita o
   * parâmetro e o ignora: sem a checagem de página curta, o laço devolveria a mesma primeira
   * página várias vezes e o total ficaria certo com o conteúdo errado.
   */
  const seen = new Map();
  const PAGE = 500;
  for (let offset = 0; offset < 20000; offset += PAGE) {
    const r = await get(`?limit=${PAGE}&offset=${offset}`);
    if (!r.json.length) break;
    for (const d of r.json) seen.set(d.id, (seen.get(d.id) || 0) + 1);
    if (r.json.length < PAGE) break;
  }

  assert.equal(seen.size, LISTED, 'nenhuma tela pode ficar de fora');
  assert.ok([...seen.values()].every((n) => n === 1), 'nem aparecer duas vezes');
  assert.ok(seen.has('d137'), 'a última é justamente a que sumia');
  assert.ok(seen.has('d-prov'), 'inclusive a que ainda está pareando, que é o que a lista mostra');
});

test('páginas de 50 cobrem a frota sem buraco na emenda', async () => {
  /*
   * Um tamanho que NÃO divide 137 certinho. Erros de paginação por um se escondem quando o total
   * é múltiplo do tamanho da página: 137 e 50 deixam uma última página de 37, que é exatamente
   * onde uma conta trocada perde ou repete uma linha.
   */
  const ids = new Set();
  for (let offset = 0; offset < 300; offset += 50) {
    const r = await get(`?limit=50&offset=${offset}`);
    if (!r.json.length) break;
    r.json.forEach((d) => ids.add(d.id));
  }
  assert.equal(ids.size, LISTED);
});

test('um limit absurdo é limitado em vez de aceito', async () => {
  const r = await get('?limit=99999');
  assert.ok(r.json.length <= 500, 'o teto do servidor continua valendo — lista sem limite é outro perigo');
  assert.equal(r.json.length, LISTED, 'e abaixo do teto a frota inteira cabe numa página só');
});
