/*
 * O SEGUNDO FATOR, CONTRA O SERVIDOR DE VERDADE — de dentro do container da Operação.
 *
 *   1. Um assinante de prova nasce e entra só com a senha (plano grátis: nada é exigido).
 *   2. Ele liga o segundo fator por e-mail; o login passa a devolver um DESAFIO, sem sessão.
 *   3. Código errado cinco vezes esgota o desafio; o reenvio dá outro; o certo dá a sessão.
 *   4. "Confiar neste navegador" grava um cookie que dispensa o código por 30 dias — e
 *      "esquecer dispositivos" o invalida.
 *   5. Titular de um workspace com Gestão é OBRIGADO: não desliga, e o login exige mesmo com
 *      a escolha vazia. De volta ao grátis, a exigência some.
 *   6. Confirmar um WhatsApp sem a Evolution configurada é recusado com o motivo.
 *   7. Tudo desfeito.
 *
 * O código enviado só existe como hash; a prova planta o hash de um código conhecido no
 * desafio que o servidor criou — o caminho (emitir, entregar, conferir) é o de produção.
 */
process.chdir('/app/server');
const { db } = require('./db/database');
const { hashToken } = require('./middleware/apiToken');
const config = require('./config');

const PORTA = process.env.PORT || config.port || 3001;
const BASE = `http://127.0.0.1:${PORTA}`;
let falhas = 0;
const ok = (m, x) => console.log(`  ok    ${m}${x !== undefined ? `   ${x}` : ''}`);
const falha = (m, x) => { falhas++; console.log(`  FALHA ${m}${x !== undefined ? `   ${x}` : ''}`); };
const afirmar = (c, m, x) => (c ? ok(m, x) : falha(m, x));

