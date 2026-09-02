/*
 * AS PÁGINAS DE PARIDADE ABREM DE VERDADE — /gestao/arquivos e /gestao/playlists.
 *
 * Elas hospedam o código legado das telas antigas dentro do app React (paridade por
 * identidade). Um curl 200 não prova nada aqui: o 200 é a casca do Next, e um erro de import
 * ou de execução do legado deixaria a página em branco — a história de tela em branco deste
 * projeto inteira. Só um navegador executando o JavaScript responde.
 *
 * Confere, por página: o miolo da tela antiga DESENHOU (um texto que só o legado escreve) e
 * o console não tem erro.
 *
 *   docker run --rm --network host -v "$PWD:/p" -e TOKEN=... \
 *     zenika/alpine-chrome:with-puppeteer node /p/abrir_paridade.js
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

(async () => {
  if (!TOKEN) {
    console.log('SEM SESSAO: passe TOKEN=... no ambiente (ver mfa_lib.sh)');
    process.exit(1);
  }

  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const pagina = await navegador.newPage();

  const erros = [];
  pagina.on('pageerror', (e) => erros.push('pageerror: ' + e.message));
  pagina.on('console', (m) => {
    if (m.type() === 'error') erros.push('console.error: ' + m.text());
  });
  const respostasRuins = [];
  pagina.on('response', (r) => { if (r.status() >= 400) respostasRuins.push(r.status() + ' ' + r.url()); });
  pagina.on('requestfailed', (r) => respostasRuins.push('FALHOU ' + (r.failure() ? r.failure().errorText : '?') + ' ' + r.url()));

  await pagina.evaluateOnNewDocument((t) => {
    localStorage.setItem('token', t);
    localStorage.setItem('user', '{}');
    /* Um throw dentro de um IIFE assíncrono não vira pageerror — vira rejeição sem dono,
       invisível para as sondas de cima. Guarda para o diagnóstico ler depois. */
    window.__rejeicoes = [];
    window.addEventListener('unhandledrejection', (e) => {
      const r = e.reason;
      window.__rejeicoes.push(String((r && (r.stack || r.message)) || r));
    });
  }, TOKEN);

  const CASOS = [
    {
      /* CONTROLE: rota sabidamente boa (18/18 na prova das abas hoje). Se ela falhar AQUI,
         o defeito é deste harness, não das páginas de paridade. */
      nome: 'controle-configuracoes',
      url: UNI + '/gestao/configuracoes?aba=conta',
      espera: 'Gerencie sua empresa',
    },
    {
      nome: 'playlists',
      url: UNI + '/gestao/playlists',
      /* Texto que só o legado desenha — o subtitle do page-header da tela antiga. */
      espera: 'Crie e gerencie playlists de conteúdo',
      casco: true,
    },
    {
      nome: 'arquivos',
      url: UNI + '/gestao/arquivos',
      /* O placeholder da busca da biblioteca antiga. */
      espera: 'Buscar',
      casco: true,
    },
    {
      nome: 'telas',
      url: UNI + '/gestao/telas',
      /* O subtitle da lista de telas antiga (views/dashboard.js). */
      espera: 'Gerencie suas telas remotas',
      casco: true,
    },
  ];

  for (const caso of CASOS) {
    const antes = erros.length;
    await pagina.goto(caso.url, { waitUntil: 'networkidle2', timeout: 30000 });
    /* O legado desenha depois do mount + fetch; espera o texto aparecer, não um timer cego. */
    let desenhou = false;
    try {
      await pagina.waitForFunction(
        (t) => document.body.innerText.includes(t) || !!document.querySelector('.page-header'),
        { timeout: 15000 },
        caso.espera,
      );
      desenhou = await pagina.evaluate(
        (t) => document.body.innerText.includes(t) || !!document.querySelector('.page-header'),
        caso.espera,
      );
    } catch {
      desenhou = false;
    }
    conferir(`${caso.nome}: a tela antiga desenhou dentro do app React`, desenhou,
      'url ' + pagina.url()
      + ' | host-div: ' + (await pagina.evaluate(() => { const m = document.querySelector('main') || document.body; const divs = m.querySelectorAll('div'); return divs.length; }))
      + ' | tem page-header no html: ' + (await pagina.evaluate(() => document.body.innerHTML.includes('page-header')))
      + ' | rede: ' + (respostasRuins.join(' ; ') || 'limpa')
      + ' | scripts: ' + (await pagina.evaluate(() => document.scripts.length))
      /* A tag de estilo só existe se o efeito de montagem RODOU — detector de hidratação. */
      + ' | estilo-operacao: ' + (await pagina.evaluate(() => !!document.querySelector('style[data-estilo-operacao]')))
      + ' | rejeicoes: ' + (await pagina.evaluate(() => (window.__rejeicoes || []).join(' ; ') || 'nenhuma'))
      + ' | miolo: "' + (await pagina.evaluate(() => (document.querySelector('main') || document.body).innerText.trim().slice(0, 80))) + '"');
    conferir(`${caso.nome}: sem erro de JavaScript`, erros.length === antes, erros.slice(antes).join(' | '));
    if (caso.casco) {
      /* toast.js faz appendChild em #toastContainer SEM conferir — sem o casco, toda ação
         que confirma com toast LANÇA. O buraco existiu de verdade: as duas primeiras
         páginas de paridade foram ao ar sem ele. */
      conferir(`${caso.nome}: o casco da Operação presente (toasts têm onde nascer)`,
        await pagina.evaluate(() => !!document.getElementById('toastContainer') && !!document.getElementById('banners')));
    }
  }

  await navegador.close();
  console.log(`\n${passou} passaram, ${falhou} falharam`);
  process.exit(falhou ? 1 : 0);
})();
