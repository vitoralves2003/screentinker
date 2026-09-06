'use strict';

/*
 * O SEGUNDO FATOR (06/09): um código de seis dígitos pelo WhatsApp ou pelo e-mail.
 *
 * ── por que existe, e por que assim ────────────────────────────────────────────────────────
 * A senha defende contra adivinhar; contra SABER (credencial vazada de outro site) só um segundo
 * fator defende. Decisão do Vitor: obrigatório para o TITULAR de um assinante com Gestão — é a
 * conta que vê contratos, financeiro e dados dos anunciantes — e opcional para os demais. Os
 * canais são o WhatsApp (pela Evolution API, que já roda na VPS para a régua de cobrança) e o
 * e-mail (que já sabe chegar). Nada pelo Google, por decisão dele; aplicativo autenticador fica
 * para depois, se alguém pedir.
 *
 * ── o que fica gravado ─────────────────────────────────────────────────────────────────────
 *   users.telefone / telefone_confirmado_em   o número confirmado por código, e quando
 *   users.segundo_fator                       '' (desligado) | 'whatsapp' | 'email'
 *   codigos_de_acesso                         o desafio: só o HASH do código, com validade,
 *                                             tentativas e finalidade (login | telefone)
 *   dispositivos_confiaveis                   "não pedir de novo neste navegador por 30 dias",
 *                                             um cookie assinado que só esta origem escreve
 *
 * ── o que NÃO faz ──────────────────────────────────────────────────────────────────────────
 * Não se aplica ao login único (OIDC): quem entra por um provedor já passou pelo fator dele.
 * Não desliga por conta própria: sem WhatsApp configurado, o canal cai para o e-mail, nunca
 * para "nada" — a obrigação continua sendo obrigação.
 */

const crypto = require('crypto');
const { db } = require('../db/database');
const { hashToken } = require('../middleware/apiToken');
const config = require('../config');
const emailSvc = require('../services/email');

const VALIDADE_S = 10 * 60;            // um código vale dez minutos
const TENTATIVAS = 5;                  // depois disso o desafio morre e a pessoa pede outro
const REENVIO_MINIMO_S = 30;           // dois reenvios em menos de 30 s é um dedo nervoso
const CONFIANCA_DIAS = 30;
const COOKIE = 'st_dispositivo';

const CANAIS = ['whatsapp', 'email'];

/* Evolution API: a instância da PLATAFORMA (o número do Loop Player), não a de um assinante. */
function whatsappConfigurado() {
  return !!(process.env.EVOLUTION_API_URL && process.env.EVOLUTION_API_KEY && process.env.WHATSAPP_INSTANCIA_PLATAFORMA);
}

function normalizarTelefone(bruto) {
  const digitos = String(bruto || '').replace(/\D/g, '');
  if (!digitos) return null;
  // Aceita "27 99999-9999", "+55 27 ...", "5527...": tudo vira 55 + DDD + número.
  const semPais = digitos.startsWith('55') && digitos.length >= 12 ? digitos.slice(2) : digitos;
  if (semPais.length < 10 || semPais.length > 11) return null;
  return '55' + semPais;
}

function mascarar(canal, destino) {
  if (!destino) return '';
  if (canal === 'email') {
    const [nome, dominio] = String(destino).split('@');
    if (!dominio) return '***';
    return nome.slice(0, 2) + '***@' + dominio;
  }
  const d = String(destino);
  return '+' + d.slice(0, 2) + ' ' + d.slice(2, 4) + ' *****-' + d.slice(-4);
}

/*
 * A EXIGÊNCIA: obrigatório para o titular de um workspace com Gestão. Lida com os mesmos dois
 * critérios que o token carrega (papel e gestao_enabled), para que a porta e o casco não
 * discordem sobre quem é titular.
 */
function exigencia(user, workspaceId) {
  let obrigatorio = false;
  if (workspaceId) {
    try {
      const { canAdminWorkspace } = require('./permissions');
      const tenantPlan = require('./tenant-plan');
      const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
      if (ws && canAdminWorkspace(db, user, ws)) {
        const plano = tenantPlan.planRowFor(ws.id);
        obrigatorio = !!(plano && plano.gestao_enabled);
      }
    } catch (e) {
      console.warn('[segundo-fator] exigência não decidida: ' + e.message);
    }
  }
  const escolhido = CANAIS.includes(user.segundo_fator) ? user.segundo_fator : '';
  const ativo = obrigatorio || !!escolhido;
  return { obrigatorio, ativo, canal: canalDe(user, escolhido) };
}

