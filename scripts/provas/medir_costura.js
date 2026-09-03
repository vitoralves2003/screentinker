/*
 * ONDE A COSTURA AINDA APARECE — medida, nao opinada.
 *
 * O Vitor perguntou "quando os dois sistemas terao apenas uma cara?". A barra ja e uma so e o
 * menu ja e um so. O que resta e o INTERIOR das telas: as da Operacao sao JS+CSS hospedado
 * dentro do React (paridade por identidade, decisao dele em 01/09), e as da Gestao sao React
 * +Tailwind. Duas maos desenhando.
 *
 * Este script nao julga: ele LE os valores computados de tipografia, cor e espacamento nas duas
 * familias de tela e mostra onde elas discordam. E a diferenca que a pessoa sente ao trocar de
 * tela sem saber explicar por que.
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'http://127.0.0.1:3100';
const TOKEN = process.env.TOKEN || '';

/* Uma tela de cada familia. */
const TELAS = [
  { familia: 'Operacao (JS hospedado)', nome: 'Arquivos', caminho: '/gestao/arquivos' },
  { familia: 'Operacao (JS hospedado)', nome: 'Playlists', caminho: '/gestao/playlists' },
  { familia: 'Gestao (React nativo)', nome: 'Clientes', caminho: '/gestao/clientes' },
  { familia: 'Gestao (React nativo)', nome: 'Contratos', caminho: '/gestao/contratos' },
];

(async () => {
  if (!TOKEN) { console.log('SEM SESSAO'); process.exit(1); }

  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  for (const t of TELAS) {
    const pagina = await navegador.newPage();
    await pagina.setViewport({ width: 1440, height: 900 });
    await pagina.evaluateOnNewDocument((tk) => {
      localStorage.setItem('token', tk);
      localStorage.setItem('loop_os_token', tk);
    }, TOKEN);

    try {
      await pagina.goto(UNI + t.caminho, { waitUntil: 'networkidle0', timeout: 45000 });
      await new Promise((r) => setTimeout(r, 2500));

      const medida = await pagina.evaluate(() => {
        const visivel = (e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0;
        const conta = (sel) => {
          const m = new Map();
          for (const e of document.querySelectorAll(sel)) {
            if (!visivel(e)) continue;
            const c = getComputedStyle(e);
            const k = c.fontFamily.split(',')[0].replace(/["']/g, '') + ' ' + c.fontSize;
            m.set(k, (m.get(k) || 0) + 1);
          }
          return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
        };
        /* o primeiro botao de acao visivel: raio, altura, cor */
        const botao = [...document.querySelectorAll('button')].find(visivel);
        const b = botao ? getComputedStyle(botao) : null;
        const h1 = [...document.querySelectorAll('h1,h2')].find(visivel);
        const hh = h1 ? getComputedStyle(h1) : null;
        return {
          titulo: h1 ? { tamanho: hh.fontSize, peso: hh.fontWeight, familia: hh.fontFamily.split(',')[0].replace(/["']/g, '') } : null,
          textos: conta('p, td, span, label, div'),
          botao: b ? { raio: b.borderRadius, altura: b.height, fundo: b.backgroundColor, fonte: b.fontSize } : null,
          fundoDaPagina: getComputedStyle(document.body).backgroundColor,
        };
      });

      console.log('\n' + t.nome + '   [' + t.familia + ']');
      console.log('  titulo:  ' + JSON.stringify(medida.titulo));
      console.log('  botao:   ' + JSON.stringify(medida.botao));
      console.log('  fundo:   ' + medida.fundoDaPagina);
      console.log('  textos:  ' + medida.textos.map((x) => x[0] + ' x' + x[1]).join(' | '));
    } catch (e) {
      console.log('\n' + t.nome + ': FALHOU -> ' + e.message.slice(0, 80));
    }
    await pagina.close();
  }

  await navegador.close();
})();
