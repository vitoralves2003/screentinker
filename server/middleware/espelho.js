'use strict';

/*
 * O PORTEIRO DO ESPELHO DE IDENTIDADE — irmão do sistemaAuth, com uma diferença que é o
 * motivo de ele existir: o espelho é um retrato de PLATAFORMA (todas as workspaces, todos
 * os papéis), e o sistemaAuth exige organização e escopa a ela — a forma certa para a
 * régua, a errada para isto. Um porteiro próprio deixa o escopo explícito no claim em vez
 * de abrir exceção dentro do outro.
 *
 * Mesmo segredo compartilhado, mesma validade curta (um token esquecido num log vaza já
 * vencido), e o claim `escopo` tem de dizer exatamente para que o token foi cunhado.
 */
const jwt = require('jsonwebtoken');
const config = require('../config');

const VALIDADE_MAXIMA_SEG = 300;

function espelhoAuth(req, res, next) {
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

  if (claims.sistema !== 'gestao' || claims.escopo !== 'espelho-identidade') {
    return res.status(403).json({ error: 'Este endereço é do espelho de identidade.' });
  }

  const vida = (claims.exp || 0) - (claims.iat || 0);
  if (!vida || vida > VALIDADE_MAXIMA_SEG) {
    return res.status(403).json({ error: 'Token de sistema com validade fora do limite.' });
  }

  next();
}

module.exports = { espelhoAuth };
