'use strict';

/*
 * A PORTA POR ONDE A GESTAO ENTRA -- e so ela.
 *
 * O espelho exato do que a Gestao ja faz com o token que emitimos para ela: mesmo segredo
 * compartilhado, sentido invertido. Ela assina com audience 'operacao' e issuer 'gestao';
 * nos assinamos com audience 'gestao' e issuer 'operacao'. Um token de um lado nao serve no
 * outro nem por engano, porque a audiencia nao bate.
 *
 * NAO E UMA SESSAO DE USUARIO. Ninguem chega aqui pelo navegador: quem chega e a API da
 * Gestao perguntando por um cliente dela. Por isso este porteiro nao monta req.user nem
 * resolve workspace -- ele so responde "de qual organizacao voce quer falar", e o que a
 * rota devolve fica confinado a ela.
 *
 * SEGREDO VAZIO RECUSA. Um segredo em branco faria a verificacao passar para qualquer
 * token forjado, o que e pior que nao ter a rota.
 */

const jwt = require('jsonwebtoken');
const config = require('../config');

function federationGate(req, res, next) {
  if (!config.federationSecret) {
    return res.status(503).json({ error: 'Federacao desligada neste servidor', code: 'FEDERATION_DISABLED' });
  }

  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token ausente' });
  }

  let claims;
  try {
    claims = jwt.verify(auth.slice(7), config.federationSecret, {
      algorithms: ['HS256'],
      audience: 'operacao',
      issuer: 'gestao',
    });
  } catch (e) {
    return res.status(401).json({ error: 'Token invalido ou expirado' });
  }

  if (!claims.organizationId) {
    return res.status(400).json({ error: 'Token sem organizacao' });
  }

  req.federationOrgId = claims.organizationId;
  next();
}

module.exports = { federationGate };
