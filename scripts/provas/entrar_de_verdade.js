/*
 * ENTRAR DE VERDADE — o login inteiro, num celular, contra o endereço público.
 *
 * ── POR QUE ISTO EXISTE ──────────────────────────────────────────────────────────────────
 * O Vitor entrou pelo celular em 03/09 e, depois de acertar a senha, foi parar numa página de
 * erro: `localhost:3100`, ERR_CONNECTION_FAILED. O sistema estava perfeitamente de pé — o que
 * ele mandou o navegador fazer é que era impossível.
 *
 * A causa era `APP_URL=http://localhost:3100` no ambiente: o produto monta links ABSOLUTOS a
 * partir dela, e ela ainda apontava para o túnel SSH que só existia na máquina dele. Toda
 * checagem que eu tinha rodava por dentro (curl na VPS, puppeteer com o token já plantado no
 * localStorage), e nenhuma delas PASSA PELO REDIRECIONAMENTO — que é justamente o pedaço que
 * carrega o endereço.
 *
 * Então esta prova faz o que nenhuma outra fazia: digita e-mail e senha, deixa o produto
 * decidir para onde mandar, e olha onde parou. É o único jeito de esse defeito não voltar.
 *
 * Ela roda num viewport de celular de propósito: foi ali que ele apareceu, e é o assento em
 * que o produto passou a ser usado agora que tem endereço.
 *
 * ── COMO RODA ────────────────────────────────────────────────────────────────────────────
 *   docker run --rm --network host --entrypoint node \
 *     -e NODE_PATH=/usr/src/app/node_modules -e UNI=https://beta.loopplayer.com.br \
 *     -v /opt/novo-operacao/scripts/provas:/p \
 *     zenika/alpine-chrome:with-puppeteer /p/entrar_de_verdade.js
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'http://127.0.0.1:3100';
const EMAIL = process.env.PROVA_EMAIL || 'cliente@exemplo.invalid';
const SENHA = process.env.PROVA_SENHA || 'SenhaCliente#2026';

let falhou = 0;
function conferir(nome, ok, detalhe) {
  if (ok) console.log('  ok    ' + nome);
  else { falhou++; console.log('  FALHA ' + nome + (detalhe ? '  -> ' + detalhe : '')); }
}

(async () => {
  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const pagina = await navegador.newPage();
  await pagina.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

  const erros = [];
  pagina.on('pageerror', (e) => erros.push(e.message));
  const visitou = [];
  pagina.on('framenavigated', (f) => { if (f === pagina.mainFrame()) visitou.push(f.url()); });

  await pagina.goto(UNI + '/login', { waitUntil: 'networkidle0', timeout: 45000 });
  await new Promise((r) => setTimeout(r, 1800));

  /* Passo 1: o e-mail. O login é em duas etapas — a senha só aparece depois. */
  await pagina.type('#loginEmail', EMAIL);
  await pagina.evaluate(() => {
    const b = [...document.querySelectorAll('button[type=submit]')].find((e) => e.offsetParent !== null);
    if (b) b.click();
  });
  await new Promise((r) => setTimeout(r, 3000));

  /* Passo 2: a senha, no campo que apareceu. */
  const achouSenha = await pagina.evaluate(() => {
    const i = [...document.querySelectorAll('input[type=password]')].find((e) => e.offsetParent !== null);
    if (!i) return false;
    i.focus();
    return true;
  });
  conferir('o campo de senha aparece depois do e-mail', achouSenha);

  if (achouSenha) {
    await pagina.keyboard.type(SENHA);
    await pagina.evaluate(() => {
      const b = [...document.querySelectorAll('button[type=submit]')].find((e) => e.offsetParent !== null);
      if (b) b.click();
    });
    await new Promise((r) => setTimeout(r, 7000));
  }

  const destino = pagina.url();
  const texto = (await pagina.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');

  console.log('\n  caminho: ' + visitou.join('  ->  '));
  console.log('  parou em: ' + destino);
  console.log('  a página diz: ' + texto.slice(0, 110));

  /*
   * A ASSERÇÃO QUE IMPORTA. Não é "deu 200" nem "abriu uma página" — o navegador do Vitor
   * também abriu uma página, a de erro. É que o endereço para onde o produto mandou EXISTE
   * fora da máquina onde ele foi gerado.
   */
  conferir('o destino não é localhost', !destino.includes('localhost') && !destino.includes('127.0.0.1'),
    destino);
  conferir('o destino está no mesmo endereço público', destino.startsWith(UNI), destino);
  conferir('a sessão foi criada', await pagina.evaluate(() => !!(localStorage.getItem('token') || localStorage.getItem('loop_os_token'))));
  conferir('não caiu de volta no login', !/\/login/.test(destino) || /#\/(?!login)/.test(destino), destino);
  conferir('a página tem conteúdo', texto.length > 60, texto.length + ' caracteres');
  conferir('sem erro de JavaScript', erros.length === 0, erros.slice(0, 2).join(' | '));

  await navegador.close();
  console.log(falhou ? '\nFALHOU ' + falhou : '\nENTROU');
  process.exit(falhou ? 1 : 0);
})();
