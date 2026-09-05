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
  /*
   * As duas do portal entram aqui porque são as MAIS prováveis de serem abertas no telefone.
   * As outras quatro são o assento de quem trabalha sentado; o portal é do dono da padaria
   * mandando o vídeo da promoção do celular dele, e a fila é de quem decide entre uma coisa e
   * outra, também do celular. Um layout conferido só no tamanho em que foi desenhado não está
   * conferido -- e estas duas nascem depois da lição de 03/09, sem desculpa para repeti-la.
   *
   * ── por que a do portal é a ENTRADA, e por que ela é `semBarra` (05/09) ─────────────────────
   * O portal ganhou porta própria, e duas coisas mudaram aqui de uma vez.
   *
   * O caminho: `/gestao/portal` sem sessão de portal manda para `/portal/entrar`. Esta prova só
   * tem a sessão do ASSINANTE — que o portal recusa — então pedir a tela de dentro mediria, na
   * prática, a de fora, com asserções escritas para a de dentro. Pedi-la direto é honesto: a
   * entrada é a primeira tela que o anunciante vê, e ele a vê no telefone.
   *
   * A marca: o portal NÃO desenha a barra do produto, e isso é desenho, não falta. `PortalShell`
   * explica o motivo — a barra do assinante na frente de gente de fora mostraria a lista do que
   * existe na casa de quem o atende. Sem esta marca, a prova exigiria `<loop-sidebar>` e
   * reprovaria a decisão como se fosse defeito.
   */
  { nome: 'Portal — entrada (anunciante)', caminho: '/gestao/portal/entrar', semBarra: true },
  { nome: 'Aprovações (assinante)', caminho: '/gestao/aprovacoes' },
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

      const b = t.semBarra ? null : await barra(pagina);
      if (!t.semBarra && !b) { conferir('a barra existe', false, 'nao achei <loop-sidebar>'); await pagina.close(); continue; }

      /*
       * A trava do outro lado da marca: se a barra do produto APARECER numa tela declarada sem
       * ela, alguém a colocou sem querer — e o portal passaria a mostrar ao anunciante a lista
       * do que existe na casa de quem o atende. `semBarra` afirma uma decisão; sem esta linha
       * ela só dispensaria asserções.
       */
      if (t.semBarra) {
        const apareceu = await pagina.evaluate(() => !!document.querySelector('loop-sidebar'));
        conferir('segue SEM a barra do produto, como o desenho manda', !apareceu);
      }

      /*
       * A BARRA NÃO PODE COMER A TELA. Fechada, ela fica fora da viewport (left negativo) ou
       * some — o que não pode é ficar ocupando largura ao lado do conteúdo num aparelho de
       * 390px. Foi exatamente isso que o Vitor fotografou.
       */
      if (b) {
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

      /*
       * O conteúdo tem espaço de verdade: pelo menos 80% da largura do aparelho.
       *
       * `form` entrou na fila em 05/09, antes do `body`. A entrada do portal não tem `<main>` —
       * é um cartão centralizado — e a queda para `body` media a viewport contra ela mesma:
       * 390 de 390, verde sempre, sobre um cartão que poderia estar espremido a 120px.
       */
      const conteudo = await pagina.evaluate(() => {
        const m = document.querySelector('main') || document.querySelector('form') || document.body;
        return Math.round(m.getBoundingClientRect().width);
      });
      conferir('o conteúdo ocupa a tela', conteudo >= CELULAR.width * 0.8,
        conteudo + 'px de ' + CELULAR.width + 'px');

      /*
       * E DEPOIS DE ROLAR ATE O FIM. Foi assim que o Vitor achou o defeito: a barra inferior
       * subia para o meio da pagina no fim da rolagem, com area em branco embaixo. Todas as
       * asercoes acima mediam a pagina PARADA no topo -- e no topo estava tudo certo.
       *
       * Uma barra que so e conferida antes de rolar nao esta conferida: rolar e o que a
       * pessoa faz.
       */
      await pagina.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await new Promise((r) => setTimeout(r, 1200));
      if (!t.semBarra) {
        const depoisDeRolar = await barra(pagina);
        conferir('a barra inferior continua colada no fundo depois de rolar',
          depoisDeRolar.barraNaTela, JSON.stringify(depoisDeRolar.barraNaTela));
        const grudada = await pagina.evaluate(() => {
          const inf = document.querySelector('loop-sidebar').shadowRoot.querySelector('.inferior');
          const r = inf.getBoundingClientRect();
          return Math.round(window.innerHeight - r.bottom);
        });
        conferir('ela toca a borda de baixo (sem sobra)', Math.abs(grudada) <= 2,
          grudada + 'px de sobra abaixo dela');
      } else {
        /* Sem barra, o que a rolagem tem de provar é que nada passou da borda depois dela — o
           transbordo medido só no topo não está medido. */
        const depois = await pagina.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          cliente: document.documentElement.clientWidth,
        }));
        conferir('nada transborda depois de rolar', depois.scroll <= depois.cliente + 2,
          depois.scroll + 'px em ' + depois.cliente + 'px');
      }
    } catch (e) {
      conferir('a tela abre', false, e.message.slice(0, 70));
    }
    await pagina.close();
  }

  /*
   * E NO MENOR APARELHO QUE AINDA PRECISA SERVIR.
   *
   * Aqui a exigencia MUDA, e vale dizer por que em vez de repetir a de cima. Em 560px de
   * altura util nao cabem 11 destinos mais logo, organizacao, aviso e rodape -- medido:
   * sobram 200px para uma lista que precisa de 308. Espremer o resto ate caber deixaria os
   * alvos de toque abaixo dos 44px, que e trocar um incomodo por um defeito.
   *
   * Entao no aparelho pequeno a lista PODE rolar, e o que se afirma e que a rolagem seja
   * boa: que ela seja da LISTA e nao da pagina, e que o rodape (Configuracoes, Ajuda, sair)
   * continue alcancavel sem rolar ate o fim. Foi isso que faltou na versao que o Vitor
   * fotografou -- o item cortado pela metade contra uma borda.
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
    const detalhe = await pagina.evaluate(() => {
      const sr = document.querySelector('loop-sidebar').shadowRoot;
      const lista = sr.querySelector('.lista');
      const rodape = sr.querySelector('.rodape');
      const rr = rodape.getBoundingClientRect();
      /*
       * A PÁGINA ROLA? — a pergunta certa levou três tentativas, e cada erro ensinou uma coisa.
       *
       * 1. `scrollHeight > clientHeight` mede se o CONTEÚDO é mais alto que a tela, não se a
       *    página se move. Respondia "rola" para uma página travada.
       * 2. `window.scrollTo` ATRAVESSA `overflow: hidden` — rolagem programática não é o gesto,
       *    e continuava respondendo "rola" com a trava funcionando.
       *
       * A pergunta honesta é: com a gaveta aberta, a página está PRESA no lugar? Quando ela está,
       * o corpo é `position: fixed` — que é a única forma que segura o dedo no Safari do iOS, e
       * é observável. O arraste de verdade é medido fora, com o toque do puppeteer.
       */
      const corpo = getComputedStyle(document.body);

      return {
        listaRolaSozinha: getComputedStyle(lista).overflowY !== 'visible',
        rodapeVisivel: rr.top >= 0 && rr.bottom <= window.innerHeight + 1,
        paginaPresa: corpo.position === 'fixed' || corpo.overflow === 'hidden',
      };
    });

    /*
     * E O ARRASTE DE VERDADE, com o dedo do navegador: é o que a pessoa faz, e a única medida
     * que não se engana com propriedade de CSS.
     */
    const rolagemAntes = await pagina.evaluate(() => window.scrollY);
    await pagina.touchscreen.touchStart(190, 400);
    await pagina.touchscreen.touchMove(190, 180);
    await pagina.touchscreen.touchMove(190, 60);
    await pagina.touchscreen.touchEnd();
    await new Promise((r) => setTimeout(r, 400));
    const rolagemDepois = await pagina.evaluate(() => window.scrollY);
    detalhe.oDedoMoveuAPagina = Math.abs(rolagemDepois - rolagemAntes) > 4;
    conferir('a rolagem é da lista, não da página',
      detalhe.listaRolaSozinha && detalhe.paginaPresa && !detalhe.oDedoMoveuAPagina);
    conferir('o rodapé continua alcançável sem rolar', detalhe.rodapeVisivel);
    conferir('a gaveta mostra os destinos que sobraram', b2.itensNaGaveta > 0,
      b2.itensNaGaveta + ' itens');
    await pagina.close();
  }
  await navegador.close();
  console.log(falhou ? '\nFALHOU ' + falhou : '\nO CELULAR ESTA BEM');
  process.exit(falhou ? 1 : 0);
})();
