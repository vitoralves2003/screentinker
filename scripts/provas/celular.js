/*
 * O PRODUTO NUM CELULAR — medido, nos dois módulos.
 *
 * ── POR QUE ISTO EXISTE ──────────────────────────────────────────────────────────────────
 * O Vitor abriu o sistema no telefone em 03/09 e mandou quatro capturas. A barra ocupava 60%
 * da tela, o conteúdo vivia numa coluna de 158px com o texto quebrando de duas em duas
 * palavras, e a tabela saía cortada pela borda.
 *
 * Nenhuma prova pegou porque TODAS rodavam em 1440x900. Um layout que só é conferido no
 * tamanho em que foi desenhado não está conferido — está confirmado.
 *
 * ── O QUE ELA AFIRMA, E POR QUE CADA UMA ─────────────────────────────────────────────────
 *   a barra não come a tela      com a gaveta fechada, o conteúdo tem a largura inteira
 *   há como abrir a barra        uma gaveta sem porta é pior que uma barra larga: o menu some
 *   a barra abre e fecha         o botão traz, o véu leva
 *   nada transborda              scrollWidth > clientWidth é conteúdo cortado pela borda
 *   o alvo de toque tem 44px     abaixo disso o dedo erra, e errar num menu é sair da página
 *
 * ── COMO RODA ────────────────────────────────────────────────────────────────────────────
 *   docker run --rm --network host --entrypoint node \
 *     -e NODE_PATH=/usr/src/app/node_modules -e TOKEN=... \
 *     -e UNI=https://beta.loopplayer.com.br \
 *     -v /opt/novo-operacao/scripts/provas:/p \
 *     zenika/alpine-chrome:with-puppeteer /p/celular.js
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'http://127.0.0.1:3100';
const TOKEN = process.env.TOKEN || '';

/*
 * A ALTURA E A DO NAVEGADOR, NAO A DA TELA — e foi essa diferenca que deixou o defeito passar.
 *
 * A primeira versao usava 844px, a altura do painel de um iPhone atual. Deu tudo verde, e o
 * Vitor fotografou "Mensagens" cortado assim mesmo: o Safari do iPhone come ~130px com as
 * proprias barras (endereco em cima, navegacao embaixo), entao o que a pagina recebe fica
 * perto de 700. Medir na altura do HARDWARE e medir uma tela que ninguem tem.
 *
 * 700 e o pior caso comum de um aparelho grande. O SE, menor ainda, aparece logo abaixo.
 */
const CELULAR = { width: 390, height: 700, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };

