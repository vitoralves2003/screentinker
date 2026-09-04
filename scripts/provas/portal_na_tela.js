/*
 * O PORTAL DO ANUNCIANTE DESENHA — num navegador, com sessão, contra o cenário plantado.
 *
 * `provar_portal_recorte.sh` pergunta ao servidor. O que só um navegador responde: a página passa
 * o portão do AppShell e DESENHA; o contrato do cliente A aparece com o limite dele; o do cliente
 * B não aparece em lugar nenhum do documento; e sem erro de JavaScript.
 *
 * ── por que ela roda DUAS VEZES, com FASE diferente ─────────────────────────────────────────
 * A recusa é metade do produto. Uma prova que só olha a tela COM vínculo aprovaria um portal que
 * mostra tudo para todo mundo — e o "falha fechado" do servidor não vale nada se a tela não o
 * traduzir em palavras. Então:
 *
 *   FASE=sem   sem vínculo: a tela precisa DIZER que esta conta não tem portal
 *   FASE=com   com vínculo: a tela precisa mostrar o contrato de A, e só ele
 *
 * Quem planta o vínculo entre as duas é `provar_portal_na_tela.sh`.
 *
 * COM o basePath (/gestao): sem ele a casa velha responde qualquer caminho com o casco dela, 200
 * e o mesmo <title> — ver ajuda_nativa.js.
 *
 * Roda de /opt/novo-operacao/scripts/provas:
 *   docker run --rm --network host --user root -v "$PWD:/p" -e TOKEN=... -e FASE=com \
 *     -e NODE_PATH=/usr/src/app/node_modules --entrypoint node zenika/alpine-chrome:with-puppeteer \
 *     /p/portal_na_tela.js
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'https://beta.loopplayer.com.br/gestao';
const TOKEN = process.env.TOKEN || '';
const FASE = process.env.FASE || 'com';

(async () => {
  if (!TOKEN) { console.log('SEM SESSAO: passe TOKEN=...'); process.exit(1); }
  if (FASE !== 'sem' && FASE !== 'com') { console.log('FASE precisa ser "sem" ou "com"'); process.exit(1); }

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

  await pagina.goto(UNI + '/portal', { waitUntil: 'networkidle0', timeout: 45000 });
  /*
   * "Carregando..." é o estado inicial de contratos === null. Esperar ele SUMIR é a régua honesta:
   * um número de milissegundos escolhido a dedo reprova tela boa em máquina lenta e aprova tela
   * quebrada em máquina rápida — três vezes numa tarde, e as três reprovaram telas boas.
   */
  await pagina.waitForFunction(
    () => !/Carregando\.\.\./.test(document.body.innerText || ''),
    { timeout: 25000, polling: 300 },
  ).catch(() => {});

  const texto = await pagina.evaluate(() => document.body.innerText || '');
  const html = await pagina.evaluate(() => document.documentElement.outerHTML || '');

  console.log('\n── a pagina desenhou (FASE=' + FASE + ') ──');
  conferir('o titulo da tela aparece', /Meus contratos/.test(texto), texto.slice(0, 60).replace(/\n/g, ' | '));
  conferir('sem erro de JavaScript', erros.length === 0, erros.join(' ; '));
  conferir('sem resposta 5xx', respostas5xx.length === 0, respostas5xx.join(' ; '));

  if (FASE === 'sem') {
    console.log('\n── sem vinculo, a tela DIZ que nao ha portal ──');
    /*
     * O servidor recusa com 403, e a tela precisa traduzir isso em palavras. Sem esta frase a
     * pessoa vê uma tela vazia e liga para o assinante perguntando se o contrato foi cancelado.
     */
    conferir('a tela explica a falta de acesso', /acesso ao portal/.test(texto),
      texto.slice(0, 200).replace(/\n/g, ' | '));
    conferir('e NAO mostra o contrato de ninguem', !/PROVA-A|PROVA-B/.test(html));
  } else {
    console.log('\n── com vinculo, o contrato de A aparece, e so ele ──');
    conferir('o cliente A aparece', /Padaria da Prova/.test(texto));
    conferir('com o numero do contrato', /PROVA-A/.test(texto));
    /*
     * O cliente B é procurado no HTML INTEIRO, e não no texto visível: um id que viajou no
     * data-contrato de um cartão fechado não está na tela, mas está na resposta — e é isso que
     * um vazamento de recorte parece antes de virar tela.
     */
    conferir('o cliente B nao aparece em lugar nenhum', !/Otica da Prova|PROVA-B/.test(html));

    console.log('\n── e o contrato diz o que cabe nele ──');
    /* Um contrato só na lista: a tela o abre sozinha, para ninguém ter de clicar para ver o que tem. */
    conferir('o cartao abriu sozinho', /Enviar/.test(texto), texto.slice(0, 300).replace(/\n/g, ' | '));
    conferir('o limite do contrato aparece', /0 de 3 m/.test(texto));
    conferir('a duracao maxima aparece', /30s por m/.test(texto));
    conferir('e diz quantas ainda cabem', /Cabem mais 3/.test(texto));
    conferir('a lista vazia se explica', /Nada enviado ainda/.test(texto));

    console.log('\n── e o que o portal NAO mostra ──');
    /* Valor e parcela são a relação comercial do assinante. O servidor não os devolve; isto prova
       que nenhum caminho da tela os desenhou por outra via. */
    conferir('nenhum campo de dinheiro na pagina', !/R\$|Valor total|Parcela/.test(texto));
  }

  await navegador.close();
  console.log('');
  if (falhas) { console.log(falhas + ' FALHA(S) na tela do portal'); process.exit(1); }
  console.log('A TELA DO PORTAL ESTA DE PE (FASE=' + FASE + ')');
})().catch((e) => { console.error('A PROVA QUEBROU: ' + e.message); process.exit(2); });
