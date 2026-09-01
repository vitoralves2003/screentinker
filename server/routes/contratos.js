/*
 * CONTRATO SUSPENSO PARA DE EXIBIR -- e voltar a exibir é desmarcar.
 *
 * ── AS DUAS INADIMPLÊNCIAS NÃO SE PARECEM ────────────────────────────────────────────────
 * O plano tratava como uma coisa o que são duas, e confundi-las custaria caro:
 *
 *   ASSINANTE não paga o Loop Player       dunningGate, que já existe
 *     suspended → painel bloqueado, AS TELAS SEGUEM EXIBINDO
 *     cut       → acesso interrompido
 *
 *   ANUNCIANTE não paga o assinante        é isto aqui
 *     para TODA MÍDIA daquele contrato, onde quer que ela esteja
 *     o assinante não é bloqueado em nada
 *
 * A primeira bloqueia escrita na API e nunca encosta na exibição. A segunda não bloqueia nada --
 * é uma marca no contrato, e a exibição pula quem aponta para ele.
 *
 * ── NADA É MOVIDO NEM APAGADO ────────────────────────────────────────────────────────────
 * O item continua na lista, o arquivo continua no servidor, a colocação continua onde estava.
 * Suspender insere uma linha; voltar a exibir apaga essa linha. Uma suspensão que apagasse itens
 * seria irreversível na prática -- ninguém reconstrói à mão onde cada mídia estava, em quantas
 * telas, em que ordem.
 *
 * ── E REPUBLICAR É PARTE DA SUSPENSÃO, NÃO UM DETALHE ────────────────────────────────────
 * O que a tela exibe é o `published_snapshot`, montado no momento da publicação. Marcar o
 * contrato sem republicar deixaria a marca certa no banco e a mídia no ar -- exatamente o
 * sintoma que esta rota existe para não ter. Por isso a marca e a republicação acontecem na
 * mesma chamada, e a resposta conta quantas listas foram refeitas.
 */
const express = require('express');
const { db } = require('../db/database');
const { v4: uuidv4 } = require('uuid');
const { gestaoRole } = require('../lib/permissions');

const router = express.Router();

/*
 * SUSPENDER É DINHEIRO, e dinheiro é fronteira de TITULAR.
 *
 * Mesmo critério das abas marcadas `titular: true` em routes/configuracoes.js: um OPERADOR
 * opera as telas, não decide quem para de veicular.
 */
function apenasTitular(req, res, next) {
  /*
   * OU A PONTE DE SISTEMA. A regua de cobranca roda num cron, sem ninguem logado, e nao ha
   * papel a conferir onde nao ha pessoa -- quem ja decidiu que aquele atraso suspende foi o
   * assinante, ao configurar a regua. O porteiro daquela porta (middleware/sistema.js) e quem
   * garante que o chamador e a Gestao e que o alcance dele e a organizacao dele.
   */
  if (req.sistema) return next();
  if (gestaoRole(req) === 'TITULAR') return next();
  return res.status(403).json({ error: 'Só o titular pode suspender ou liberar um contrato.' });
}

/*
 * Republica toda lista publicada que carrega mídia deste contrato.
 *
 * A busca é pelo ARQUIVO e não pela lista do contrato: um arquivo do contrato pode estar solto
 * numa tela, fora da lista dele, e é justamente esse o caso que a suspensão precisa alcançar.
 */
function republicarAfetadas(contratoId, workspaceId) {
  const listas = db.prepare(`
    SELECT DISTINCT p.id
      FROM playlists p
      JOIN playlist_items pi ON pi.playlist_id = p.id
      JOIN content c ON c.id = pi.content_id
     WHERE c.contrato_id = ?
       AND p.workspace_id = ?
       AND p.status = 'published'
  `).all(contratoId, workspaceId);

  // Exigido aqui dentro: routes/playlists.js requer este arquivo de volta em outras rotas, e
  // pedi-lo no topo fecharia o ciclo.
  const { publishPlaylist } = require('./playlists');
  for (const l of listas) publishPlaylist(l.id, null);
  return listas.length;
}

