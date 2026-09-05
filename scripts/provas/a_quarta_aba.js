/*
 * A LISTA DO CONTRATO NÃO SE MISTURA — a quarta aba, num navegador.
 *
 * Pedido do Vitor em 05/09: "o certo era ter uma quarta aba para quando for adicionar uma
 * playlist do contrato para que não se misture com as outras listas".
 *
 * ── o que só um navegador responde ──────────────────────────────────────────────────────────
 * Que a aba existe e abre; que a lista do contrato está NELA e NÃO em Playlists; e que o número
 * do contrato aparece — sem ele a aba seria só outro lugar para a mesma linha.
 *
 * ── e a ausência, que é metade do pedido ────────────────────────────────────────────────────
 * "Não se misture" não se prova mostrando a aba nova: prova-se abrindo a antiga e não achando a
 * lista lá. Uma prova que só olhasse Contratos aprovaria as duas abas mostrando tudo.
 *
 * Roda de /opt/novo-operacao/scripts/provas:
 *   docker run --rm --network host --user root -v "$PWD:/p" -e TOKEN=... -e TELA=<id> \
 *     -e LISTA=<rotulo da lista do contrato> -e NODE_PATH=/usr/src/app/node_modules \
 *     --entrypoint node zenika/alpine-chrome:with-puppeteer /p/a_quarta_aba.js
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'https://beta.loopplayer.com.br/gestao';
const TOKEN = process.env.TOKEN || '';
const TELA = process.env.TELA || '';
const LISTA = process.env.LISTA || '';

(async () => {
  if (!TOKEN) { console.log('SEM SESSAO: passe TOKEN=...'); process.exit(1); }
  if (!TELA) { console.log('SEM TELA: passe TELA=<id do aparelho>'); process.exit(1); }
  if (!LISTA) { console.log('SEM LISTA: passe LISTA=<rotulo da lista do contrato>'); process.exit(1); }

  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const pagina = await navegador.newPage();
  await pagina.setViewport({ width: 1280, height: 900 });

  const erros = [];
  pagina.on('pageerror', (e) => erros.push('pageerror: ' + e.message.slice(0, 140)));
  pagina.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (m.text().includes('Failed to load resource')) return;
    erros.push('console.error: ' + m.text().slice(0, 140));
  });

  await pagina.evaluateOnNewDocument((tk) => {
    localStorage.setItem('token', tk);
    localStorage.setItem('loop_os_token', tk);
  }, TOKEN);

  let falhas = 0;
  const conferir = (o_que, condicao, detalhe) => {
    console.log('  ' + (condicao ? 'ok    ' : 'FALHA ') + o_que + (detalhe ? '   ' + detalhe : ''));
    if (!condicao) falhas++;
  };

  await pagina.goto(`${UNI}/telas/${TELA}`, { waitUntil: 'networkidle0', timeout: 45000 });
  await pagina.waitForFunction(() => /Adicionar conteúdo/i.test(document.body.innerText || ''),
    { timeout: 25000, polling: 300 }).catch(() => {});

  /*
   * A TELA PRECISA TER CARREGADO — e a primeira versão não conferiu.
   *
   * Ela caiu numa tela de outro workspace, a página respondeu "Falha ao carregar o dispositivo",
   * e a asserção "a lista do contrato saiu da aba Playlists" passou VERDE: numa página sem aba
   * nenhuma, nada está em lugar nenhum. É o vazio que aprova qualquer coisa.
   */
  const carregou = await pagina.evaluate(() => !/Falha ao carregar o dispositivo/i.test(document.body.innerText || ''));
  if (!carregou) {
    console.log('\n  A TELA NAO CARREGOU — provavelmente de outro workspace.');
    console.log('  Sem o seletor na frente nao ha o que medir; quem escolhe a tela e provar_quarta_aba.sh.');
    await navegador.close();
    process.exit(3);
  }

  await pagina.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /Adicionar conteúdo/i.test(x.textContent));
    if (b) b.click();
  });
  const abriu = await pagina.waitForFunction(() => /Adicionar à tela|Adicionar a tela/i.test(document.body.innerText || ''),
    { timeout: 15000, polling: 200 }).then(() => true).catch(() => false);
  if (!abriu) {
    console.log('\n  O SELETOR NAO ABRIU — sem ele, toda assercao abaixo mediria a pagina de tras.');
    await navegador.close();
    process.exit(3);
  }

  const abas = () => pagina.evaluate(() =>
    [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter((t) => t.length && t.length < 20));

  console.log('\n── as quatro abas ──');
  const nomes = await abas();
  for (const nome of ['Arquivos', 'Widgets', 'Playlists', 'Contratos']) {
    conferir(`a aba "${nome}" existe`, nomes.includes(nome), nomes.slice(0, 8).join(' | '));
  }
  conferir('sem erro de JavaScript', erros.length === 0, erros.join(' ; '));

  const abrirAba = async (nome) => {
    await pagina.evaluate((n) => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === n);
      if (b) b.click();
    }, nome);
    /* O conteúdo troca sem rede quando a lista já foi baixada — mas a de arquivos não. Esperar
       o painel deixar de dizer "Carregando" cobre os dois casos. */
    await pagina.waitForFunction(() => !/Carregando…|Carregando\.\.\./.test(document.body.innerText || ''),
      { timeout: 15000, polling: 200 }).catch(() => {});
    return pagina.evaluate(() => document.body.innerText || '');
  };

  console.log('\n── a lista do contrato NAO esta em Playlists ──');
  const emPlaylists = await abrirAba('Playlists');
  /*
   * A ausência é o pedido. Se ela estiver aqui, a separação não aconteceu — e o fato de existir
   * uma aba nova não conserta isso, só cria um segundo lugar.
   */
  conferir('a lista do contrato saiu da aba Playlists', !emPlaylists.includes(LISTA),
    emPlaylists.slice(0, 220).replace(/\n/g, ' | '));

  console.log('\n── e ESTA na aba Contratos ──');
  const emContratos = await abrirAba('Contratos');
  conferir('a lista do contrato aparece aqui', emContratos.includes(LISTA),
    emContratos.slice(0, 260).replace(/\n/g, ' | '));
  /* Sem o número, a aba seria só outro lugar para a mesma linha. */
  conferir('e o quanto cabe no contrato aparece', /\d+ de \d+ no ar|sem limite/.test(emContratos),
    emContratos.slice(0, 260).replace(/\n/g, ' | '));

  console.log('\n── a busca acha pelo nome do anunciante ──');
  /* O rótulo é montado do contrato e começa pelo anunciante: quem procura a lista da Padaria
     digita "Padaria", e não o nome de uma playlist que ele nunca escolheu. */
  const anunciante = LISTA.split(' — ')[0].split(' · ')[0];
  await pagina.evaluate((termo) => {
    const campo = [...document.querySelectorAll('input')].find((i) => /Buscar/i.test(i.placeholder || ''));
    if (!campo) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(campo, termo);
    campo.dispatchEvent(new Event('input', { bubbles: true }));
  }, anunciante);
  await new Promise((r) => setTimeout(r, 400));
  const filtrado = await pagina.evaluate(() => document.body.innerText || '');
  conferir(`buscar por "${anunciante}" encontra a lista`, filtrado.includes(LISTA),
    filtrado.slice(0, 220).replace(/\n/g, ' | '));

  conferir('sem erro de JavaScript no fim', erros.length === 0, erros.join(' ; '));

  await navegador.close();
  console.log('');
  if (falhas) { console.log(falhas + ' FALHA(S) na quarta aba'); process.exit(1); }
  console.log('A LISTA DO CONTRATO TEM ABA PROPRIA');
})().catch((e) => { console.error('A PROVA QUEBROU: ' + e.message); process.exit(2); });