async function http(caminho, { metodo = 'GET', corpo, token, headers = {} } = {}) {
  const r = await fetch(BASE + caminho, {
    method: metodo, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const d = await r.json().catch(() => ({}));
  return { status: r.status, d, cookie: r.headers.get('set-cookie') || '' };
}
const plantar = (desafio, codigo) => db.prepare('UPDATE codigos_de_acesso SET codigo_hash = ? WHERE id = ?').run(hashToken(codigo), desafio).changes;

const plantado = { user: null, ws: null, org: null };
/* Apaga o que a prova plantou seguindo as chaves estrangeiras do esquema: uma lista escrita à mão
   errou duas vezes (tabela que não existe, chave que ninguém lembrava). */
function apagarConta(userId) {
  const tabelas = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  const fksPara = (alvo) => { const out = []; for (const t of tabelas) for (const fk of db.prepare(`PRAGMA foreign_key_list(${t})`).all()) if (fk.table === alvo) out.push({ tabela: t, coluna: fk.from }); return out; };
  const apagarPor = (lista, valor) => { for (const { tabela, coluna } of lista) { try { db.prepare(`DELETE FROM ${tabela} WHERE ${coluna} = ?`).run(valor); } catch (e) { console.log(`  (${tabela}.${coluna}: ${e.message})`); } } };
  const paraUsers = fksPara('users'), paraWs = fksPara('workspaces'), paraOrg = fksPara('organizations');
  db.transaction(() => {
    const wss = db.prepare('SELECT DISTINCT w.id, w.organization_id FROM workspaces w LEFT JOIN workspace_members wm ON wm.workspace_id = w.id WHERE wm.user_id = ? OR w.created_by = ?').all(userId, userId);
    for (const ws of wss) {
      apagarPor(paraWs, ws.id);
      db.prepare('DELETE FROM workspaces WHERE id = ?').run(ws.id);
      if (ws.organization_id && !db.prepare('SELECT 1 FROM workspaces WHERE organization_id = ?').get(ws.organization_id)) {
        apagarPor(paraOrg, ws.organization_id);
        db.prepare('DELETE FROM organizations WHERE id = ?').run(ws.organization_id);
      }
    }
    apagarPor(paraUsers, userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  })();
}

function limpar() {
  console.log('7. desfazendo');
  if (plantado.user) { try { apagarConta(plantado.user); } catch (e) { console.log('  (apagar: ' + e.message + ')'); } }
  afirmar(!plantado.user || db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(plantado.user).n === 0, 'o assinante de prova não existe mais');
}

(async () => {
  const ts = Date.now();
  const email = `prova-2fa-${ts}@exemplo.invalid`;
  const senha = 'Prova-do-segundo-fator-' + ts;
  const entrar = (headers) => http('/api/auth/login', { metodo: 'POST', corpo: { email, password: senha }, headers });

  console.log('1. sem exigência, a senha basta');
  const reg = await http('/api/auth/register', { metodo: 'POST', corpo: { email, password: senha, name: 'Prova do segundo fator', aceite_termos: '2026-09-06' } });
  afirmar(reg.status === 201 || reg.status === 200, 'cadastro aceito', reg.status);
  const u = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!u) { falha('usuário não nasceu'); process.exit(1); }
  plantado.user = u.id;
  db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(u.id);
  const ws = db.prepare('SELECT w.id, w.organization_id FROM workspaces w JOIN workspace_members wm ON wm.workspace_id = w.id WHERE wm.user_id = ? LIMIT 1').get(u.id);
  if (ws) { plantado.ws = ws.id; plantado.org = ws.organization_id; }
  let l = await entrar();
  afirmar(l.status === 200 && !!l.d.token && !l.d.segundo_fator_required, 'entra direto no plano grátis', l.status);
  let token = l.d.token;
  const e0 = await http('/api/auth/segundo-fator', { token });
  afirmar(e0.status === 200 && e0.d.ativo === false && e0.d.obrigatorio === false, 'GET /segundo-fator: desligado e não obrigatório', JSON.stringify(e0.d));

  console.log('2. ligado por e-mail, o login devolve um desafio');
  const liga = await http('/api/auth/segundo-fator', { metodo: 'PUT', token, corpo: { canal: 'email' } });
  afirmar(liga.status === 200 && liga.d.ativo === true && liga.d.canal === 'email', 'PUT canal=email liga', JSON.stringify(liga.d));
  const whats = await http('/api/auth/segundo-fator', { metodo: 'PUT', token, corpo: { canal: 'whatsapp' } });
  afirmar(whats.status === 400, 'WhatsApp sem número confirmado é recusado', whats.status + ' ' + whats.d.error);
  l = await entrar();
  afirmar(l.status === 200 && l.d.segundo_fator_required === true && !!l.d.desafio && !l.d.token, 'login devolve o desafio, sem token', JSON.stringify(l.d).slice(0, 160));
  afirmar(l.d.canal === 'email' && /\*\*\*@/.test(String(l.d.destino)), 'canal e-mail, destino mascarado', l.d.destino);
  let desafio = l.d.desafio;
  const row = db.prepare('SELECT * FROM codigos_de_acesso WHERE id = ?').get(desafio);
  afirmar(!!row && row.finalidade === 'login' && row.codigo_hash.length >= 32 && row.expira_em > Math.floor(Date.now() / 1000), 'o desafio está gravado só como hash, com validade');

  console.log('3. errado esgota, reenvio renova, certo entra');
  let ultimo = null;
  for (let i = 1; i <= 5; i++) ultimo = await http('/api/auth/segundo-fator/confirmar', { metodo: 'POST', corpo: { desafio, codigo: '000000' } });
  afirmar(ultimo.status === 401 && ultimo.d.code === 'esgotado', 'cinco erros esgotam o desafio', ultimo.status + ' ' + ultimo.d.code);
  db.prepare('UPDATE codigos_de_acesso SET criado_em = criado_em - 120 WHERE id = ?').run(desafio);
  const re = await http('/api/auth/segundo-fator/reenviar', { metodo: 'POST', corpo: { desafio } });
  afirmar(re.status === 200 && re.d.desafio && re.d.desafio !== desafio, 'reenviar dá outro desafio', re.status);
  const morto = db.prepare('SELECT usado_em FROM codigos_de_acesso WHERE id = ?').get(desafio);
  afirmar(!!(morto && morto.usado_em), 'e o anterior morre');
  desafio = re.d.desafio;
  const cedo = await http('/api/auth/segundo-fator/reenviar', { metodo: 'POST', corpo: { desafio } });
  afirmar(cedo.status === 429, 'pedir de novo em seguida é 429', cedo.status);
  afirmar(plantar(desafio, '123456') === 1, 'a prova planta o hash de 123456 no desafio');
  const certo = await http('/api/auth/segundo-fator/confirmar', { metodo: 'POST', corpo: { desafio, codigo: '12 34 56', confiar: true } });
  afirmar(certo.status === 200 && !!certo.d.token && certo.d.user && certo.d.user.email === email, 'o código certo dá a sessão', certo.status);
  afirmar(/st_dispositivo=/.test(certo.cookie) && /HttpOnly/i.test(certo.cookie), 'com confiar=true vem o cookie httpOnly', certo.cookie.slice(0, 60));
  const repetido = await http('/api/auth/segundo-fator/confirmar', { metodo: 'POST', corpo: { desafio, codigo: '123456' } });
  afirmar(repetido.status === 401, 'o mesmo código de novo não vale', repetido.status);
  token = certo.d.token;

  console.log('4. o navegador confiável dispensa o código');
  const cookie = certo.cookie.split(';')[0];
  l = await entrar({ Cookie: cookie });
  afirmar(l.status === 200 && !!l.d.token && !l.d.segundo_fator_required, 'com o cookie, entra direto', l.status);
  const e1 = await http('/api/auth/segundo-fator', { token });
  afirmar(e1.d.dispositivos_confiaveis === 1, 'GET conta 1 dispositivo confiável', e1.d.dispositivos_confiaveis);
  const esq = await http('/api/auth/segundo-fator/dispositivos', { metodo: 'DELETE', token });
  afirmar(esq.status === 200 && esq.d.esquecidos === 1, 'esquecer dispositivos', JSON.stringify(esq.d));
  l = await entrar({ Cookie: cookie });
  afirmar(l.d.segundo_fator_required === true, 'com o cookie esquecido, pede o código de novo');

  console.log('5. o titular com Gestão é obrigado');
  if (!ws) { falha('sem workspace para a exigência'); }
  else {
    const planoAntes = db.prepare('SELECT plan_id FROM workspaces WHERE id = ?').get(ws.id).plan_id;
    db.prepare("UPDATE workspaces SET plan_id = 'master' WHERE id = ?").run(ws.id);
    const e2 = await http('/api/auth/segundo-fator', { token });
    afirmar(e2.d.obrigatorio === true && e2.d.ativo === true, 'no Master, obrigatório', JSON.stringify(e2.d));
    const off = await http('/api/auth/segundo-fator', { metodo: 'PUT', token, corpo: { canal: '' } });
    afirmar(off.status === 400, 'desligar é recusado', off.status + ' ' + off.d.error);
    db.prepare("UPDATE users SET segundo_fator = '' WHERE id = ?").run(u.id);
    l = await entrar();
    afirmar(l.d.segundo_fator_required === true && l.d.canal === 'email', 'mesmo com a escolha vazia, o login exige (cai no e-mail)', JSON.stringify(l.d).slice(0, 100));
    db.prepare('UPDATE workspaces SET plan_id = ? WHERE id = ?').run(planoAntes, ws.id);
    l = await entrar();
    afirmar(l.status === 200 && !!l.d.token, 'de volta ao grátis e sem escolha, a senha basta', l.status);
  }

  console.log('6. o WhatsApp sem a Evolution configurada');
  const tel = await http('/api/auth/segundo-fator/telefone', { metodo: 'POST', token, corpo: { telefone: '27 99999-0000' } });
  const evolucao = !!(process.env.EVOLUTION_API_URL && process.env.EVOLUTION_API_KEY && process.env.WHATSAPP_INSTANCIA_PLATAFORMA);
  if (!evolucao) afirmar(tel.status === 503 && tel.d.code === 'whatsapp_indisponivel', 'sem Evolution: recusa com o motivo', tel.status + ' ' + tel.d.error);
  else afirmar([200, 503].includes(tel.status), 'com Evolution: tenta enviar (número fictício)', tel.status + ' ' + (tel.d.error || tel.d.destino));
  const invalido = await http('/api/auth/segundo-fator/telefone', { metodo: 'POST', token, corpo: { telefone: '123' } });
  afirmar(invalido.status === 400, 'número curto é recusado', invalido.status);

  limpar();
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nSEGUNDO FATOR: TUDO CERTO');
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.log('ERRO: ' + (e.stack || e.message)); try { limpar(); } catch { /* já reportado */ } process.exit(1); });