/* O canal que de fato serve: WhatsApp só com número confirmado E instância configurada. */
function canalDe(user, preferido) {
  const temWhats = !!(user.telefone && user.telefone_confirmado_em) && whatsappConfigurado();
  if ((preferido || 'whatsapp') === 'whatsapp' && temWhats) return 'whatsapp';
  return 'email';
}

function canaisDisponiveis(user) {
  const lista = ['email'];
  if (user.telefone && user.telefone_confirmado_em && whatsappConfigurado()) lista.unshift('whatsapp');
  return lista;
}

function gerarCodigo() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

async function enviarWhatsApp(numero, texto) {
  const base = String(process.env.EVOLUTION_API_URL).replace(/\/+$/, '');
  const inst = encodeURIComponent(process.env.WHATSAPP_INSTANCIA_PLATAFORMA);
  const r = await fetch(`${base}/message/sendText/${inst}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: process.env.EVOLUTION_API_KEY },
    body: JSON.stringify({ number: numero, text: texto }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error('Evolution respondeu ' + r.status);
}

async function entregar(canal, destino, codigo, finalidade) {
  const motivo = finalidade === 'telefone' ? 'para confirmar seu WhatsApp no Loop Player' : 'para entrar no Loop Player';
  const texto = `Seu código ${motivo} é ${codigo}. Vale por 10 minutos. Se não foi você, ignore esta mensagem.`;
  if (canal === 'whatsapp') return enviarWhatsApp(destino, texto);
  return emailSvc.sendEmail({
    to: destino,
    subject: `${codigo} é o seu código do Loop Player`,
    text: texto,
    html: `<p>Seu código ${motivo} é</p><p style="font-size:28px;letter-spacing:6px;font-weight:700">${codigo}</p><p>Vale por 10 minutos. Se não foi você, ignore este e-mail.</p>`,
  });
}

/*
 * EMITIR UM DESAFIO. Grava só o hash; devolve o id (que vai para o navegador) e o que ele pode
 * mostrar: o canal e o destino mascarado. Um desafio novo mata os anteriores da mesma
 * finalidade — só existe um código válido por vez.
 */
async function emitirDesafio(user, { finalidade = 'login', canal, destino } = {}) {
  const c = canal || canalDe(user, user.segundo_fator);
  const alvo = destino || (c === 'whatsapp' ? user.telefone : user.email);
  if (!alvo) throw new Error('sem destino para o código');
  const ultimo = db.prepare('SELECT criado_em FROM codigos_de_acesso WHERE user_id = ? AND finalidade = ? AND usado_em IS NULL ORDER BY criado_em DESC LIMIT 1')
    .get(user.id, finalidade);
  const agora = Math.floor(Date.now() / 1000);
  if (ultimo && agora - ultimo.criado_em < REENVIO_MINIMO_S) {
    const e = new Error('Espere alguns segundos antes de pedir outro código.'); e.code = 'muito_cedo'; throw e;
  }
  const codigo = gerarCodigo();
  const id = crypto.randomUUID();
  db.prepare("UPDATE codigos_de_acesso SET usado_em = strftime('%s','now') WHERE user_id = ? AND finalidade = ? AND usado_em IS NULL").run(user.id, finalidade);
  db.prepare(`INSERT INTO codigos_de_acesso (id, user_id, finalidade, canal, destino, codigo_hash, expira_em, tentativas, criado_em)
              VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`)
    .run(id, user.id, finalidade, c, alvo, hashToken(codigo), agora + VALIDADE_S, agora);
  await entregar(c, alvo, codigo, finalidade);
  return { desafio: id, canal: c, destino: mascarar(c, alvo), canais: canaisDisponiveis(user), valido_por_s: VALIDADE_S };
}

/*
 * CONFERIR. Devolve { ok, user_id, destino } ou { ok:false, motivo }. Cada erro conta; no quinto
 * o desafio morre. Comparação em tempo constante sobre os hashes.
 */
function conferir(desafioId, codigo, finalidade = 'login') {
  const row = db.prepare('SELECT * FROM codigos_de_acesso WHERE id = ? AND finalidade = ?').get(String(desafioId || ''), finalidade);
  if (!row || row.usado_em) return { ok: false, motivo: 'desafio_invalido' };
  const agora = Math.floor(Date.now() / 1000);
  if (row.expira_em < agora) return { ok: false, motivo: 'expirado' };
  if (row.tentativas >= TENTATIVAS) return { ok: false, motivo: 'esgotado' };
  const dado = Buffer.from(hashToken(String(codigo || '').replace(/\D/g, '')));
  const certo = Buffer.from(row.codigo_hash);
  const bate = dado.length === certo.length && crypto.timingSafeEqual(dado, certo);
  if (!bate) {
    db.prepare('UPDATE codigos_de_acesso SET tentativas = tentativas + 1 WHERE id = ?').run(row.id);
    return { ok: false, motivo: row.tentativas + 1 >= TENTATIVAS ? 'esgotado' : 'codigo_errado', restantes: TENTATIVAS - row.tentativas - 1 };
  }
  db.prepare("UPDATE codigos_de_acesso SET usado_em = strftime('%s','now') WHERE id = ?").run(row.id);
  return { ok: true, user_id: row.user_id, canal: row.canal, destino: row.destino };
}

/* ── dispositivos confiáveis ───────────────────────────────────────────────────────────── */

function lerCookie(req, nome) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const parte of raw.split(';')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    if (parte.slice(0, i).trim() === nome) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return null;
}

function dispositivoConfiavel(req, userId) {
  const bruto = lerCookie(req, COOKIE);
  if (!bruto) return false;
  const row = db.prepare('SELECT id, expira_em FROM dispositivos_confiaveis WHERE user_id = ? AND token_hash = ?').get(userId, hashToken(bruto));
  if (!row) return false;
  const agora = Math.floor(Date.now() / 1000);
  if (row.expira_em < agora) { db.prepare('DELETE FROM dispositivos_confiaveis WHERE id = ?').run(row.id); return false; }
  db.prepare('UPDATE dispositivos_confiaveis SET ultimo_uso = ? WHERE id = ?').run(agora, row.id);
  return true;
}

function confiarDispositivo(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const agora = Math.floor(Date.now() / 1000);
  const nome = String(req.headers['user-agent'] || '').slice(0, 120);
  db.prepare('INSERT INTO dispositivos_confiaveis (id, user_id, token_hash, nome, criado_em, expira_em, ultimo_uso) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), userId, hashToken(token), nome, agora, agora + CONFIANCA_DIAS * 86400, agora);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https',
    maxAge: CONFIANCA_DIAS * 86400 * 1000,
    path: '/api/auth',
  });
}

function esquecerDispositivos(userId) {
  return db.prepare('DELETE FROM dispositivos_confiaveis WHERE user_id = ?').run(userId).changes;
}

/* O que a tela de Conta mostra. */
function estado(user, workspaceId) {
  const ex = exigencia(user, workspaceId);
  return {
    obrigatorio: ex.obrigatorio,
    ativo: ex.ativo,
    canal: ex.ativo ? ex.canal : '',
    escolha: CANAIS.includes(user.segundo_fator) ? user.segundo_fator : '',
    telefone: user.telefone ? mascarar('whatsapp', user.telefone) : '',
    telefone_confirmado: !!(user.telefone && user.telefone_confirmado_em),
    whatsapp_disponivel: whatsappConfigurado(),
    dispositivos_confiaveis: db.prepare('SELECT COUNT(*) AS n FROM dispositivos_confiaveis WHERE user_id = ? AND expira_em > ?').get(user.id, Math.floor(Date.now() / 1000)).n,
  };
}

module.exports = {
  CANAIS, VALIDADE_S, TENTATIVAS, COOKIE,
  whatsappConfigurado, normalizarTelefone, mascarar,
  exigencia, canaisDisponiveis, emitirDesafio, conferir,
  dispositivoConfiavel, confiarDispositivo, esquecerDispositivos, estado,
};
