/*
 * A FILA DE APROVAÇÃO DESENHA, E DECIDE — num navegador, com sessão.
 *
 * O ciclo do portal só fecha aqui. O anunciante manda pelo portal; alguém da casa decide nesta
 * tela. Sem ela a aprovação é uma sala de espera sem porta: do lado do anunciante está tudo certo
 * (ele mandou), do lado do assinante não há nada na tela, e a peça fica pendente para sempre.
 *
 * ── o que só um navegador responde aqui ─────────────────────────────────────────────────────
 * Que a fila mostra QUEM mandou e não só um identificador; que a recusa PEDE o motivo em vez de
 * aceitar vazio; e que aprovar tira o item da fila de verdade, sem recarregar a página na mão.
 *
 * ── a régua ─────────────────────────────────────────────────────────────────────────────────
 * O cenário é plantado antes por `provar_fila_na_tela.sh`, que sobe uma mídia real pelo portal.
 * A prova espera o "Carregando..." sumir, e não um número de milissegundos: régua escolhida a
 * dedo reprova tela boa em máquina lenta e aprova tela quebrada em máquina rápida.
 *
 * Roda de /opt/novo-operacao/scripts/provas:
 *   docker run --rm --network host --user root -v "$PWD:/p" -e TOKEN=... -e ARQUIVO=... \
 *     -e NODE_PATH=/usr/src/app/node_modules --entrypoint node zenika/alpine-chrome:with-puppeteer \
 *     /p/a_fila_na_tela.js
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'https://beta.loopplayer.com.br/gestao';
const TOKEN = process.env.TOKEN || '';
/* O nome do arquivo plantado. Sem ele a prova não sabe QUAL linha é a dela, e mediria a fila
   inteira do staging — que pode ter itens de outra coisa. */
const ARQUIVO = process.env.ARQUIVO || '';

(async () => {
  if (!TOKEN) { console.log('SEM SESSAO: passe TOKEN=...'); process.exit(1); }
  if (!ARQUIVO) { console.log('SEM ARQUIVO: passe ARQUIVO=<nome do arquivo plantado>'); process.exit(1); }

  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const pagina = await navegador.newPage();
  await pagina.setViewport({ width: 1280, height: 900 });

  const erros = [];
  const respostas5xx = [];
  pagina.on('pageerror', (e) => erros.push('pageerror: ' + e.message.slice(0, 120)));
  pagina.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (m.text().includes('Failed to load resource')) return;
    erros.push('console.error: ' + m.text().slice(0, 120));
  });
  pagina.on('response', (r) => { if (r.status() >= 500) respostas5xx.push(r.status() + ' ' + new URL(r.url()).pathname); });

  await pagina.evaluateOnNewDocument((tk) => {
    localStorage.setItem('token', tk);
    localStorage.setItem('loop_os_token', tk);
  }, TOKEN);

  let falhas = 0;
  const conferir = (o_que, condicao, detalhe) => {
    console.log('  ' + (condicao ? 'ok    ' : 'FALHA ') + o_que + (detalhe ? '   ' + detalhe : ''));
    if (!condicao) falhas++;
  };

  const esperarCarregar = () => pagina.waitForFunction(
    () => !/Carregando\.\.\./.test(document.body.innerText || ''),
    { timeout: 25000, polling: 300 },
  ).catch(() => {});

  await pagina.goto(UNI + '/aprovacoes', { waitUntil: 'networkidle0', timeout: 45000 });
  await esperarCarregar();

  let texto = await pagina.evaluate(() => document.body.innerText || '');

  console.log('\n── a fila desenhou ──');
  conferir('o titulo da tela aparece', /Aprovações/.test(texto), texto.slice(0, 60).replace(/\n/g, ' | '));
  conferir('sem erro de JavaScript', erros.length === 0, erros.join(' ; '));
  conferir('sem resposta 5xx', respostas5xx.length === 0, respostas5xx.join(' ; '));

  console.log('\n── e mostra o que ha para decidir ──');
  conferir('a peca enviada esta na fila', texto.includes(ARQUIVO), texto.slice(0, 300).replace(/\n/g, ' | '));
  /* Quem mandou vem antes do que mandou: a decisão é sobre a relação, não sobre o arquivo. */
  conferir('e diz de QUEM ela veio', /Padaria da Prova/.test(texto));
  conferir('com o contrato', /PROVA-A/.test(texto));

  console.log('\n── a recusa PEDE o motivo ──');
  /*
   * O servidor aceita recusa sem motivo e grava um texto padrão. É pior que um bom motivo e
   * melhor que o vazio — e esta tela existe para o bom motivo ser o caminho fácil. Se o botão
   * agisse com o campo em branco, o padrão viraria a norma.
   */
  const clicouRecusar = await pagina.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Recusar');
    if (!b) return false;
    b.click();
    return true;
  });
  conferir('o botao Recusar existe', clicouRecusar);

  await pagina.waitForFunction(() => /Por que está recusando/.test(document.body.innerText || ''),
    { timeout: 8000, polling: 200 }).catch(() => {});
  texto = await pagina.evaluate(() => document.body.innerText || '');
  conferir('ele abre o campo de motivo', /Por que está recusando/.test(texto));

  const desabilitado = await pagina.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('Recusar e avisar'));
    return b ? b.disabled : null;
  });
  conferir('e o botao nao age com o campo vazio', desabilitado === true, 'disabled=' + desabilitado);

  /* Cancelar volta ao estado anterior: abrir o campo não pode prender quem só queria olhar. */
  await pagina.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Cancelar');
    if (b) b.click();
  });

  console.log('\n── aprovar tira o item da fila, sem recarregar ──');
  await pagina.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Aprovar');
    if (b) b.click();
  });
  /*
   * A tela recarrega a fila sozinha depois de decidir. Esperar o NOME sumir é a régua honesta —
   * e se ele não sumir, é porque a decisão não chegou ou a lista não se refez, que são as duas
   * coisas que esta asserção existe para pegar.
   */
  await pagina.waitForFunction(
    (nome) => !(document.body.innerText || '').includes(nome),
    { timeout: 20000, polling: 300 }, ARQUIVO,
  ).catch(() => {});
  texto = await pagina.evaluate(() => document.body.innerText || '');
  conferir('a peca saiu da fila depois de aprovada', !texto.includes(ARQUIVO),
    texto.slice(0, 200).replace(/\n/g, ' | '));
  conferir('e a tela avisa que aprovou', /Aprovada/.test(texto), texto.slice(0, 200).replace(/\n/g, ' | '));

  await navegador.close();
  console.log('');
  if (falhas) { console.log(falhas + ' FALHA(S) na fila'); process.exit(1); }
  console.log('A FILA DECIDE NA TELA');
})().catch((e) => { console.error('A PROVA QUEBROU: ' + e.message); process.exit(2); });
