/*
 * A CENTRAL DE AJUDA EM REACT ABRE, E É A MESMA — perguntado a um navegador com sessão.
 *
 * A primeira rota do FLIP reescrita (Etapa 9). As travas do jest já prendem o TEXTO (palavra por
 * palavra contra help.js) e a FORMA (sem legado, cabeçalho único). O que só um navegador responde:
 *
 *   a página passa o portão do AppShell e DESENHA — as travas leem fonte, não tela
 *   as regras de "quem vê" valem ao vivo: `activity` conforme o servidor, `layouts` conforme
 *   o localStorage.user — medidas pela mesma fonte, não por uma regra inventada aqui
 *   o legado NÃO montou junto: sem #toastContainer/#banners (Casco) e sem o CSS da casa velha
 *
 * Roda de /opt/novo-operacao/scripts/provas:
 *   docker run --rm --network host -v "$PWD:/p" -e TOKEN=... -e NODE_PATH=/usr/src/app/node_modules \
 *     --entrypoint node zenika/alpine-chrome:with-puppeteer /p/ajuda_nativa.js
 */
const puppeteer = require('puppeteer');

/*
 * COM o basePath. O app React vive em /gestao (NEXT_PUBLIC_BASE_PATH no build), e o proxy manda
 * todo o resto — inclusive /ajuda — para a casa velha. Ela é uma SPA de hash: responde QUALQUER
 * caminho com o casco dela, 200 e <title>Loop Player</title>, o que fez a primeira rodada desta
 * prova reprovar 10 de 14 numa página que não era a nossa. Um 200 não é a página certa.
 */
const UNI = process.env.UNI || 'https://beta.loopplayer.com.br/gestao';
const TOKEN = process.env.TOKEN || '';
const SAIDA = process.env.SAIDA || '/p';

const TITULOS = {
  display: 'Adicionar uma tela',
  upload: 'Enviar arquivos',
  playlist: 'Montar uma playlist',
  schedule: 'Agendar quando um arquivo aparece',
  activity: 'Ver quem mexeu no quê',
  layouts: 'Layouts com várias zonas',
};

(async () => {
  if (!TOKEN) { console.log('SEM SESSAO: passe TOKEN=...'); process.exit(1); }

  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const pagina = await navegador.newPage();
  await pagina.setViewport({ width: 1280, height: 900 });

  const erros = [];
  pagina.on('pageerror', (e) => erros.push('pageerror: ' + e.message.slice(0, 120)));
  pagina.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (m.text().includes('Failed to load resource')) return;   // o 4xx da API fala por si abaixo
    erros.push('console.error: ' + m.text().slice(0, 120));
  });
  const respostas5xx = [];
  pagina.on('response', (r) => { if (r.status() >= 500) respostas5xx.push(r.status() + ' ' + new URL(r.url()).pathname); });

  await pagina.evaluateOnNewDocument((tk) => {
    localStorage.setItem('token', tk);
    localStorage.setItem('loop_os_token', tk);
  }, TOKEN);

  await pagina.goto(UNI + '/ajuda', { waitUntil: 'networkidle0', timeout: 45000 });
  /* O portão do AppShell: os filhos só desenham depois da sessão. Espera o h1 nascer. */
  await pagina.waitForFunction(() => !!document.querySelector('h1'), { timeout: 20000, polling: 300 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));

  let falhas = 0;
  const conferir = (o_que, condicao, detalhe) => {
    console.log('  ' + (condicao ? 'ok    ' : 'FALHA ') + o_que + (detalhe ? '   ' + detalhe : ''));
    if (!condicao) falhas++;
  };

  const m = await pagina.evaluate(async (titulos) => {
    const texto = (document.body.innerText || '');
    const h1s = [...document.querySelectorAll('h1')].map((h) => h.textContent.trim());
    const guias = {};
    for (const [k, t] of Object.entries(titulos)) guias[k] = texto.includes(t);
    /* A FAQ: cada pergunta é um bloco com a pergunta em negrito. Conta pelas perguntas conhecidas. */
    const perguntas = ['Que aparelhos funcionam?', 'Quais formatos de vídeo posso enviar?', 'O que acontece se a internet cair?',
      'Posso usar a tela em pé?', 'Como o aplicativo se atualiza?', 'Publiquei e a tela não mudou. O que houve?'];
    const faq = perguntas.filter((p) => texto.includes(p)).length;
    /* As fontes das duas regras, medidas ao vivo. */
    let servidorDizDono = null;
    try {
      const r = await fetch('/api/activity/available', { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
      servidorDizDono = r.ok ? !!(await r.json()).available : false;
    } catch { servidorDizDono = false; }
    let usuarioGuardado = null;
    try { usuarioGuardado = JSON.parse(localStorage.getItem('user') || 'null'); } catch { usuarioGuardado = null; }
    const ehEquipe = !!(usuarioGuardado && (usuarioGuardado.role === 'platform_admin' || usuarioGuardado.role === 'superadmin'));
    /* O legado montou junto? */
    const casco = !!(document.querySelector('#toastContainer') || document.querySelector('#banners'));
    const cssVelho = [...document.querySelectorAll('style')].some((s) => /\.settings-section|--console-bg/.test(s.textContent || ''));
    const mailto = !!document.querySelector('a[href="mailto:contato@loopplayer.com.br"]');
    return { h1s, guias, faq, servidorDizDono, ehEquipe, casco, cssVelho, mailto, tamanho: texto.length };
  }, TITULOS);

  console.log('\n── a página ──');
  conferir('um h1 só, e é "Central de ajuda"', m.h1s.length === 1 && m.h1s[0] === 'Central de ajuda', JSON.stringify(m.h1s));
  conferir('a página desenhou (guarda contra tela vazia)', m.tamanho > 400, m.tamanho + ' caracteres');

  console.log('\n── os guias que todo mundo vê ──');
  for (const k of ['display', 'upload', 'playlist', 'schedule']) conferir('guia "' + TITULOS[k] + '"', m.guias[k]);

  console.log('\n── as duas regras, pela fonte de cada uma ──');
  conferir('"' + TITULOS.activity + '" aparece SE E SÓ SE o servidor diz dono',
    m.guias.activity === m.servidorDizDono, 'servidor: ' + m.servidorDizDono + ' | na tela: ' + m.guias.activity);
  conferir('"' + TITULOS.layouts + '" aparece SE E SÓ SE localStorage.user é da plataforma',
    m.guias.layouts === m.ehEquipe, 'equipe: ' + m.ehEquipe + ' | na tela: ' + m.guias.layouts);

  console.log('\n── a FAQ e o contato ──');
  conferir('as 6 perguntas estão na tela', m.faq === 6, m.faq + ' de 6');
  conferir('o mailto de contato existe', m.mailto);

  console.log('\n── o legado NÃO veio junto ──');
  conferir('sem #toastContainer/#banners (CascoOperacao)', !m.casco);
  conferir('sem o CSS da casa velha (EstiloOperacao)', !m.cssVelho);

  console.log('\n── erros ──');
  conferir('sem erro de JavaScript', erros.length === 0, erros.join(' | '));
  conferir('sem 5xx', respostas5xx.length === 0, respostas5xx.join(' | '));

  await pagina.screenshot({ path: SAIDA + '/ajuda-nativa.png', fullPage: true });
  await navegador.close();

  console.log('');
  if (falhas) { console.log(falhas + ' FALHA(S) na Central de ajuda'); process.exit(1); }
  console.log('A CENTRAL DE AJUDA EM REACT ESTA DE PE');
})().catch((e) => { console.error('A PROVA QUEBROU: ' + e.message); process.exit(2); });
