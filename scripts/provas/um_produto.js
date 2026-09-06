/*
 * UM PRODUTO SÓ — o censo de 06/09 virou prova permanente.
 *
 * A auditoria mediu ~35 telas e achou a casca igual (fonte, fundo, título, barra) e o resto
 * denunciando duas casas: "GESTÃO" na gaveta, inglês nos avisos, sete telas da casa velha com
 * dois menus, cinco cores de botão principal. Esta prova refaz a medição e reprova o que
 * voltar a divergir. Uma tela nova que desvie reprova aqui antes de o assinante ver.
 *
 * Num Chrome de 390px, com a sessão do assinante:
 *   1. em cada tela: fonte Geist, fundo da identidade, título "Loop Player", sem rolagem lateral
 *   2. todo botão com fundo verde da marca tem texto escuro; nenhum botão preto, azul ou índigo
 *   3. nenhuma palavra em inglês no texto visível
 *   4. a gaveta não nomeia o módulo
 *   5. as rotas da casa velha que morreram levam à casa nova; nas que ficaram, o cabeçalho antigo não aparece
 *   6. uma página inexistente tem a cara do produto
 *
 * Roda de /opt/novo-operacao/scripts/provas (ver provar_um_produto.sh).
 */
const puppeteer = require('puppeteer');

const BASE = process.env.BASE || 'https://beta.loopplayer.com.br';
const UNI = process.env.UNI || `${BASE}/gestao`;
const TOKEN = process.env.TOKEN || '';

const TELAS = ['/dashboard', '/telas', '/arquivos', '/playlists', '/layouts', '/widgets', '/clientes', '/contratos', '/financeiro', '/ajuda',
  ...['empresa', 'conta', 'atividade', 'assinatura', 'pessoas', 'servicos', 'implantacao', 'regua', 'integracoes'].map((a) => `/configuracoes?aba=${a}`)];
const FUNDO = 'rgb(246, 248, 247)';
const INGLES = /\b(Loading|Save|Cancel|Error|not found|Failed|Invalid|Toggle navigation|Access denied|Read-only)\b/;

let falhas = 0;
const ok = (m, x) => console.log(`  ok    ${m}${x !== undefined ? `   ${x}` : ''}`);
const falha = (m, x) => { falhas++; console.log(`  FALHA ${m}${x !== undefined ? `   ${x}` : ''}`); };
const afirmar = (c, m, x) => (c ? ok(m, x) : falha(m, x));
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const medir = () => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const cs = (e) => getComputedStyle(e);
  const rgb = (s) => { const m = s.match(/\d+/g); return m ? m.slice(0, 3).map(Number) : null; };
  const botoes = [...document.querySelectorAll('button, a[role="button"], a.botao')].filter(vis);
  const brancoSobreVerde = []; const foraDaPaleta = [];
  for (const b of botoes) {
    const s = cs(b); const bg = rgb(s.backgroundColor); const cor = rgb(s.color); const rotulo = (b.innerText || b.getAttribute('aria-label') || '').trim().slice(0, 24);
    if (!bg || s.backgroundColor === 'rgba(0, 0, 0, 0)') continue;
    const verdeDaMarca = bg[0] < 60 && bg[1] > 200 && bg[2] > 120 && bg[2] < 170;
    if (verdeDaMarca && cor && cor[0] > 200 && cor[1] > 200 && cor[2] > 200) brancoSobreVerde.push(rotulo);
    const preto = bg[0] < 40 && bg[1] < 40 && bg[2] < 40;
    const azulado = bg[2] > bg[0] + 40 && bg[2] > bg[1] + 20 && bg[2] > 120;
    if ((preto || azulado) && cor && cor[0] > 200) foraDaPaleta.push(`${rotulo} (${s.backgroundColor})`);
  }
  const texto = document.body.innerText || '';
  /* O regex vive aqui dentro: este trecho roda no navegador, longe das constantes do node. */
    const m = texto.match(/\b(Loading|Save|Cancel|Error|not found|Failed|Invalid|Toggle navigation|Access denied|Read-only)\b/);
  return {
    titulo: document.title, fonte: cs(document.body).fontFamily.split(',')[0].replace(/"/g, ''), fundo: cs(document.body).backgroundColor,
    largo: document.documentElement.scrollWidth > window.innerWidth + 2,
    brancoSobreVerde, foraDaPaleta, ingles: m ? texto.slice(Math.max(0, m.index - 20), m.index + 40).replace(/\s+/g, ' ') : null,
    casaVelha: !!document.querySelector('#mobileTopbar'),
    topbarVisivel: (() => { const t = document.querySelector('#mobileTopbar'); return t ? getComputedStyle(t).display !== 'none' : false; })(),
    temBarra: !!document.querySelector('loop-sidebar'),
  };
};

