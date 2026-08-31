const jwt = require('jsonwebtoken');
const config = require('../config');
const { db } = require('../db/database');

/*
 * A PORTA DE SISTEMA — para o único caso em que não há navegador.
 *
 * ── POR QUE ELA EXISTE, DEPOIS DE APAGARMOS A FEDERAÇÃO ──────────────────────────────────
 * A Etapa 1 apagou uma superfície federada inteira, e estava certa: aquele túnel existia por
 * uma frase que deixou de ser verdade ("origens diferentes não compartilham sessão"), e desde a
 * Fase B o navegador da Gestão alcança esta API direto, com a sessão que já tem.
 *
 * Isto NÃO é aquele túnel voltando. A régua de cobrança roda num cron, às 8h, sem ninguém
 * logado — e um cron não tem navegador. Não existe terceira saída: ou a Gestão fala com a
 * Operação de servidor para servidor, ou a suspensão automática só chega quando alguém abrir
 * uma tela, o que para dinheiro é tarde demais e imprevisível.
 *
 * Então é uma porta, e uma só, com o menor tamanho possível:
 *
 *   monta em /api/sistema/*     e em lugar nenhum mais, para a superfície inteira ser legível
 *                               num grep só
 *   não toca requireAuth        nem resolveTenancy. Mexer nos dois porteiros que todo o resto
 *                               usa, para atender um caso, é onde um erro fica caro
 *   não tem pessoa              `req.sistema` no lugar de `req.user`, porque não há a quem
 *                               atribuir — e inventar um usuário para o cron deixaria o
 *                               registro de atividade mentindo todo dia às 8h
 *
 * ── O SEGREDO JÁ EXISTE ──────────────────────────────────────────────────────────────────
 * A Gestão guarda `OPERACAO_JWT_SECRET` — o mesmo valor, byte a byte, com que esta API assina
 * as sessões dela — para poder VERIFICAR os tokens que chegam do navegador. Assinar com ele é
 * o primeiro uso de escrita de uma chave que já estava nas duas casas: nada de segredo novo
 * para gerar, distribuir e esquecer de rodar.
 *
 * ── E UM TOKEN DE SISTEMA NÃO ABRE AS PORTAS DE GENTE ────────────────────────────────────
 * Ele não tem `sub` de um usuário real, então `resolveSessionUser` o recusa com user_not_found
 * nas rotas normais. Isso é uma propriedade do desenho e não uma feliz coincidência — por isso
 * a prova bate numa rota comum com o token de sistema e exige o 401.
 */

// Um token de sistema vale para uma chamada, não para um turno de trabalho. Se vazar de um log,
// vaza já vencido.
const VALIDADE_MAXIMA_SEG = 300;

function sistemaAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  let claims;
  try {
    claims = jwt.verify(header.slice(7), config.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  /*
   * A MARCA É EXPLÍCITA, e não deduzida da ausência de outra coisa.
   *
   * Aceitar "qualquer token sem usuário" abriria esta porta para todo token malformado que um
   * dia passe a existir. O que entra aqui teve de dizer que é sistema, de propósito.
   */
  if (claims.sistema !== 'gestao') {
    return res.status(403).json({ error: 'Este endereço é da ponte de sistema.' });
  }

  // Uma validade longa transformaria um token esquecido num log em chave permanente.
  const vida = (claims.exp || 0) - (claims.iat || 0);
  if (!vida || vida > VALIDADE_MAXIMA_SEG) {
    return res.status(403).json({ error: 'Token de sistema com validade fora do limite.' });
  }

  if (!claims.organization_id) {
    return res.status(400).json({ error: 'Token de sistema sem organização.' });
  }

  /*
   * O WORKSPACE VEM DA ORGANIZAÇÃO, e não do token.
   *
   * Deixar o chamador dizer em qual workspace escrever seria deixá-lo escolher — e o id de um
   * contrato de um cliente pararia a mídia de outro. Aqui a organização é a única coisa que ele
   * afirma, e o alcance dela é decidido deste lado.
   */
  const ws = db.prepare(
    'SELECT id FROM workspaces WHERE organization_id = ? ORDER BY created_at LIMIT 1',
  ).get(claims.organization_id);

  if (!ws) return res.status(404).json({ error: 'Organização sem workspace nesta Operação.' });

  req.sistema = { origem: 'gestao', organizationId: claims.organization_id };
  req.workspaceId = ws.id;
  next();
}

module.exports = { sistemaAuth, VALIDADE_MAXIMA_SEG };
