'use strict';

/*
 * "MOSTRE TUDO DESTE CONTRATO" — o filtro, e o elo que promete usá-lo.
 *
 * ── A CLASSE DE DEFEITO QUE ESTE ARQUIVO PERSEGUE ────────────────────────────────────────
 * Um elo que diz "as mídias deste contrato" e entrega a biblioteca inteira não dá erro nenhum:
 * a tela abre, os arquivos aparecem, e quem clicou conclui que o filtro não existe — ou pior,
 * que o sistema perdeu os arquivos do contrato. É o mesmo formato da aba Playlists vazia, e o
 * único jeito de pegá-lo é medir as TRÊS peças juntas: a rota filtra, o cliente manda, a tela lê.
 *
 * Qualquer uma sozinha deixa as outras duas verdes e o elo decorativo.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR = path.join(os.tmpdir(), 'st-midiasctr-' + crypto.randomBytes(4).toString('hex'));
process.env.DATA_DIR = DATA_DIR;
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';
fs.mkdirSync(path.join(DATA_DIR, 'db'), { recursive: true });

const { db } = require('../db/database');

const RAIZ = path.join(__dirname, '..', '..');
const web = (...p) => fs.readFileSync(path.join(RAIZ, 'frontend', 'js', ...p), 'utf8');

let ctx;

before(() => {
  const userId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const wsId = crypto.randomUUID();
  db.prepare("INSERT INTO users (id,email,password_hash,role) VALUES (?,?,'x','user')")
    .run(userId, `md-${userId.slice(0, 8)}@t.invalid`);
  db.prepare('INSERT INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(orgId, 'Org', userId);
  db.prepare('INSERT INTO workspaces (id,organization_id,name,created_by) VALUES (?,?,?,?)')
    .run(wsId, orgId, 'WS', userId);
  ctx = { userId, wsId };
});
after(() => { try { db.close(); } catch { /* */ } });

/*
 * A CONSULTA QUE A ROTA MONTA, medida contra dados de verdade. Não é o handler HTTP — esse tem
 * prova de shell —, é a cláusula: se ela não separar por contrato, tudo o mais é enfeite.
 */
test('a consulta separa os arquivos por contrato', () => {
  const cria = (nome, contrato) => {
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type,contrato_id)
                VALUES (?,?,?,?,?,?,?)`)
      .run(id, ctx.userId, ctx.wsId, nome, '/tmp/' + nome, 'image/png', contrato);
    return id;
  };

  cria('do-contrato-a.png', 'ctr-A');
  cria('tambem-do-a.png', 'ctr-A');
  cria('do-contrato-b.png', 'ctr-B');
  cria('de-ninguem.png', null);

  const doA = db.prepare(
    'SELECT filename FROM content WHERE workspace_id = ? AND contrato_id = ? ORDER BY filename',
  ).all(ctx.wsId, 'ctr-A').map((r) => r.filename);

  assert.deepEqual(doA, ['do-contrato-a.png', 'tambem-do-a.png']);

  /*
   * E o arquivo SEM contrato não pode cair em contrato nenhum. Num SQL, `contrato_id = ?` já
   * exclui NULL — mas isso é fácil de perder no dia em que alguém trocar por um LIKE ou por uma
   * comparação montada em JavaScript, e o sintoma seria mídia de ninguém contando contra o
   * limite de alguém.
   */
  const semContrato = db.prepare(
    'SELECT COUNT(*) c FROM content WHERE workspace_id = ? AND contrato_id = ?',
  ).get(ctx.wsId, 'ctr-A').c;
  assert.equal(semContrato, 2, 'o arquivo sem contrato não entra na conta de um contrato');
});

test('a rota aceita ?contrato_id= e o costura na cláusula', () => {
  const rota = fs.readFileSync(path.join(__dirname, '..', 'routes', 'content.js'), 'utf8');

  assert.match(rota, /req\.query\.contrato_id/,
    'a rota lê o parâmetro');
  assert.match(rota, /sql \+= ' AND contrato_id = \?'/,
    'e o transforma em cláusula — parametrizada, nunca interpolada');
});

/*
 * ── AS DUAS PONTAS DO ELO ────────────────────────────────────────────────────────────────
 * A aba Mídias manda para Arquivos com ?contrato=<id>. Se o cliente não repassar, ou se a tela
 * não ler a URL, o elo abre a biblioteca inteira e não avisa nada.
 */
test('o cliente da API repassa o contrato adiante', () => {
  const api = web('api.js');
  assert.match(api, /opts\.contratoId.*p\.set\('contrato_id'/s,
    'getContent manda contrato_id quando recebe contratoId');
});

test('a página de Arquivos lê o contrato da URL a cada abertura', () => {
  const pagina = web('views', 'content-library.js');

  assert.match(pagina, /searchParams|URLSearchParams/,
    'a tela olha a URL');
  assert.match(pagina, /get\('contrato'\)/,
    'e procura o parâmetro que a aba Mídias manda');

  /*
   * A cada ABERTURA, e não uma vez no arranque do módulo: quem volta para Arquivos sem o
   * parâmetro tem de ver a biblioteca inteira de novo. Um filtro que gruda é um acervo que
   * encolheu sem explicação.
   */
  const corpoDoRender = pagina.slice(pagina.indexOf('export function render(container) {'));
  assert.ok(corpoDoRender.length > 200, 'a âncora do render existe: sem isto a fatia mede o vazio');
  assert.match(corpoDoRender.slice(0, 300), /state\.contratoId = lerContratoDaUrl\(\)/,
    'a leitura acontece dentro do render, não no arranque do módulo');

  assert.match(pagina, /contratoId: state\.contratoId/,
    'e o filtro chega na consulta');
});

/*
 * ── UM FILTRO INVISÍVEL MENTE SOBRE O TAMANHO DO ACERVO ─────────────────────────────────
 * Sem a faixa, quem chega pelo elo vê três arquivos onde havia duzentos e conclui que o sistema
 * perdeu o resto. E o botão de saída precisa limpar a URL também: só o state deixaria o endereço
 * dizendo o contrário, e um F5 traria o filtro de volta sem explicação.
 */
test('a tela avisa que está filtrando, e oferece a saída', () => {
  const pagina = web('views', 'content-library.js');

  assert.match(pagina, /state\.contratoId \?/,
    'a faixa só aparece quando há filtro');
  assert.match(pagina, /limparFiltroContrato/,
    'e traz um botão de saída');
  assert.match(pagina, /searchParams\.delete\('contrato'\)/,
    'que limpa a URL, e não só o state');
});
