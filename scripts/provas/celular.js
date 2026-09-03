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

/* Um iPhone comum. 390x844 é o tamanho de tela mais frequente hoje, e foi o do Vitor. */
const CELULAR = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };

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
    const r = el.getBoundingClientRect();
    const botao = el.shadowRoot && el.shadowRoot.querySelector('.abrir');
    const bs = botao ? getComputedStyle(botao) : null;
    const br = botao ? botao.getBoundingClientRect() : null;
    return {
      largura: Math.round(r.width),
      esquerda: Math.round(r.left),
      aberta: el.hasAttribute('aberta'),
      temBotao: !!botao,
      botaoVisivel: bs ? bs.display !== 'none' : false,
      botaoAlvo: br ? Math.round(Math.min(br.width, br.height)) : 0,
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

      conferir('a barra tem porta (botão de abrir)', b.temBotao && b.botaoVisivel);
      conferir('o alvo de toque tem 44px', b.botaoAlvo >= 44, b.botaoAlvo + 'px');

      /* Abre pelo botão, confere que entrou; fecha pelo véu, confere que saiu. */
      if (b.temBotao) {
        await pagina.evaluate(() => document.querySelector('loop-sidebar').shadowRoot.querySelector('.abrir').click());
        await new Promise((r) => setTimeout(r, 600));
        const aberta = await barra(pagina);
        conferir('o botão abre a barra', aberta.aberta && aberta.esquerda >= 0, 'left ' + aberta.esquerda);

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

  await navegador.close();
  console.log(falhou ? '\nFALHOU ' + falhou : '\nO CELULAR ESTA BEM');
  process.exit(falhou ? 1 : 0);
})();