(async () => {
  if (!TOKEN) { console.log('SEM SESSAO: passe TOKEN=...'); process.exit(1); }
  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await navegador.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(`${UNI}/ajuda`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('token', t), TOKEN);

  console.log('======== 1-3. cada tela: casca, botões e palavras ========');
  for (const rota of TELAS) {
    try { await page.goto(`${UNI}${rota}`, { waitUntil: 'networkidle0', timeout: 60000 }); } catch (e) { falha(`${rota} abre`, e.message.slice(0, 60)); continue; }
    await esperar(1200);
    const m = await page.evaluate(medir);
    const problemas = [];
    if (!/^Geist/.test(m.fonte)) problemas.push(`fonte=${m.fonte}`);
    if (m.fundo !== FUNDO) problemas.push(`fundo=${m.fundo}`);
    if (m.titulo !== 'Loop Player') problemas.push(`título=${m.titulo}`);
    if (m.largo) problemas.push('rola de lado');
    if (m.brancoSobreVerde.length) problemas.push(`branco sobre verde: ${m.brancoSobreVerde.join(', ')}`);
    if (m.foraDaPaleta.length) problemas.push(`botão fora da paleta: ${m.foraDaPaleta.join(', ')}`);
    if (m.ingles) problemas.push(`inglês: "${m.ingles}"`);
    if (!m.temBarra) problemas.push('sem a barra');
    afirmar(problemas.length === 0, rota, problemas.join(' | ') || undefined);
  }

  console.log('======== 4. a gaveta não nomeia o módulo ========');
  await page.goto(`${UNI}/telas`, { waitUntil: 'networkidle0', timeout: 60000 });
  await esperar(1000);
  const secoes = await page.evaluate(() => {
    const sr = document.querySelector('loop-sidebar').shadowRoot;
    const menu = sr.querySelector('.inferior .menu'); if (menu) menu.click();
    return [...sr.querySelectorAll('.secao')].map((s) => s.textContent.trim());
  });
  afirmar(!secoes.some((s) => /gest[ãa]o|opera[çc][ãa]o/i.test(s)), 'nenhuma seção da gaveta se chama Gestão ou Operação', secoes.join(' | ') || '(sem títulos)');
  await page.keyboard.press('Escape');

  console.log('======== 5. a casa velha ========');
  for (const [rota, esperado] of [['/app#/widgets', '/gestao/widgets'], ['/app#/walls', '/gestao/'], ['/app#/teams', '/gestao/'], ['/app#/reports', '/gestao/'], ['/app#/onboarding', '/gestao/']]) {
    await page.goto(`${BASE}${rota}`, { waitUntil: 'networkidle0', timeout: 60000 }).catch(() => {});
    await esperar(2500);
    const onde = page.url().replace(BASE, '');
    afirmar(onde.startsWith(esperado), `${rota} leva à casa nova`, onde);
  }
  for (const rota of ['/app#/designer', '/app#/admin']) {
    await page.goto(`${BASE}${rota}`, { waitUntil: 'networkidle0', timeout: 60000 }).catch(() => {});
    await esperar(2000);
    const m = await page.evaluate(medir);
    afirmar(m.temBarra && !m.topbarVisivel, `${rota}: a barra do produto está lá e o cabeçalho antigo não aparece`, `barra=${m.temBarra} topbar=${m.topbarVisivel}`);
    afirmar(!m.ingles, `${rota}: sem inglês no texto`, m.ingles || undefined);
  }

  console.log('======== 6. a página que não existe ========');
  await page.goto(`${UNI}/uma-pagina-que-nao-existe`, { waitUntil: 'networkidle0', timeout: 60000 }).catch(() => {});
  const q = await page.evaluate(() => ({ texto: document.body.innerText || '', fundo: getComputedStyle(document.body).backgroundColor, fonte: getComputedStyle(document.body).fontFamily.split(',')[0] }));
  afirmar(/Esta página não existe/.test(q.texto) && /Ir para o início/.test(q.texto), 'o 404 tem a cara do produto e uma porta de volta', q.texto.slice(0, 80).replace(/\s+/g, ' '));

  await navegador.close();
  console.log('');
  if (falhas) { console.log(`${falhas} FALHA(S): ainda parece dois produtos em algum lugar`); process.exit(1); }
  console.log('TUDO OK: um produto só');
})().catch((e) => { console.error('A PROVA QUEBROU: ' + e.message); process.exit(2); });
