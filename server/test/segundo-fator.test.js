'use strict';

/*
 * O SEGUNDO FATOR POR CÓDIGO (06/09) — a mecânica que não depende de rede.
 *
 * O que fica travado aqui: o código vive só como hash; cinco erros esgotam; vencido não vale;
 * usado não vale de novo; o número brasileiro é normalizado de vários jeitos para um só; o
 * destino mascarado não entrega o número nem o e-mail; e o cookie de confiança só vale para
 * o mesmo usuário e dentro do prazo. A entrega (WhatsApp/e-mail) e a exigência por plano são
 * provadas contra o servidor de verdade em scripts/provas/segundo_fator.js.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-2fa-' + crypto.randomBytes(4).toString('hex'));

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { db } = require('../db/database');
const { hashToken } = require('../middleware/apiToken');
const sf = require('../lib/segundo-fator');

/* A tabela de códigos referencia users; aqui o assunto é o código, não o usuário. */
db.pragma('foreign_keys = OFF');

const agora = () => Math.floor(Date.now() / 1000);
function desafio({ codigo = '123456', expiraEm = agora() + 600, tentativas = 0, usado = null, finalidade = 'login', userId = 'u-prova' } = {}) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO codigos_de_acesso (id, user_id, finalidade, canal, destino, codigo_hash, expira_em, tentativas, usado_em, criado_em)
              VALUES (?, ?, ?, 'email', 'x@y.z', ?, ?, ?, ?, ?)`)
    .run(id, userId, finalidade, hashToken(codigo), expiraEm, tentativas, usado, agora());
  return id;
}

test('o código certo confere uma vez só', () => {
  const id = desafio();
  const r = sf.conferir(id, '12 34 56');
  assert.equal(r.ok, true);
  assert.equal(r.user_id, 'u-prova');
  assert.equal(sf.conferir(id, '123456').ok, false, 'usado não vale de novo');
});

test('cinco erros esgotam o desafio, e o certo depois disso não vale', () => {
  const id = desafio();
  const motivos = [];
  for (let i = 0; i < 5; i++) motivos.push(sf.conferir(id, '000000').motivo);
  assert.deepEqual(motivos, ['codigo_errado', 'codigo_errado', 'codigo_errado', 'codigo_errado', 'esgotado']);
  assert.equal(sf.conferir(id, '123456').motivo, 'esgotado');
});

test('vencido não vale; finalidade errada não vale; desafio inexistente não vale', () => {
  assert.equal(sf.conferir(desafio({ expiraEm: agora() - 1 }), '123456').motivo, 'expirado');
  assert.equal(sf.conferir(desafio({ finalidade: 'telefone' }), '123456', 'login').motivo, 'desafio_invalido');
  assert.equal(sf.conferir('nao-existe', '123456').motivo, 'desafio_invalido');
});

test('o número brasileiro vira 55 + DDD + número, de qualquer jeito que venha', () => {
  assert.equal(sf.normalizarTelefone('(27) 99999-1234'), '5527999991234');
  assert.equal(sf.normalizarTelefone('+55 27 99999 1234'), '5527999991234');
  assert.equal(sf.normalizarTelefone('5527999991234'), '5527999991234');
  assert.equal(sf.normalizarTelefone('27 3333-1234'), '552733331234', 'fixo com 8 dígitos');
  assert.equal(sf.normalizarTelefone('123'), null);
  assert.equal(sf.normalizarTelefone(''), null);
});

test('o destino mascarado não entrega o dado', () => {
  assert.equal(sf.mascarar('whatsapp', '5527999991234'), '+55 27 *****-1234');
  assert.equal(sf.mascarar('email', 'vitor.vitera@gmail.com'), 'vi***@gmail.com');
  assert.equal(sf.mascarar('email', ''), '');
});

test('o cookie de confiança vale para o mesmo usuário, dentro do prazo, e some ao esquecer', () => {
  const guardado = {};
  const res = { cookie: (nome, valor, opcoes) => { guardado.nome = nome; guardado.valor = valor; guardado.opcoes = opcoes; } };
  sf.confiarDispositivo({ headers: { 'user-agent': 'prova' }, protocol: 'https' }, res, 'u-conf');
  assert.equal(guardado.nome, sf.COOKIE);
  assert.equal(guardado.opcoes.httpOnly, true);
  assert.equal(guardado.opcoes.secure, true);
  assert.equal(guardado.opcoes.path, '/api/auth');
  const req = { headers: { cookie: `outra=1; ${sf.COOKIE}=${guardado.valor}` } };
  assert.equal(sf.dispositivoConfiavel(req, 'u-conf'), true);
  assert.equal(sf.dispositivoConfiavel(req, 'u-outro'), false, 'o cookie de um não serve para outro');
  assert.equal(sf.dispositivoConfiavel({ headers: {} }, 'u-conf'), false);
  db.prepare('UPDATE dispositivos_confiaveis SET expira_em = ? WHERE user_id = ?').run(agora() - 1, 'u-conf');
  assert.equal(sf.dispositivoConfiavel(req, 'u-conf'), false, 'vencido não vale e é apagado');
  sf.confiarDispositivo({ headers: {}, protocol: 'http' }, res, 'u-conf');
  assert.equal(sf.esquecerDispositivos('u-conf'), 1);
  assert.equal(sf.dispositivoConfiavel({ headers: { cookie: `${sf.COOKIE}=${guardado.valor}` } }, 'u-conf'), false);
});

test('a exigência: sem workspace não é obrigatório; a escolha liga; o canal cai no e-mail sem WhatsApp', () => {
  const nada = sf.exigencia({ id: 'u', email: 'a@b.c', segundo_fator: '' }, null);
  assert.deepEqual(nada, { obrigatorio: false, ativo: false, canal: 'email' });
  const escolhido = sf.exigencia({ id: 'u', email: 'a@b.c', segundo_fator: 'whatsapp', telefone: '5527999991234', telefone_confirmado_em: null }, null);
  assert.equal(escolhido.ativo, true);
  assert.equal(escolhido.canal, 'email', 'WhatsApp escolhido mas número não confirmado -> e-mail');
  assert.deepEqual(sf.canaisDisponiveis({ telefone: '5527999991234', telefone_confirmado_em: 1 }), sf.whatsappConfigurado() ? ['whatsapp', 'email'] : ['email']);
});