/* O iPhone SE com o Safari: o menor alvo real que o produto precisa servir. */
const CELULAR_PEQUENO = { width: 375, height: 560, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

const TELAS = [
  { nome: 'Telas (Operação)', caminho: '/gestao/telas' },
  { nome: 'Arquivos (Operação)', caminho: '/gestao/arquivos' },
  { nome: 'Clientes (Gestão)', caminho: '/gestao/clientes' },
  { nome: 'Contratos (Gestão)', caminho: '/gestao/contratos' },
];

let falhou = 0;
function conferir(nome, ok, detalhe) {
  if (ok) console.log('    ok    ' + nome);
  else { falhou++; console.log('    FALHA ' + nome + (detalhe ? '  -> ' + detalhe : '')); }
}

/* A barra é um web component com Shadow DOM: o querySelector normal não a atravessa. */
async function barra(pagina) {
  return pagina.evaluate(() => {
    const el = document.querySelector('loop-sidebar');
    if (!el) return null;
    /* Quem desliza e o <nav>; o host cobre a viewport sem receber toque (ver loop-sidebar.js). */
    const painel = (el.shadowRoot && el.shadowRoot.querySelector('nav')) || el;
    const r = painel.getBoundingClientRect();
    const inferior = el.shadowRoot && el.shadowRoot.querySelector('.inferior');
    const ir = inferior ? inferior.getBoundingClientRect() : null;
    const is = inferior ? getComputedStyle(inferior) : null;
    const botaoMenu = el.shadowRoot && el.shadowRoot.querySelector('.inferior .menu');
    const br = botaoMenu ? botaoMenu.getBoundingClientRect() : null;
    const atalhos = el.shadowRoot ? el.shadowRoot.querySelectorAll('.inferior a').length : 0;
    const lista = el.shadowRoot && el.shadowRoot.querySelector('.lista');
    /* Com a gaveta aberta, o que ela mostra tem de caber: scrollHeight maior que a altura
       visivel e a rolagem que o Vitor reprovou. */
    const listaRola = lista ? (lista.scrollHeight > Math.ceil(lista.getBoundingClientRect().height) + 2) : false;
    const itensNaGaveta = el.shadowRoot
      ? [...el.shadowRoot.querySelectorAll('.lista a.item')].filter((a) => a.offsetParent !== null).length
      : 0;
    return {
      largura: Math.round(r.width),
      esquerda: Math.round(r.left),
      aberta: el.hasAttribute('aberta'),
      temBarra: !!inferior && is.display !== 'none',
      atalhos,
      /*
       * DENTRO DA TELA, e não só "visível". A primeira versão desta prova perguntava
       * display !== 'none' e o tamanho do alvo — e deu ok para um botão em x = -220px, que
       * estava tecnicamente visível e fora do aparelho. Foi o Vitor quem viu, não ela.
       */
      menuNaTela: br ? (br.left >= 0 && br.right <= window.innerWidth
        && br.top >= 0 && br.bottom <= window.innerHeight + 1) : false,
      menuAlvo: br ? Math.round(Math.min(br.width, br.height)) : 0,
      barraNaTela: ir ? (ir.bottom <= window.innerHeight + 1 && ir.left >= 0) : false,
      listaRola,
      itensNaGaveta,
    };
  });
}

(async () => {
  if (!TOKEN) { console.log('SEM SESSAO: passe TOKEN=...'); process.exit(1); }

  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  for (const t of TELAS) {
    console.log('\n  ' + t.nome);
    const pagina = await navegador.newPage();
    await pagina.setViewport(CELULAR);
    await pagina.evaluateOnNewDocument((tk) => {
      localStorage.setItem('token', tk);
      localStorage.setItem('loop_os_token', tk);
    }, TOKEN);

    try {
      await pagina.goto(UNI + t.caminho, { waitUntil: 'networkidle0', timeout: 45000 });
      await new Promise((r) => setTimeout(r, 3000));

      const b = await barra(pagina);
      if (!b) { conferir('a barra existe', false, 'nao achei <loop-sidebar>'); await pagina.close(); continue; }

      /*
       * A BARRA NÃO PODE COMER A TELA. Fechada, ela fica fora da viewport (left negativo) ou
       * some — o que não pode é ficar ocupando largura ao lado do conteúdo num aparelho de
       * 390px. Foi exatamente isso que o Vitor fotografou.
       */
      const forada = b.esquerda + b.largura <= 1 || b.largura === 0;
      conferir('a barra sai da frente quando fechada', b.aberta || forada,
        'largura ' + b.largura + 'px, left ' + b.esquerda + 'px');

      conferir('há barra inferior com atalhos', b.temBarra && b.atalhos > 0,
        b.atalhos + ' atalhos');
      conferir('a barra inferior está DENTRO da tela', b.barraNaTela);
      conferir('o botão Menu está DENTRO da tela', b.menuNaTela);
      conferir('o alvo de toque tem 44px', b.menuAlvo >= 44, b.menuAlvo + 'px');

      /* Abre pelo Menu, confere que entrou; fecha pelo véu, confere que saiu. */
      if (b.temBarra) {
        await pagina.evaluate(() => document.querySelector('loop-sidebar').shadowRoot.querySelector('.inferior .menu').click());
        await new Promise((r) => setTimeout(r, 600));
        const aberta = await barra(pagina);
        conferir('o Menu abre a gaveta', aberta.aberta);
        /*
         * A GAVETA NAO ROLA. Com os quatro atalhos fora dela, o que sobra tem de caber na
         * altura do aparelho -- foi a reclamacao do Vitor: "ha uma rolagem para ver tudo o
         * que esta nela. Nao gostei disso."
         */
        conferir('a gaveta cabe sem rolar', !aberta.listaRola,
          aberta.itensNaGaveta + ' itens visiveis');
        conferir('a gaveta nao repete os atalhos de baixo', aberta.itensNaGaveta > 0
          && aberta.itensNaGaveta < 9, aberta.itensNaGaveta + ' itens (eram 9)');

        await pagina.evaluate(() => document.querySelector('loop-sidebar').shadowRoot.querySelector('.veu').click());
        await new Promise((r) => setTimeout(r, 600));
        const fechada = await barra(pagina);
        conferir('o véu fecha a barra', !fechada.aberta);
      }

      /*
       * NADA TRANSBORDA. scrollWidth maior que clientWidth é conteúdo passando da borda — a
       * tabela cortada das capturas. Uma folga de 2px absorve arredondamento de subpixel.
       */
      const transbordo = await pagina.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        cliente: document.documentElement.clientWidth,
      }));
      conferir('a página não rola para o lado',
        transbordo.scroll <= transbordo.cliente + 2,
        transbordo.scroll + 'px de conteúdo em ' + transbordo.cliente + 'px de tela');

      /* O conteúdo tem espaço de verdade: pelo menos 80% da largura do aparelho. */
      const conteudo = await pagina.evaluate(() => {
        const m = document.querySelector('main') || document.body;
        return Math.round(m.getBoundingClientRect().width);
      });
      conferir('o conteúdo ocupa a tela', conteudo >= CELULAR.width * 0.8,
        conteudo + 'px de ' + CELULAR.width + 'px');
    } catch (e) {
      conferir('a tela abre', false, e.message.slice(0, 70));
    }
    await pagina.close();
  }

  /*
   * E NO MENOR APARELHO QUE AINDA PRECISA SERVIR. A gaveta e o unico lugar onde a altura
   * aperta de verdade, entao so ela e refeita aqui -- o resto ja foi conferido acima.
   */
  console.log('\n  iPhone SE (375x560) — a gaveta');
  {
    const pagina = await navegador.newPage();
    await pagina.setViewport(CELULAR_PEQUENO);
    await pagina.evaluateOnNewDocument((tk) => {
      localStorage.setItem('token', tk);
      localStorage.setItem('loop_os_token', tk);
    }, TOKEN);
    await pagina.goto(UNI + '/gestao/clientes', { waitUntil: 'networkidle0', timeout: 45000 });
    await new Promise((r) => setTimeout(r, 3000));
    await pagina.evaluate(() => document.querySelector('loop-sidebar').shadowRoot.querySelector('.inferior .menu').click());
    await new Promise((r) => setTimeout(r, 700));
    const b2 = await barra(pagina);
    conferir('a gaveta cabe sem rolar no aparelho pequeno', !b2.listaRola,
      b2.itensNaGaveta + ' itens');
    await pagina.close();
  }
  await navegador.close();
  console.log(falhou ? '\nFALHOU ' + falhou : '\nO CELULAR ESTA BEM');
  process.exit(falhou ? 1 : 0);
})();