// Quais contratos estão suspensos neste cliente. Existe para a Gestão poder conferir o que a
// Operação de fato aplicou, em vez de supor que a última escrita chegou.
router.get('/suspensos', (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  res.json(db.prepare(
    'SELECT contrato_id, motivo, suspenso_em FROM contratos_suspensos WHERE workspace_id = ? ORDER BY suspenso_em DESC',
  ).all(req.workspaceId));
});

router.post('/:id/suspender', apenasTitular, (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });

  const motivo = typeof req.body?.motivo === 'string' ? req.body.motivo.slice(0, 500) : null;

  /*
   * INSERT OR REPLACE: suspender duas vezes é a mesma coisa que suspender uma.
   *
   * Quem chama é o outro sistema, e um sistema repete -- uma retentativa, um webhook entregue
   * em duplicata, alguém clicando de novo porque a primeira demorou. Se a repetição desse erro,
   * a segunda tentativa pareceria falha e a suspensão pareceria não ter valido.
   */
  db.prepare(`
    INSERT OR REPLACE INTO contratos_suspensos (contrato_id, workspace_id, motivo, suspenso_em)
    VALUES (?, ?, ?, strftime('%s','now'))
  `).run(req.params.id, req.workspaceId, motivo);

  const listas = republicarAfetadas(req.params.id, req.workspaceId);
  res.json({ contrato_id: req.params.id, suspenso: true, listas_republicadas: listas });
});

router.delete('/:id/suspender', apenasTitular, (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });

  const r = db.prepare('DELETE FROM contratos_suspensos WHERE contrato_id = ? AND workspace_id = ?')
    .run(req.params.id, req.workspaceId);

  /*
   * Republica MESMO quando não havia marca. Liberar um contrato que já estava liberado devolve
   * 200 e refaz as listas: é barato, e a alternativa -- responder "não havia nada" -- deixaria
   * um sistema que perdeu o fio sem como se recuperar. O estado final é o que importa.
   */
  const listas = republicarAfetadas(req.params.id, req.workspaceId);
  res.json({
    contrato_id: req.params.id,
    suspenso: false,
    estava_suspenso: r.changes > 0,
    listas_republicadas: listas,
  });
});


/*
 * A LISTA DO CONTRATO — criada na ativação, e uma só por contrato.
 *
 * ── IDEMPOTENTE, PORQUE QUEM CHAMA É OUTRO SISTEMA ──────────────────────────────────────
 * Um sistema repete: uma retentativa, um webhook de assinatura entregue em duplicata, um contrato
 * reativado. Se a segunda chamada criasse uma segunda lista, o assinante acabaria com duas listas
 * do mesmo contrato e mídia espalhada entre as duas — e ninguém liga isso a uma entrega repetida
 * de três semanas atrás.
 *
 * Então a resposta é sempre a lista DAQUELE contrato: cria se não existe, devolve se existe.
 *
 * ── O NOME É DE EMERGÊNCIA ──────────────────────────────────────────────────────────────
 * O rótulo que a tela mostra é montado na hora, do contrato — cliente, serviço e número — porque
 * um nome gravado envelhece no dia em que alguém renomeia o cliente. A coluna `name` existe
 * porque o esquema a exige, e guarda o que a Gestão mandou como último recurso: se um dia ela não
 * responder, é melhor ler "Padaria Central — Mídia Indoor" desatualizado do que um id cru.
 */
