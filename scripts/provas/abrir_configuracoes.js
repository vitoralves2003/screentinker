/*
 * A ABA PEDIDA ABRE? -- perguntado num navegador, nos dois modulos.
 *
 * ── POR QUE ISTO EXISTE ──────────────────────────────────────────────────────────────────
 * `provar_configuracoes.sh` tem 351 linhas e todas perguntam QUEM VE O QUE: papel, plano, quem e
 * dono. Nenhuma perguntava para ONDE a aba leva. Ela ficou verde em todas as rodadas enquanto
 * seis abas apontavam para o mesmo endereco e cinco abriam a errada.
 *
 * E a parte servidor desse conserto -- o href carregar `?aba=<id>` -- pode ser conferida por
 * curl. A outra metade nao: se a TELA le o parametro e abre o painel certo so se descobre
 * abrindo. O `?aba=` ja existia no href antes desta etapa e ninguem o lia; um parametro escrito
 * e ignorado passa por qualquer checagem que olhe so o endereco.
 *
 * ── COMO RODA ────────────────────────────────────────────────────────────────────────────
 *   docker run --rm --network host -v "$PWD/scripts/provas:/p" \
 *     zenika/alpine-chrome:with-puppeteer node /p/abrir_configuracoes.js
 */
const puppeteer = require('puppeteer');

const BASE = process.env.BASE || 'http://127.0.0.1:3110';
const UNI = process.env.UNI || 'http://127.0.0.1:3100';
const TOKEN = process.env.TOKEN || '';

let passou = 0;
let falhou = 0;

function conferir(nome, ok, detalhe) {
  if (ok) { passou++; console.log('  ok    ' + nome); }
  else { falhou++; console.log('  FALHA ' + nome + (detalhe ? '  -> ' + detalhe : '')); }
}

