/*
 * A ROLAGEM NO CELULAR, e o que o Vitor viu no iPhone (06/09).
 *
 * Três reclamações, três medidas:
 *   1. "as páginas não rolam e não vejo o que está abaixo" — para cada página de lista, num
 *      viewport de telefone COM as barras do navegador (390x660): ou o conteúdo cabe, ou a
 *      página aceita rolar até o fim e o último cartão termina ACIMA da barra inferior.
 *   2. "em Contratos não aparece o número e não consigo entrar" — o cartão tem link para o
 *      detalhe e mostra o número.
 *   3. "tire as mídias sendo exibidas na página de Telas" — nenhum cartão tem a barrinha.
 *
 * O que esta prova NÃO alcança: o WebKit do iPhone. O Chrome emula o tamanho e o toque, não
 * o motor. Uma rolagem que passa aqui e trava lá é possível — foi o que aconteceu — e por
 * isso a medida em WebKit de verdade vive em `diag_webkit.js`, fora do Chrome.
 *
 *   docker run --rm --network host --user root -v "$PWD:/p" -e TOKEN=<assinante> \
 *     -e NODE_PATH=/usr/src/app/node_modules --entrypoint node \
 *     zenika/alpine-chrome:with-puppeteer /p/rolagem_no_celular.js
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'https://beta.loopplayer.com.br/gestao';
const TOKEN = process.env.TOKEN || '';
const PAGINAS = ['/contratos', '/telas', '/clientes', '/arquivos', '/playlists', '/dashboard'];

let falhas = 0;
const ok = (m, x) => console.log(`  ok    ${m}${x !== undefined ? `   ${x}` : ''}`);
const falha = (m, x) => { falhas++; console.log(`  FALHA ${m}${x !== undefined ? `   ${x}` : ''}`); };
const afirmar = (c, m, x) => (c ? ok(m, x) : falha(m, x));
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!TOKEN) { console.log('SEM SESSAO: passe TOKEN=...'); process.exit(1); }
  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await navegador.newPage();
  await page.setViewport({ width: 390, height: 660, isMobile: true, hasTouch: true });
  await page.goto(`${UNI}/entrar`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('token', t), TOKEN);

  for (const rota of PAGINAS) {
    console.log(`======== ${rota} ========`);
    await page.goto(`${UNI}${rota}`, { waitUntil: 'networkidle0', timeout: 60000 });
    await esperar(1200);
    const medida = await page.evaluate(() => {
      const docH = document.documentElement.scrollHeight;
      const inner = window.innerHeight;
      window.scrollTo(0, 999999);
      const scrollY = window.scrollY;
      const barra = document.querySelector('loop-sidebar');
      const inf = barra && barra.shadowRoot ? barra.shadowRoot.querySelector('.inferior') : null;
      const barraTop = inf ? inf.getBoundingClientRect().top : inner;
      const cartoes = [...document.querySelectorAll('tbody tr, [data-cartao], main section, main > div > div')];
      const ultimo = cartoes.length ? cartoes[cartoes.length - 1].getBoundingClientRect() : null;
      const mainRect = document.querySelector('main') ? document.querySelector('main').getBoundingClientRect() : null;
      return { docH, inner, scrollY, maxScroll: docH - inner, barraTop: Math.round(barraTop), fimDoMain: mainRect ? Math.round(mainRect.bottom) : null, ultimoBottom: ultimo ? Math.round(ultimo.bottom) : null, largura: document.documentElement.scrollWidth };
    });
    afirmar(medida.largura <= 390, 'a página não rola de lado', medida.largura);
    if (medida.maxScroll <= 0) {
      ok('o conteúdo cabe na tela sem rolar', `documento=${medida.docH} tela=${medida.inner}`);
    } else {
      afirmar(medida.scrollY >= medida.maxScroll - 1, 'a página aceita rolar até o fim', `rolou ${medida.scrollY} de ${medida.maxScroll}`);
      /* A barra inferior se esconde ao rolar para baixo e volta ao rolar para cima (06/09). */
      if (medida.maxScroll >= 60) {
        await esperar(350);
        const escondida = await page.evaluate(() => document.querySelector('loop-sidebar')?.hasAttribute('escondida'));
        afirmar(escondida === true, 'a barra inferior se escondeu ao rolar para baixo');
        await page.evaluate(() => window.scrollBy(0, -40));
        await esperar(350);
        const voltou = await page.evaluate(() => !document.querySelector('loop-sidebar')?.hasAttribute('escondida'));
        afirmar(voltou, 'e voltou ao rolar para cima');
        await page.evaluate(() => window.scrollTo(0, 999999));
        await esperar(200);
      }
    }
    /* O fim do <main> (com a folga da barra) tem de ficar acima da barra inferior depois de rolar tudo. */
    afirmar(medida.fimDoMain === null || medida.fimDoMain <= medida.inner + 1, 'o fim da página fica dentro da tela depois de rolar', `main termina em ${medida.fimDoMain}, tela ${medida.inner}`);
    afirmar(medida.ultimoBottom === null || medida.ultimoBottom <= medida.barraTop, 'o último cartão termina ACIMA da barra inferior', `cartão ${medida.ultimoBottom}, barra ${medida.barraTop}`);

    if (rota === '/contratos') {
      const cartao = await page.evaluate(() => {
        const tr = document.querySelector('tbody tr');
        if (!tr) return null;
        const link = tr.querySelector('td[data-principal] a[href*="/contratos/"]');
        const numero = tr.querySelector('td[data-principal] span');
        const visivel = (e) => !!e && getComputedStyle(e).display !== 'none';
        return { temLink: !!link, linkVisivel: visivel(link), numero: numero ? numero.innerText.trim() : null, numeroVisivel: visivel(numero), texto: tr.innerText.replace(/\n/g, ' | ').slice(0, 80) };
      });
      afirmar(!!cartao && cartao.temLink && cartao.linkVisivel, 'o cartão do contrato tem link para o detalhe pelo nome', cartao && cartao.texto);
      afirmar(!!cartao && cartao.numeroVisivel && /^(#\S+|Rascunho)$/.test(cartao.numero || ''), 'e mostra o número (ou "Rascunho") ao lado do nome', cartao && cartao.numero);
    }
    if (rota === '/telas') {
      const barrinha = await page.evaluate(() => !!document.querySelector('.transition-\\[width\\]') || /\d+s$/m.test((document.querySelector('tbody') || document.body).innerText.split('\n').find((l) => /\.mp4|\.png|\.jpg/.test(l)) || ''));
      afirmar(!barrinha, 'nenhum cartão de tela mostra a mídia tocando com barrinha');
    }
  }

  /* O DETALHE DO CONTRATO no telefone (06/09): cabeçalho na régua, ações dentro da tela, abas
     alcançáveis, "Próximo passo" e nada saindo de lado. Pega o primeiro contrato da conta. */
  console.log('======== /contratos/<id> ========');
  const contratos = await page.evaluate(async (t) => {
    const r = await fetch('/gestao-api/contracts', { headers: { Authorization: `Bearer ${t}` } });
    if (!r.ok) return null;
    const j = await r.json();
    const lista = Array.isArray(j) ? j : (j.items || j.data || []);
    return lista.map((c) => ({ id: c.id, status: c.status }));
  }, TOKEN);
  if (!contratos || !contratos.length) {
    console.log('  (sem contrato na conta: o detalhe não foi conferido)');
  } else {
    const alvo = contratos.find((c) => c.status !== 'DRAFT') || contratos[0];
    await page.goto(`${UNI}/contratos/${alvo.id}`, { waitUntil: 'networkidle0', timeout: 60000 });
    await esperar(1500);
    const d = await page.evaluate(() => {
      const cab = document.querySelector('[data-cabecalho-do-contrato]');
      const acoes = document.querySelector('[data-acoes-do-contrato]');
      const abas = document.querySelector('[data-abas-do-contrato]');
      const r = (e) => (e ? e.getBoundingClientRect() : null);
      return {
        temCabecalho: !!cab, status: cab && cab.getAttribute('data-status'),
        titulo: (document.querySelector('h1') || {}).innerText || '',
        acoesDentro: !acoes || r(acoes).right <= window.innerWidth + 1,
        temEditar: [...document.querySelectorAll('button, a')].some((b) => /^\s*Editar\s*$/.test(b.innerText || '')),
        abas: abas ? [...abas.querySelectorAll('[data-aba]')].map((a) => a.innerText.trim()) : [],
        proximoPasso: !!document.querySelector('[data-proximo-passo]'),
        largura: document.documentElement.scrollWidth,
      };
    });
    afirmar(d.temCabecalho, 'o cabeçalho é o da casa', d.titulo);
    afirmar(/^Contrato \d+|^Rascunho de contrato/.test(d.titulo), 'o título diz "Contrato <número>" (sem caixa alta)', d.titulo);
    afirmar(d.acoesDentro, 'as ações ficam dentro da tela');
    afirmar(d.status === 'DRAFT' || !d.temEditar, 'não há "Editar" fora do rascunho', d.status);
    afirmar(d.abas.includes('Mídias') && d.abas.includes('Histórico'), 'as abas têm acento e estão todas lá', d.abas.join(' | '));
    afirmar(d.proximoPasso || d.status === 'CANCELLED', 'o Resumo diz o próximo passo', d.status);
    afirmar(d.largura <= 390, 'a página não rola de lado', d.largura);
  }

  await navegador.close();
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTUDO OK');
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.log('ERRO ' + (e && e.message || e)); process.exit(1); });
