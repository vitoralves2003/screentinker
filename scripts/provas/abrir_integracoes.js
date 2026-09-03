/*
 * AS ABAS DE INTEGRACOES ABREM E DEIXAM OPERAR? -- perguntado num navegador.
 *
 * ── POR QUE ISTO EXISTE ──────────────────────────────────────────────────────────────────
 * O Vitor abriu Configuracoes -> Integracoes e reportou que "nada funciona". Os quatro
 * endpoints respondiam 200 por curl, com dados certos. O defeito estava inteiro no navegador:
 * os componentes liam `loop_os_user` do localStorage -- chave que ninguem mais escreve desde a
 * sessao unica -- e disso vinham DOIS sintomas que nenhuma prova de servidor jamais veria:
 *
 *   1. Assinatura: o `return` por falta da chave ficava ANTES do try, entao o `finally` que
 *      desliga o "Carregando..." nunca rodava. A aba ficava parada para sempre, sem erro no
 *      console e sem requisicao falhando.
 *   2. Financeiro e WhatsApp: `canManage` ficava false, e o titular via a propria conta em
 *      modo somente-leitura -- a tela carregava certa, so nao deixava fazer nada.
 *
 * O segundo sintoma e o mais perigoso, porque a tela parece funcionar. Por isso esta prova
 * afirma DUAS coisas por aba: que ela terminou de carregar, e que ela deixa OPERAR.
 *
 * ── ELA CONSEGUE FALHAR? (contraprova de 03/09) ──────────────────────────────────────────
 * Verde nao e evidencia sem contraprova. Rodei esta prova com um papel NAO-titular injetado
 * por cima do token, e as asercoes de "pode operar" cairam onde deviam:
 *
 *   assinatura-eletronica   0 de 3 controles ativos   FALHA
 *   whatsapp                0 de 0 controles ativos   FALHA
 *   financeiro              1 de 2 controles ativos   passa  <-- ver abaixo
 *
 * Ou seja: as duas primeiras discriminam de verdade. O Financeiro NAO discrimina, porque tem
 * controle que nao depende de canManage (o seletor de provedor continua navegavel), entao ali
 * a asercao de operar vale menos -- o que a segura e a de "desenhou o conteudo". Fica escrito
 * para ninguem confiar nela mais do que ela merece.
 *
 * ── COMO RODA ────────────────────────────────────────────────────────────────────────────
 *   docker run --rm --network host -v "$PWD:/p" -e TOKEN=... \
 *     zenika/alpine-chrome:with-puppeteer node /p/abrir_integracoes.js
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'http://127.0.0.1:3100';
const TOKEN = process.env.TOKEN || '';

let passou = 0;
let falhou = 0;

function conferir(nome, ok, detalhe) {
  if (ok) { passou++; console.log('  ok    ' + nome); }
  else { falhou++; console.log('  FALHA ' + nome + (detalhe ? '  -> ' + detalhe : '')); }
}

const ABAS = [
  {
    id: 'financeiro',
    caminho: '/gestao/configuracoes/integracoes/financeiro',
    /* O seletor de provedor so e clicavel para quem administra. */
    marcaDeCarregou: 'Conta financeira',
  },
  {
    id: 'assinatura-eletronica',
    caminho: '/gestao/configuracoes/integracoes/assinatura-eletronica',
    marcaDeCarregou: null,   /* basta nao estar em "Carregando..." */
  },
  {
    id: 'whatsapp',
    caminho: '/gestao/configuracoes/integracoes/whatsapp',
    marcaDeCarregou: 'WhatsApp',
  },
];

(async () => {
  if (!TOKEN) {
    console.log('SEM SESSAO: passe TOKEN=... no ambiente');
    process.exit(1);
  }

  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  for (const aba of ABAS) {
    console.log('\n' + aba.id);
    const pagina = await navegador.newPage();

    const erros = [];
    pagina.on('pageerror', (e) => erros.push('pageerror: ' + e.message));
    pagina.on('response', (r) => {
      if (r.status() >= 500) erros.push('HTTP ' + r.status() + ' em ' + r.url());
    });

    await pagina.evaluateOnNewDocument((t) => {
      localStorage.setItem('token', t);
      localStorage.setItem('loop_os_token', t);
      /* De proposito NAO escrevemos 'loop_os_user': e justamente a chave morta, e o
         navegador de um usuario de verdade nao a tem mais. */
    }, TOKEN);

    await pagina.goto(UNI + aba.caminho, { waitUntil: 'networkidle0', timeout: 45000 });
    await new Promise((r) => setTimeout(r, 2500));

    const texto = await pagina.evaluate(() => document.body.innerText);

    /* 1. TERMINOU DE CARREGAR. */
    conferir(aba.id + ': saiu de "Carregando..."', !texto.includes('Carregando...'),
      'a aba ficou presa no estado de carregamento');

    if (aba.marcaDeCarregou) {
      conferir(aba.id + ': desenhou o conteudo', texto.includes(aba.marcaDeCarregou),
        'nao achei "' + aba.marcaDeCarregou + '" na pagina');
    }

    /* 2. DEIXA OPERAR -- o sintoma silencioso. Um titular tem de encontrar pelo menos um
       controle HABILITADO; se todos vierem disabled, canManage ficou false. */
    const controles = await pagina.evaluate(() => {
      const alvos = [...document.querySelectorAll('button, input, select, textarea')]
        .filter((e) => e.offsetParent !== null);
      return {
        total: alvos.length,
        habilitados: alvos.filter((e) => !e.disabled).length,
      };
    });
    conferir(
      aba.id + ': o titular pode operar (' + controles.habilitados + ' de ' + controles.total + ' controles ativos)',
      controles.total > 0 && controles.habilitados > 0,
      'todos os controles vieram desabilitados -- canManage caiu para false',
    );

    conferir(aba.id + ': sem erro de JavaScript', erros.length === 0, erros.join(' | '));

    await pagina.close();
  }

  await navegador.close();
  console.log('\npassou ' + passou + ', falhou ' + falhou);
  process.exit(falhou ? 1 : 0);
})();