(async () => {
  if (!TOKEN) {
    console.log('SEM SESSAO: passe TOKEN=... no ambiente (ver mfa_lib.sh)');
    process.exit(1);
  }

  const servidas = await (await fetch(BASE + '/api/configuracoes', {
    headers: { Authorization: 'Bearer ' + TOKEN },
  })).json();
  const abas = servidas.abas || [];
  console.log('abas servidas: ' + abas.map((a) => a.id).join(', '));

  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const pagina = await navegador.newPage();

  /*
   * UM 4xx DA API NAO E UMA PAGINA QUEBRADA.
   *
   * A primeira versao contava todo `console.error` como defeito e acusou a aba Implantacao por
   * um 400 que era o produto respondendo certo: "Conecte uma conta Asaas em Configuracoes >
   * Integracoes > Financeiro antes de iniciar a implantacao". A conta de teste nao tem Asaas.
   *
   * Uma prova que chama resposta de negocio de defeito ensina a ignorar o vermelho -- que e o
   * unico jeito de o vermelho seguinte, o de verdade, passar batido. Entao:
   *
   *   pageerror        sempre falha. E JavaScript que estourou; nao ha leitura benigna.
   *   5xx              sempre falha. O servidor caiu, e nenhuma tela se defende disso.
   *   4xx              anotado, nao falha. E a API dizendo que falta algo, em portugues.
   *   resto do console falha, menos o ruido que o proprio 4xx gera no console do navegador.
   */
  const erros = [];
  const respostas4xx = [];

  pagina.on('pageerror', (e) => erros.push('pageerror: ' + e.message));
  pagina.on('console', (m) => {
    if (m.type() !== 'error') return;
    // O navegador escreve isto para QUALQUER status >= 400, sem dizer qual. O detentor da
    // verdade e o listener de resposta abaixo, que sabe o codigo.
    if (m.text().includes('Failed to load resource')) return;
    erros.push('console.error: ' + m.text());
  });
  pagina.on('response', (r) => {
    const s = r.status();
    if (s >= 500) erros.push('HTTP ' + s + ' em ' + r.url());
    else if (s >= 400) respostas4xx.push('HTTP ' + s + ' em ' + new URL(r.url()).pathname);
  });

  await pagina.evaluateOnNewDocument((t) => {
    localStorage.setItem('token', t);
    localStorage.setItem('user', '{}');
  }, TOKEN);

  const esperar = (ms) => new Promise((s) => setTimeout(s, ms));

  /*
   * QUAL ABA A FILEIRA DIZ ESTAR ABERTA -- lida do Shadow DOM, que e onde o componente vive.
   *
   * Ler o painel de baixo seria mais direto e menos confiavel: os dois modulos desenham conteudos
   * diferentes, e a fileira e a mesma nos dois. O que se mede aqui e o mesmo dos dois lados.
   */
  function abaMarcada() {
    const el = document.querySelector('loop-settings-tabs');
    if (!el || !el.shadowRoot) return { achou: false, ativa: null, itens: [] };
    // O componente desenha `<a class="aba" data-id=... aria-current="page">` — ver
    // frontend/components/loop-settings-tabs.js. Ler por aqui e ler o que ele de fato marcou.
    const links = [...el.shadowRoot.querySelectorAll('a.aba')];
    const marcada = links.find((a) => a.getAttribute('aria-current') === 'page');
    return {
      achou: true,
      ativa: marcada ? marcada.dataset.id : null,
      itens: links.map((a) => a.dataset.id),
    };
  }

  // ══ A OPERACAO ════════════════════════════════════════════════════════════════════════
  console.log('\n=== A OPERACAO ===');
  const daOperacao = abas.filter((a) => a.modulo === 'operacao');

  for (const aba of daOperacao) {
    const antes = erros.length;
    await pagina.goto(BASE + '/app#/settings?aba=' + aba.id, { waitUntil: 'networkidle2', timeout: 30000 });
    await esperar(2200);

    const m = await pagina.evaluate(abaMarcada);
    conferir('abrir ?aba=' + aba.id + ' marca "' + aba.id + '"',
      m.ativa === aba.id, 'marcada: ' + m.ativa + ' | itens: ' + m.itens.join(', '));
    conferir('  ...e sem erro de JavaScript', erros.length === antes, erros.slice(antes).join(' | '));
  }

  /*
   * E O ENDERECO ACOMPANHA A TROCA. Sem isto, atualizar a pagina devolve a pessoa para a primeira
   * aba e nao existe link para aba nenhuma -- que era o estado antes desta etapa.
   */
  if (daOperacao.length > 1) {
    await pagina.goto(BASE + '/app#/settings?aba=' + daOperacao[0].id, { waitUntil: 'networkidle2', timeout: 30000 });
    await esperar(2000);
    const outra = daOperacao[1].id;
    const clicou = await pagina.evaluate((id) => {
      const el = document.querySelector('loop-settings-tabs');
      const raiz = el && (el.shadowRoot || el);
      const alvo = raiz && [...raiz.querySelectorAll('a,button')].find((n) => n.dataset.id === id);
      if (!alvo) return false;
      alvo.click();
      return true;
    }, outra);
    await esperar(1200);
    if (clicou) {
      const hash = await pagina.evaluate(() => location.hash);
      conferir('trocar de aba escreve no endereco', hash.includes('aba=' + outra), hash);
    } else {
      console.log('  --    nao achei a segunda aba para clicar; a troca nao foi medida');
    }
  }

  // ══ A GESTAO ══════════════════════════════════════════════════════════════════════════
  console.log('\n=== A GESTAO ===');
  const daGestao = abas.filter((a) => a.modulo === 'gestao');

  if (!daGestao.length) {
    console.log('  --    esta conta nao tem Gestao; nada a medir deste lado');
  } else {
    for (const aba of daGestao) {
      const alvo = new URL(aba.href);
      const antes = erros.length;
      await pagina.goto(UNI + alvo.pathname + alvo.search, { waitUntil: 'networkidle2', timeout: 30000 });
      await esperar(2600);

      /*
       * TODA ABA SE MARCA NA FILEIRA, inclusive Integracoes -- e ate 03/09 esta prova afirmava o
       * contrario.
       *
       * Ela dizia: "uma aba de SECAO sai da fileira: abre a propria pagina, com cabecalho e
       * Voltar para Configuracoes", e conferia justamente que o "Voltar" aparecia. Ou seja,
       * PROTEGIA o comportamento que o Vitor apontou como defeito: entrar em Integracoes trocava
       * o titulo, o subtitulo e punha um "Voltar" -- a mesma tela se apresentando como outra.
       *
       * Uma prova pode fazer isso sem ninguem notar: ela descreve o que existe, e se o que existe
       * estiver errado ela vira a guardia do erro. O sinal de alerta e afirmar que uma coisa e
       * DIFERENTE das outras sem que a diferenca sirva a quem usa.
       *
       * Integracoes continua tendo endereco proprio -- as sub-abas precisam disso para poderem
       * ser enviadas por link. O que muda e que ela deixa de anunciar isso.
       */
      const ehSecao = !alvo.search;
      if (ehSecao) {
        const m = await pagina.evaluate(abaMarcada);
        conferir('a aba de secao ' + aba.id + ' se marca na fileira, como as outras',
          m.ativa === aba.id, 'marcada: ' + m.ativa + ' | itens: ' + m.itens.join(', '));

        const cabecalho = await pagina.evaluate(() => {
          const h = document.querySelector('h1');
          return {
            titulo: h ? h.textContent.trim() : '(sem h1)',
            temVoltar: /Voltar para Configura/i.test(document.body.innerText),
          };
        });
        conferir('  ...com o mesmo titulo das outras', cabecalho.titulo === 'Configurações',
          'titulo: "' + cabecalho.titulo + '"');
        conferir('  ...e sem "Voltar", que a propria fileira ja e', !cabecalho.temVoltar);
      } else {
        const m = await pagina.evaluate(abaMarcada);
        conferir('abrir ' + alvo.search + ' marca "' + aba.id + '"',
          m.ativa === aba.id, 'marcada: ' + m.ativa + ' | itens: ' + m.itens.join(', '));
      }
      conferir('  ...e sem erro de JavaScript', erros.length === antes, erros.slice(antes).join(' | '));
    }
  }

  console.log('\n=== ERROS DE JAVASCRIPT NO TOTAL ===');
  console.log(erros.length ? erros.map((e) => '  ' + e).join('\n') : '  nenhum');

  if (respostas4xx.length) {
    console.log('\n=== A API RECUSOU (nao e falha: e ela dizendo o que falta) ===');
    for (const r of [...new Set(respostas4xx)]) console.log('  ' + r);
  }

  await navegador.close();
  console.log('\n' + passou + ' passaram, ' + falhou + ' falharam');
  process.exit(falhou === 0 ? 0 : 1);
})().catch((e) => {
  console.error('A PROVA QUEBROU: ' + e.message);
  process.exit(1);
});