router.post('/:id/lista', apenasTitular, (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });

  const existente = db.prepare(
    'SELECT * FROM playlists WHERE contrato_id = ? AND workspace_id = ?',
  ).get(req.params.id, req.workspaceId);

  if (existente) return res.json({ ...existente, criada: false });

  /*
   * O DONO DA LINHA é quem chamou, quando há alguém; num token de sistema não há pessoa, e aí é
   * o dono do workspace. A coluna user_id é NOT NULL no esquema — e deixar isso implícito seria
   * deixar a criação falhar só no caminho do cron, que é o menos testado.
   */
  const dono = req.user?.id
    || db.prepare('SELECT created_by FROM workspaces WHERE id = ?').get(req.workspaceId)?.created_by;
  if (!dono) return res.status(500).json({ error: 'Workspace sem dono; não é possível criar a lista.' });

  const rotulo = typeof req.body?.rotulo === 'string' && req.body.rotulo.trim()
    ? req.body.rotulo.trim().slice(0, 200)
    : `Contrato ${req.params.id}`;

  const id = uuidv4();
  db.prepare(`
    INSERT INTO playlists (id, user_id, workspace_id, name, status, contrato_id)
    VALUES (?, ?, ?, ?, 'published', ?)
  `).run(id, dono, req.workspaceId, rotulo, req.params.id);

  /*
   * NASCE PUBLICADA, e vazia. Desde 31/08 o que se salva vai para o ar, e uma lista que nascesse
   * rascunho não exibiria nada ao ser posta numa tela — o mesmo defeito que a cópia de playlist
   * tinha, e o sintoma seria "coloquei a lista do contrato e a tela ficou preta".
   */
  const criada = db.prepare('SELECT * FROM playlists WHERE id = ?').get(id);
  res.status(201).json({ ...criada, criada: true });
});

/*
 * O LIMITE DE MÍDIAS, EMPURRADO PELA GESTÃO.
 *
 * PUT e não POST: é um estado espelhado, não um evento. O corpo descreve como o limite é
 * AGORA, e reenviar o mesmo corpo não muda nada — o que importa quando quem chama é um
 * sistema que repete.
 *
 * ── NULO É UM VALOR, E NÃO "NÃO MEXA" ──────────────────────────────────────────────────
 * `{ max_midias: null }` remove aquele limite. Se ausência significasse "deixe como está", um
 * limite removido na Gestão continuaria valendo aqui para sempre, e o assinante veria o
 * upload recusado por um número que ele já apagou.
 */
router.put('/:id/limites', apenasTitular, (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });

  const inteiroOuNulo = (v) => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  const maxMidias = inteiroOuNulo(req.body?.max_midias);
  const maxSegundos = inteiroOuNulo(req.body?.max_segundos);

  /*
   * SEM NENHUM DOS DOIS, a linha SAI em vez de ficar com dois nulos. Uma linha de zeros e
   * nulos é indistinguível de "ainda não sei", e a diferença importa no dia em que alguém
   * for depurar por que um contrato não tem limite.
   */
  if (maxMidias === null && maxSegundos === null) {
    db.prepare('DELETE FROM contratos_limites WHERE contrato_id = ? AND workspace_id = ?')
      .run(req.params.id, req.workspaceId);
    return res.json({ contrato_id: req.params.id, max_midias: null, max_segundos: null });
  }

  db.prepare(`
    INSERT INTO contratos_limites (contrato_id, workspace_id, max_midias, max_segundos)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(contrato_id) DO UPDATE SET
      workspace_id  = excluded.workspace_id,
      max_midias    = excluded.max_midias,
      max_segundos  = excluded.max_segundos,
      atualizado_em = strftime('%s','now')
  `).run(req.params.id, req.workspaceId, maxMidias, maxSegundos);

  res.json({ contrato_id: req.params.id, max_midias: maxMidias, max_segundos: maxSegundos });
});

/* O que a Operação está aplicando hoje — o espelho, para conferência dos dois lados. */
router.get('/limites', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  res.json(db.prepare(
    'SELECT contrato_id, max_midias, max_segundos FROM contratos_limites WHERE workspace_id = ?',
  ).all(req.workspaceId));
});

module.exports = router;
