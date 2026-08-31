/*
 * ABRE A APLICACAO NUM NAVEGADOR DE VERDADE e conta o que aconteceu.
 *
 * ── POR QUE ISTO EXISTE ──────────────────────────────────────────────────────────────────
 * O Vitor viu a tela em branco tres vezes seguidas enquanto 148 checagens ficavam verdes. Nao
 * havia contradicao: TODAS as minhas provas testam o SERVIDOR. Nenhuma executava o frontend.
 * Entao um erro de JavaScript no arranque -- que apaga a tela inteira -- era invisivel para o
 * conjunto todo, e eu passei tres rodadas procurando no lugar errado.
 *
 * Esta prova abre a pagina, espera o app assentar, e devolve o que so um navegador sabe: os
 * erros do console, os pedidos que falharam, e quantos itens a barra REALMENTE desenhou --
 * atravessando o Shadow DOM, onde nenhum grep alcanca.
 *
 * ── COMO RODA ────────────────────────────────────────────────────────────────────────────
 * Dentro de um conteiner com Chrome e Puppeteer, na rede do host:
 *
 *   docker run --rm --network host -v "$PWD/scripts/provas:/p" \
 *     zenika/alpine-chrome:with-puppeteer node /p/abrir.js
 *
 * Nada e instalado no servidor.
 */
const puppeteer = require('puppeteer');

const BASE = process.env.BASE || 'http://127.0.0.1:3110';
const EMAIL = process.env.EMAIL || 'cliente@exemplo.invalid';
const SENHA = process.env.SENHA || 'SenhaCliente#2026';
const CODIGO = process.env.CODIGO || '';

