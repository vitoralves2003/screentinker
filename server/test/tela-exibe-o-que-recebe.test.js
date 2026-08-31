'use strict';

/*
 * O QUE VOCÊ PÕE NA TELA, A TELA EXIBE — sem passo obrigatório no meio.
 *
 * ── O DEFEITO QUE ISTO FECHA ─────────────────────────────────────────────────────────────
 * A Etapa 5 moveu "o que esta tela exibe" para a aba Conteúdos e deixou o aviso de "alterações
 * não publicadas" na aba Configurações. O resultado, medido antes do conserto:
 *
 *     POST /assignments/device/:id  →  201
 *     o item entra na lista          →  sim
 *     a lista vira 'draft'           →  sim
 *     o published_snapshot muda      →  NÃO
 *
 * O player lê `published_snapshot`. Então a pessoa punha um arquivo na tela, via o arquivo na
 * lista, e a parede não mudava — com o aviso que explicaria isso uma aba de distância.
 *
 * ── E POR QUE PUBLICAR EM VEZ DE MOVER O AVISO ───────────────────────────────────────────
 * O par rascunho/publicado existe para editar uma lista COMPARTILHADA sem mexer nas telas que a
 * rodam no meio da edição. O espaço próprio de uma tela não tem essa necessidade — e a Etapa 5
 * existiu justamente para a tela deixar de ter passo obrigatório.
 *
 * O segundo teste é o que impede o conserto de ir longe demais: a lista compartilhada TEM de
 * continuar com rascunho, senão editar uma lista de contrato passaria a mexer, a cada tecla, em
 * todas as telas que a rodam.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR = path.join(os.tmpdir(), 'st-exibe-' + crypto.randomBytes(4).toString('hex'));
process.env.DATA_DIR = DATA_DIR;
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';
fs.mkdirSync(path.join(DATA_DIR, 'db'), { recursive: true });

const { db } = require('../db/database');

let ctx;

before(() => {
  const userId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const wsId = crypto.randomUUID();
  db.prepare("INSERT INTO users (id,email,password_hash,role) VALUES (?,?,'x','user')")
    .run(userId, `ex-${userId.slice(0, 8)}@t.invalid`);
  db.prepare('INSERT INTO organizations (id,name,owner_user_id) VALUES (?,?,?)')
    .run(orgId, 'Org', userId);
  db.prepare('INSERT INTO workspaces (id,organization_id,name,created_by) VALUES (?,?,?,?)')
    .run(wsId, orgId, 'WS', userId);
  ctx = { userId, wsId };
});
after(() => { try { db.close(); } catch { /* */ } });

function arquivo() {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type,duration_sec)
              VALUES (?,?,?,'a.png','/tmp/a.png','image/png',10)`).run(id, ctx.userId, ctx.wsId);
  return id;
}

function lista({ auto }) {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name,status,is_auto_generated) VALUES (?,?,?,'L','published',?)")
    .run(id, ctx.userId, ctx.wsId, auto ? 1 : 0);
  return id;
}

function noSnapshot(playlistId) {
  const p = db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(playlistId);
  try { return JSON.parse(p.published_snapshot || '[]').map((i) => i.content_id).filter(Boolean); }
  catch { return []; }
}

/*
 * Chama a função que os cinco caminhos de escrita usam, e não a rota inteira. É onde a decisão
 * mora — e uma rota exigiria sessão, workspace e permissão, que não são o que está em dúvida.
 */
function aplicar(playlistId) {
  // A FUNCAO de verdade, e nao uma copia dela: reimplementar a regra aqui provaria a copia.
  require("../routes/assignments").__test.aplicarNaTela(playlistId, null);
}

test('o espaço próprio da tela exibe o que recebe, na hora', () => {
  const espaco = lista({ auto: true });
  const a = arquivo();
  db.prepare('INSERT INTO playlist_items (playlist_id,content_id,sort_order,duration_sec) VALUES (?,?,0,10)')
    .run(espaco, a);

  aplicar(espaco);

  assert.deepEqual(noSnapshot(espaco), [a],
    'o arquivo precisa chegar ao snapshot que o player lê — antes disto ele ficava no banco e a '
    + 'parede não mudava, com o aviso numa aba que ninguém abriu');
  const st = db.prepare('SELECT status FROM playlists WHERE id = ?').get(espaco).status;
  assert.equal(st, 'published', 'e a tela não fica com um rascunho pendente de um passo que ela não tem');
});

test('mas a lista COMPARTILHADA continua com rascunho', () => {
  /*
   * O contrapeso. Sem ele o conserto iria longe demais: editar uma lista de contrato passaria a
   * mexer, a cada mudança, em todas as telas que a rodam — que é exatamente o que o par
   * rascunho/publicado existe para impedir.
   */
  const compartilhada = lista({ auto: false });
  const a = arquivo();
  db.prepare('INSERT INTO playlist_items (playlist_id,content_id,sort_order,duration_sec) VALUES (?,?,0,10)')
    .run(compartilhada, a);

  aplicar(compartilhada);

  const st = db.prepare('SELECT status FROM playlists WHERE id = ?').get(compartilhada).status;
  assert.equal(st, 'draft', 'uma lista que várias telas rodam não pode publicar a cada tecla');
  assert.deepEqual(noSnapshot(compartilhada), [],
    'e nada chegou às telas antes de alguém publicar');
});

test('a decisão mora numa função só, e ela pergunta pelo tipo da lista', () => {
  /*
   * SEIS caminhos de escrita chamam esta função: pôr item, editar, tirar, limpar, copiar para outra
   * tela, e o envio em massa. Se alguém acrescentar um sétimo e marcar rascunho à mão, ele nascerá
   * com o defeito que este teste fecha. E o número exato é PROPOSITAL, não fragilidade: ele obriga
   * quem acrescentar um caminho a conferir se passou por aqui — foi assim que pegou o envio em massa.
   */
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'routes', 'assignments.js'), 'utf8');
  assert.match(fonte, /function aplicarNaTela\(playlistId, req\)/,
    'a decisão continua numa função só');
  assert.doesNotMatch(fonte, /\bmarkDraft\s*\(/,
    'nenhum caminho marca rascunho por fora dela');
  const chamadas = (fonte.match(/aplicarNaTela\(/g) || []).length - 1; // menos a declaração
  assert.equal(chamadas, 6, `os seis caminhos de escrita passam por ela (achei ${chamadas})`);
});
