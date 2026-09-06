/*
 * A PORTA DO PRODUTO NA CASA NOVA (06/09), num Chrome de 390px.
 *
 *   1. /gestao/entrar desenha a porta: e-mail, senha, entrar, criar conta, esqueci.
 *   2. As portas velhas viram a nova: /app#/login?verified=1 e /app#/reset-password?token=…
 *      chegam em /gestao/entrar com os parâmetros traduzidos.
 *   3. Criar conta exige o aceite dos Termos, e os dois documentos respondem.
 *   4. Senha errada recebe a frase. A conta de prova é titular com Gestão: a senha certa leva
 *      ao CÓDIGO (segundo fator), sem sessão; com o cookie de navegador confiável (vindo de
 *      lib/sessao.sh, pelo caminho de produção) a senha certa entra direto e cai no início.
 *   5. Sem sessão, o casco manda para a porta (dashboard e a raiz da Gestão).
 *   6. Quem já tinha conta e não aceitou a versão vigente vê o cartão, aceita e ele some.
 *
 * Roda de /opt/novo-operacao/scripts/provas (ver provar_entrar.sh), com EMAIL/SENHA da conta
 * de prova e TOKEN da sessão dela (para o cartão do aceite).
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'https://beta.loopplayer.com.br/gestao';
const BASE = process.env.BASE || 'https://beta.loopplayer.com.br';
const EMAIL = process.env.EMAIL || '';
const SENHA = process.env.SENHA || '';
const TOKEN = process.env.TOKEN || '';
const COOKIE_CONFIANCA = process.env.COOKIE_CONFIANCA || '';
const VERSAO_VIGENTE = '2026-09-06';

let falhas = 0;
const ok = (m, x) => console.log(`  ok    ${m}${x !== undefined ? `   ${x}` : ''}`);
const falha = (m, x) => { falhas++; console.log(`  FALHA ${m}${x !== undefined ? `   ${x}` : ''}`); };
const afirmar = (c, m, x) => (c ? ok(m, x) : falha(m, x));
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function esperarPorta(page, modo, tempo = 15000) {
  try {
    await page.waitForSelector(`[data-porta-do-produto][data-modo="${modo}"]`, { timeout: tempo });
    return true;
  } catch { return false; }
}

(async () => {
  if (!EMAIL || !SENHA || !TOKEN) { console.log('SEM CONTA DE PROVA: passe EMAIL=, SENHA= e TOKEN='); process.exit(1); }
  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await navegador.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  const erros = [];
  page.on('pageerror', (e) => erros.push(String(e).slice(0, 120)));

  console.log('1. a porta desenha');
  await page.goto(`${UNI}/entrar`, { waitUntil: 'domcontentloaded' });
  afirmar(await esperarPorta(page, 'entrar'), 'a porta abre no modo entrar');
  const controles = await page.evaluate(() => ({
    email: !!document.querySelector('input[type="email"]'),
    senha: !!document.querySelector('input[type="password"]'),
    entrar: !!document.querySelector('[data-entrar]'),
    texto: document.body.innerText,
  }));
  afirmar(controles.email && controles.senha && controles.entrar, 'e-mail, senha e o botão de entrar');
  afirmar(/Criar conta/i.test(controles.texto) && /Esqueci/i.test(controles.texto), 'os caminhos de criar conta e esqueci a senha');
  afirmar(!/GESTÃO|Gestão —|Operação —/.test(controles.texto), 'a porta não fala em módulo');

  console.log('2. as portas velhas viram a nova');
  await page.goto(`${BASE}/app#/login?verified=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => location.pathname.startsWith('/gestao/entrar'), { timeout: 15000 }).catch(() => {});
  afirmar(page.url().includes('/gestao/entrar') && page.url().includes('verified=1'), '/app#/login?verified=1 chega em /gestao/entrar?verified=1', page.url());
  await esperarPorta(page, 'entrar');
  await esperar(500);
  afirmar(await page.evaluate(() => /E-mail confirmado/.test(document.body.innerText)), 'e diz que o e-mail foi confirmado');
  await page.goto(`${BASE}/app#/reset-password?token=prova-abc`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => location.pathname.startsWith('/gestao/entrar'), { timeout: 15000 }).catch(() => {});
  afirmar(page.url().includes('redefinir=prova-abc'), '#/reset-password?token= vira ?redefinir=', page.url());
  afirmar(await esperarPorta(page, 'redefinir'), 'e a porta abre no modo redefinir');

  console.log('3. criar conta exige o aceite');
  await page.goto(`${UNI}/entrar?criar=1`, { waitUntil: 'domcontentloaded' });
  afirmar(await esperarPorta(page, 'criar'), '?criar=1 abre em criar conta');
  const aceite = await page.evaluate(() => {
    const caixa = document.querySelector('[data-aceite-dos-termos]');
    const links = [...document.querySelectorAll('a[href*="/legal/"]')].map((a) => a.getAttribute('href'));
    return { caixa: !!caixa, links };
  });
  afirmar(aceite.caixa, 'a caixa de aceite existe');
  afirmar(aceite.links.some((h) => h.includes('termos')) && aceite.links.some((h) => h.includes('privacidade')), 'com links para Termos e Privacidade', aceite.links.join(' '));
  for (const doc of ['termos', 'privacidade']) {
    const r = await page.evaluate(async (u) => { const x = await fetch(u); return { status: x.status, tem: (await x.text()).includes('Loop Player') }; }, `${UNI}/legal/${doc}.html`);
    afirmar(r.status === 200 && r.tem, `/legal/${doc}.html responde e fala do Loop Player`, r.status);
  }
  /* Nome também: o campo é required, e sem ele o navegador segura o envio antes do nosso aviso. */
  await page.type('input[autocomplete="name"]', 'Prova sem aceite');
  await page.type('input[type="email"]', `prova-sem-aceite-${Date.now()}@example.com`);
  await page.type('input[type="password"]', 'Uma-senha-longa-e-rara-9317');
  /* E a confirmação da senha (o segundo campo de senha), também required. */
  const senhas = await page.$$('input[type="password"]');
  if (senhas[1]) await senhas[1].type('Uma-senha-longa-e-rara-9317');
  /* O botão de enviar é [data-entrar] em todo modo; [data-criar-conta] é o link que abre o modo. */
  await page.click('[data-entrar]');
  await page.waitForSelector('[data-erro]', { timeout: 8000 }).catch(() => {});
  const semAceite = await page.evaluate(() => ({ modo: document.querySelector('[data-porta-do-produto]')?.getAttribute('data-modo'), erro: document.querySelector('[data-erro]')?.textContent || '', valido: document.querySelector('form')?.checkValidity(), campos: [...document.querySelectorAll('form input')].map((i) => i.type + ':' + i.value.length + ':' + i.validity.valid).join(' '), botao: document.querySelector('[data-entrar]')?.textContent, url: location.href }));
  afirmar(semAceite.modo === 'criar' && /aceit/i.test(semAceite.erro), 'sem marcar o aceite, não cria e explica', semAceite.erro || JSON.stringify(semAceite));

  console.log('4. entrar');
  await page.goto(`${UNI}/entrar`, { waitUntil: 'domcontentloaded' });
  await esperarPorta(page, 'entrar');
  await page.type('input[type="email"]', EMAIL);
  await page.type('input[type="password"]', 'senha-errada-de-proposito');
  await page.click('[data-entrar]');
  await page.waitForSelector('[data-erro]', { timeout: 15000 }).catch(() => {});
  const errado = await page.evaluate(() => document.querySelector('[data-erro]')?.textContent || '');
  afirmar(/incorretos/i.test(errado), 'senha errada recebe a frase', errado);
  await page.evaluate(() => { const s = document.querySelector('input[type="password"]'); s.value = ''; });
  await page.click('input[type="password"]', { clickCount: 3 });
  await page.type('input[type="password"]', SENHA);
  await page.click('[data-entrar]');
  /* Sem navegador confiável, a senha certa leva ao código — e não a uma sessão. */
  const pediuCodigo = await page.waitForSelector('[data-porta-do-produto][data-modo="codigo"]', { timeout: 20000 }).then(() => true).catch(() => false);
  afirmar(pediuCodigo, 'a senha certa leva ao passo do código (titular com Gestão)');
  if (pediuCodigo) {
    const passo = await page.evaluate(() => ({ campo: !!document.querySelector('[data-codigo]'), confiar: !!document.querySelector('[data-confiar]'), reenviar: !!document.querySelector('[data-reenviar-codigo]'), texto: document.body.innerText, token: !!localStorage.getItem('token') }));
    afirmar(passo.campo && passo.confiar && passo.reenviar, 'o passo tem o campo, o "confiar" e o "reenviar"');
    afirmar(/6 dígitos/.test(passo.texto) && /\*\*\*@/.test(passo.texto), 'diz o canal e o destino mascarado');
    afirmar(!passo.token, 'e nenhuma sessão foi gravada antes do código');
    await page.type('[data-codigo]', '000000');
    await page.click('[data-entrar]');
    await page.waitForSelector('[data-erro]', { timeout: 15000 }).catch(() => {});
    afirmar(/incorreto/i.test(await page.evaluate(() => document.querySelector('[data-erro]')?.textContent || '')), 'código errado recebe a frase');
  }
  if (COOKIE_CONFIANCA) {
    const dominio = new URL(BASE).hostname;
    await page.setCookie({ name: 'st_dispositivo', value: COOKIE_CONFIANCA, domain: dominio, path: '/api/auth', httpOnly: true, secure: true, sameSite: 'Lax' });
    await page.goto(`${UNI}/entrar`, { waitUntil: 'domcontentloaded' });
    await esperarPorta(page, 'entrar');
    await page.type('input[type="email"]', EMAIL);
    await page.type('input[type="password"]', SENHA);
    await page.click('[data-entrar]');
  } else {
    falha('sem COOKIE_CONFIANCA: a prova não tem como entrar pela tela');
  }
  await page.waitForFunction(() => !location.pathname.startsWith('/gestao/entrar'), { timeout: 25000 }).catch(() => {});
  const depois = { url: page.url(), token: await page.evaluate(() => !!localStorage.getItem('token')) };
  afirmar(!depois.url.includes('/entrar') && depois.token, 'com o navegador confiável, a senha certa entra e sai da porta', depois.url);
  /* A barra unificada é o elemento <loop-sidebar> (Shadow DOM), o mesmo que abrir.js lê. */
  await page.waitForSelector('loop-sidebar', { timeout: 20000 }).catch(() => {});
  afirmar(await page.evaluate(() => !!document.querySelector('loop-sidebar')), 'e o casco desenha a barra');

  console.log('5. sem sessão, o casco manda para a porta');
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${UNI}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => location.pathname.startsWith('/gestao/entrar'), { timeout: 15000 }).catch(() => {});
  afirmar(page.url().includes('/gestao/entrar'), '/gestao/dashboard sem sessão vai para a porta', page.url());
  await page.goto(`${UNI}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => location.pathname.startsWith('/gestao/entrar'), { timeout: 15000 }).catch(() => {});
  afirmar(page.url().includes('/gestao/entrar'), 'a raiz da Gestão sem sessão vai para a porta', page.url());

  console.log('6. o cartão do aceite para quem já tinha conta');
  const marcar = await page.evaluate(async (t) => {
    const r = await fetch('/api/auth/aceitar-termos', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: JSON.stringify({ versao: 'antiga' }) });
    return r.status;
  }, TOKEN);
  afirmar(marcar === 200, 'a conta de prova volta para uma versão antiga', marcar);
  await page.evaluate((t) => localStorage.setItem('token', t), TOKEN);
  await page.goto(`${UNI}/ajuda`, { waitUntil: 'domcontentloaded' });
  const cartao = await page.waitForSelector('[data-aceite-dos-termos-pendente]', { timeout: 20000 }).then(() => true).catch(() => false);
  afirmar(cartao, 'o cartão "Os Termos mudaram" aparece dentro do casco');
  if (cartao) {
    const caixa = await page.evaluate(() => { const c = document.querySelector('[data-aceite-dos-termos-pendente] > div'); const r = c.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, alto: innerHeight }; });
    afirmar(caixa.top >= 0 && caixa.bottom <= caixa.alto + 1, 'e cabe na tela do celular', JSON.stringify(caixa));
    await page.click('[data-aceitar-termos]');
    await page.waitForFunction(() => !document.querySelector('[data-aceite-dos-termos-pendente]'), { timeout: 15000 }).catch(() => {});
    afirmar(await page.evaluate(() => !document.querySelector('[data-aceite-dos-termos-pendente]')), 'aceitar faz o cartão sumir');
  }
  const me = await page.evaluate(async (t) => { const r = await fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + t } }); return r.ok ? (await r.json()).terms_version : null; }, TOKEN);
  afirmar(me === VERSAO_VIGENTE, 'e a conta guarda a versão vigente', me);

  afirmar(erros.length === 0, 'sem erro de JavaScript', erros.join(' | '));
  await navegador.close();
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nPORTA NA CASA NOVA: TUDO CERTO');
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.log('ERRO: ' + e.message); process.exit(1); });