(async () => {
  /*
   * A SESSAO VEM PRONTA, do TOKEN no ambiente.
   *
   * Quem a obtem e o shell, com mfa_lib.sh -- a mesma funcao `entrar` que todas as outras
   * provas usam. A conta de teste tem segunda etapa, e reimplementar TOTP aqui seria uma
   * segunda copia de algo que ja existe e ja e testado.
   *
   * Digitar no formulario tambem nao serve: testaria a tela de login, que nao e o que esta em
   * duvida. O que esta em duvida e se a aplicacao ABRE depois de autenticada.
   */
  let dados = { token: process.env.TOKEN || '', user: {} };

  if (!dados.token) {
    const corpo = { email: EMAIL, password: SENHA };
    if (CODIGO) corpo.totp_code = CODIGO;
    const r = await fetch(BASE + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    dados = await r.json();
  }

  if (!dados.token) {
    console.log('SEM SESSAO: passe TOKEN=... no ambiente (ver mfa_lib.sh) ou uma conta sem MFA');
    process.exit(1);
  }

  // Com TOKEN vindo de fora nao ha objeto de usuario junto; o app o relê de /auth/me. O que
  // precisa existir no localStorage antes do primeiro script é o token.
  if (!dados.user) dados.user = {};

  const navegador = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const pagina = await navegador.newPage();

  const erros = [];
  const avisos = [];
  const falhados = [];

  // Um erro nao capturado no arranque de um modulo apaga a tela inteira e nao deixa marca
  // nenhuma no servidor. E exatamente o que esta prova existe para ver.
  pagina.on('pageerror', (e) => erros.push('pageerror: ' + e.message));
  pagina.on('console', (m) => {
    if (m.type() === 'error') erros.push('console.error: ' + m.text());
    else if (m.type() === 'warning') avisos.push(m.text());
  });
  pagina.on('requestfailed', (req) => {
    falhados.push(req.url() + ' -> ' + (req.failure() || {}).errorText);
  });
  pagina.on('response', (resp) => {
    if (resp.status() >= 400) falhados.push(resp.url() + ' -> HTTP ' + resp.status());
  });

  // A sessao precisa existir ANTES do primeiro script rodar, senao o app decide que nao ha
  // ninguem e vai para o login -- e a prova mediria a tela errada.
  await pagina.evaluateOnNewDocument((t, u) => {
    localStorage.setItem('token', t);
    localStorage.setItem('user', JSON.stringify(u));
  }, dados.token, dados.user || {});

  await pagina.goto(BASE + '/app#/', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise((s) => setTimeout(s, 2500));

  /*
   * O QUE A BARRA DESENHOU DE FATO. Atravessa o Shadow DOM, que e onde ela vive agora -- e
   * onde nenhuma checagem de texto no repositorio consegue olhar.
   */
  const barra = await pagina.evaluate(() => {
    const el = document.querySelector('loop-sidebar');
    if (!el) return { existe: false };
    if (!el.shadowRoot) return { existe: true, atualizado: false };
    const itens = [...el.shadowRoot.querySelectorAll('a.item')].map((a) => a.dataset.id);
    return {
      existe: true,
      atualizado: true,
      temMenu: !!el.menu,
      itens,
      lugar: (el.shadowRoot.querySelector('.lugar .nome') || {}).textContent || null,
      pessoa: (el.shadowRoot.querySelector('.pessoa .nome') || {}).textContent || null,
    };
  });

  const conteudo = await pagina.evaluate(() => {
    const app = document.getElementById('app');
    return { existe: !!app, tamanho: app ? app.innerHTML.trim().length : 0 };
  });

  console.log('=== ERROS DE JAVASCRIPT ===');
  if (!erros.length) console.log('  nenhum');
  for (const e of erros.slice(0, 12)) console.log('  ' + e);

  console.log('');
  console.log('=== PEDIDOS QUE FALHARAM ===');
  if (!falhados.length) console.log('  nenhum');
  for (const f of falhados.slice(0, 12)) console.log('  ' + f);

  console.log('');
  console.log('=== A BARRA ===');
  console.log('  elemento existe: ' + barra.existe);
  console.log('  foi atualizado:  ' + (barra.atualizado === undefined ? '-' : barra.atualizado));
  console.log('  recebeu o menu:  ' + (barra.temMenu === undefined ? '-' : barra.temMenu));
  console.log('  itens: ' + ((barra.itens || []).join(', ') || '(nenhum)'));
  console.log('  cliente: ' + barra.lugar);
  console.log('  pessoa:  ' + barra.pessoa);

  console.log('');
  console.log('=== O CONTEUDO ===');
  console.log('  #app existe: ' + conteudo.existe + ', bytes desenhados: ' + conteudo.tamanho);

  /*
   * E A GESTAO, no mesmo navegador.
   *
   * Esta metade nao existia na primeira versao, e a falta dela quase repetiu o erro que criou
   * esta prova: eu media so a Operacao enquanto mudava o jeito de a GESTAO buscar o menu. Um
   * modulo que nao carrega la seria invisivel aqui.
   *
   * E o ponto e justamente o inverso do que a federacao supunha: a Gestao usa a MESMA aba, com
   * o MESMO localStorage, e a sessao da Operacao que ja esta nele.
   */
  const UNI = process.env.UNI || 'http://127.0.0.1:3100';
  const errosGestao = [];
  pagina.removeAllListeners('pageerror');
  pagina.on('pageerror', (e) => errosGestao.push('pageerror: ' + e.message));

  let gestao = { alcancou: false };
  try {
    await pagina.goto(UNI + '/gestao/dashboard', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise((s) => setTimeout(s, 3000));
    gestao = await pagina.evaluate(() => {
      const el = document.querySelector('loop-sidebar');
      const itens = el && el.shadowRoot
        ? [...el.shadowRoot.querySelectorAll('a.item')].map((a) => a.dataset.id)
        : [];
      return {
        alcancou: true,
        temBarra: !!el,
        temMenu: !!(el && el.menu),
        itens,
        lugar: (el && el.shadowRoot && (el.shadowRoot.querySelector('.lugar .nome') || {}).textContent) || null,
        corpo: document.body.innerText.trim().length,
      };
    });
  } catch (e) {
    gestao = { alcancou: false, erro: e.message };
  }

  console.log('');
  console.log('=== A GESTAO, no mesmo navegador ===');
  if (!gestao.alcancou) {
    console.log('  nao carregou: ' + gestao.erro);
  } else {
    console.log('  barra montada:  ' + gestao.temBarra);
    console.log('  recebeu o menu: ' + gestao.temMenu + '   <- SEM federacao, direto de /api/menu');
    console.log('  itens: ' + ((gestao.itens || []).join(', ') || '(nenhum)'));
    console.log('  cliente: ' + gestao.lugar);
    console.log('  texto na pagina: ' + gestao.corpo + ' caracteres');
  }
  if (errosGestao.length) {
    console.log('  ERROS:');
    for (const e of errosGestao.slice(0, 8)) console.log('    ' + e);
  }

  await navegador.close();

  const okOperacao = erros.length === 0 && (barra.itens || []).length > 0 && conteudo.tamanho > 200;
  const okGestao = gestao.alcancou && errosGestao.length === 0
    && gestao.temMenu && (gestao.itens || []).length > 0;

  console.log('');
  console.log('  Operacao: ' + (okOperacao ? 'ABRE' : 'NAO ABRE'));
  console.log('  Gestao:   ' + (okGestao ? 'ABRE' : 'NAO ABRE'));
  console.log('');
  console.log(okOperacao && okGestao ? 'A APLICACAO ABRE' : 'A APLICACAO NAO ABRE');
  process.exit(okOperacao && okGestao ? 0 : 1);
})().catch((e) => {
  console.log('a prova falhou antes de medir: ' + e.message);
  process.exit(2);
});
