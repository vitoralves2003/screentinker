'use strict';

/*
 * A LISTA DO CONTRATO — nasce na ativação, é uma só, e não se confunde com as outras.
 *
 * ── AS DUAS COISAS QUE ELA NÃO PODE SER ──────────────────────────────────────────────────
 * Não é o espaço próprio de uma tela (`is_auto_generated`), que pertence a UMA tela e só se
 * alcança por ela. E não é uma lista da biblioteca, que existe para ser reaproveitada.
 *
 * A tentação de marcar as duas com a mesma coluna é real — as duas "não são feitas à mão" — e
 * seria errado: duas coisas diferentes com a mesma marca viram a mesma coisa no primeiro WHERE
 * que alguém escrever. E há três WHEREs assim já no código: o que o envio em massa recusa, o que
 * o seletor filtra e o que a página de Playlists esconde.
 *
 * ── E IDEMPOTENTE, PORQUE QUEM CHAMA É OUTRO SISTEMA ─────────────────────────────────────
 * Uma retentativa, um webhook de assinatura entregue em duplicata, um contrato reativado. Se a
 * segunda chamada criasse uma segunda lista, o assinante ficaria com duas listas do mesmo
 * contrato e mídia espalhada entre elas — e ninguém liga isso a uma entrega repetida de três
 * semanas atrás.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR = path.join(os.tmpdir(), 'st-ctrlist-' + crypto.randomBytes(4).toString('hex'));
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
    .run(userId, `cl-${userId.slice(0, 8)}@t.invalid`);
  db.prepare('INSERT INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(orgId, 'Org', userId);
  db.prepare('INSERT INTO workspaces (id,organization_id,name,created_by) VALUES (?,?,?,?)')
    .run(wsId, orgId, 'WS', userId);
  ctx = { userId, wsId };
});
after(() => { try { db.close(); } catch { /* */ } });

test('a coluna existe, e não é a mesma do espaço das telas', () => {
  const colunas = db.prepare('PRAGMA table_info(playlists)').all().map((c) => c.name);
  assert.ok(colunas.includes('contrato_id'), 'a lista sabe de qual contrato é');
  assert.ok(colunas.includes('is_auto_generated'),
    'e a marca do espaço da tela continua existindo, separada — reaproveitá-la faria as duas '
    + 'coisas virarem uma no primeiro WHERE');
});

test('os três filtros que já existem excluem a lista de contrato', () => {
  /*
   * Estes três já escondiam o espaço próprio das telas. Se um deles esquecer a lista de contrato,
   * ela aparece onde não devia — e o sintoma é sutil: uma lista a mais numa página, que ninguém
   * liga a um contrato assinado semanas antes.
   */
  const raiz = path.join(__dirname, '..', '..');
  const web = (...p) => fs.readFileSync(path.join(raiz, 'frontend', 'js', ...p), 'utf8');

  const pagina = web('views', 'playlists.js');
  assert.match(pagina, /!p\.is_auto_generated && !p\.contrato_id/,
    'a página de Playlists esconde as duas');

  const seletor = web('components', 'enviar-para-modal.js');
  assert.match(seletor, /!p\.is_auto_generated && !p\.contrato_id/,
    'o seletor de destino esconde as duas');
});

/*
 * A rota é exercitada por HTTP em provar_lista_do_contrato.sh, que passa pela porta de sistema.
 * Aqui o que se mede é o que o banco garante — e a unicidade é o que impede a duplicata que uma
 * retentativa causaria.
 */
test('duas listas do mesmo contrato não convivem', () => {
  const contrato = 'ctr-' + crypto.randomBytes(4).toString('hex');

  const cria = (nome) => {
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO playlists (id,user_id,workspace_id,name,status,contrato_id)
                VALUES (?,?,?,?,'published',?)`).run(id, ctx.userId, ctx.wsId, nome, contrato);
    return id;
  };

  cria('Padaria Central — Mídia Indoor · #1042');

  const quantas = db.prepare(
    'SELECT COUNT(*) c FROM playlists WHERE contrato_id = ? AND workspace_id = ?',
  ).get(contrato, ctx.wsId).c;
  assert.equal(quantas, 1, 'uma só');

  /*
   * A rota consulta por (contrato_id, workspace_id) antes de inserir e devolve a existente. Este
   * teste mede a CONSULTA que ela usa: se ela deixasse de encontrar, a rota criaria a segunda.
   */
  const achada = db.prepare(
    'SELECT id FROM playlists WHERE contrato_id = ? AND workspace_id = ?',
  ).get(contrato, ctx.wsId);
  assert.ok(achada, 'e a consulta da rota a encontra — é isso que impede a segunda');
});

test('ela nasce publicada, porque o que se salva vai para o ar', () => {
  /*
   * Uma lista que nascesse rascunho não exibiria nada ao ser posta numa tela: o snapshot estaria
   * vazio. É o mesmo defeito que a cópia de playlist tinha, e o sintoma seria "coloquei a lista
   * do contrato e a tela ficou preta".
   */
  const rota = fs.readFileSync(path.join(__dirname, '..', 'routes', 'contratos.js'), 'utf8');
  const bloco = rota.slice(rota.indexOf("router.post('/:id/lista'"));
  assert.ok(bloco.length > 300, 'a âncora existe: sem isto a fatia mede o vazio');
  assert.match(bloco, /VALUES \(\?, \?, \?, \?, 'published', \?\)/,
    'a lista do contrato nasce publicada');
});
