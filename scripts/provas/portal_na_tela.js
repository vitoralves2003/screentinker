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
 *   FASE=sem       sem vínculo: a tela precisa DIZER que esta conta não tem portal
 *   FASE=com       com vínculo: a tela precisa mostrar o contrato de A, e só ele
 *   FASE=recusada  depois de uma recusa: o MOTIVO precisa chegar a quem mandou
 *
 * Quem planta o vínculo entre as duas primeiras é `provar_portal_na_tela.sh`; quem monta a
 * terceira é `provar_fila_na_tela.sh`, que recusa uma peça de verdade pela fila.
 *
 * A terceira fase existe porque o motivo é a única coisa que a recusa entrega. Sem ele a pessoa
 * reenvia a mesma peça, e quem atende o telefone depois é o assinante — então uma recusa que não
 * chega ao portal é uma recusa que não aconteceu.
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
/* O texto exato da recusa, para a fase 'recusada'. Procurar uma palavra genérica aprovaria a
   tela que escreve "Recusada" e engole o porquê — que é justamente o defeito temido. */
const MOTIVO = process.env.MOTIVO || '';

(async () => {
  /*
   * O TOKEN AQUI É O DO PORTAL, e não o do assinante (mudou em 05/09, com a porta própria).
   *
   * A fase 'sem' é a única que roda sem token nenhum — e agora é isso que ela significa: quem
   * não tem vínculo não consegue sessão de portal, então o que se mede é a tela SEM sessão.
   * Exigir TOKEN nela mediria uma situação que deixou de existir.
   */
  if (FASE !== 'sem' && !TOKEN) { console.log('SEM SESSAO DO PORTAL: passe TOKEN=<token de /api/portal/entrar>'); process.exit(1); }
  if (!['sem', 'com', 'recusada'].includes(FASE)) { console.log('FASE precisa ser "sem", "com" ou "recusada"'); process.exit(1); }
  if (FASE === 'recusada' && !MOTIVO) { console.log('SEM MOTIVO: a fase "recusada" precisa do texto que o assinante escreveu'); process.exit(1); }

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

  /*
   * `loop_portal_token`, a chave da sessão do PORTAL — e SÓ ela.
   *
   * Plantar `loop_os_token` aqui seria pior que não plantar nada: é a chave do assinante, e o
   * portal a ignora de propósito. A tela abriria sem sessão, a prova mediria a tela de entrada,
   * e as asserções de recorte reprovariam falando de vazamento.
   *
   * Sem token (fase 'sem'), nada é plantado: é assim que se mede a tela de quem não entrou.
   */
  if (TOKEN) {
    await pagina.evaluateOnNewDocument((tk) => {
      localStorage.setItem('loop_portal_token', tk);
    }, TOKEN);
  }

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

  const endereco = pagina.url();

  console.log('\n── a pagina desenhou (FASE=' + FASE + ') ──');
  /* "Meus contratos" é o título de quem ENTROU. Na fase 'sem' a tela certa é outra — exigi-lo
     ali reprovaria justamente o comportamento que a fase existe para medir. */
  if (FASE !== 'sem') {
    conferir('o titulo da tela aparece', /Meus contratos/.test(texto), texto.slice(0, 60).replace(/\n/g, ' | '));
  }
  conferir('sem erro de JavaScript', erros.length === 0, erros.join(' ; '));
  conferir('sem resposta 5xx', respostas5xx.length === 0, respostas5xx.join(' ; '));

  if (FASE === 'recusada') {
    console.log('\n── a recusa volta, e com o porque ──');
    /*
     * "Recusada" sozinho é quase inútil: quem lê não sabe o que mudar, então reenvia a mesma
     * peça. O motivo fica À VISTA, e não atrás de um clique, pelo mesmo motivo.
     */
    conferir('a peca aparece como recusada', /Recusada/.test(texto), texto.slice(0, 300).replace(/\n/g, ' | '));
    conferir('e o MOTIVO escrito pelo assinante esta la', texto.includes(MOTIVO),
      texto.slice(0, 400).replace(/\n/g, ' | '));
    conferir('a palavra "Motivo" prepara a leitura', /Motivo:/.test(texto));
    /*
     * O contrato tem DUAS peças neste ponto: uma aprovada e uma recusada. O número tem de dizer
     * UMA — e é o par que prova a regra, não cada metade sozinha.
     *
     * A aprovada conta porque está no ar. A recusada não conta porque não está: se contasse, a
     * recusa consumiria vaga e o anunciante ficaria preso ao material que o assinante rejeitou
     * (limite 3, três recusas, e nada mais entra). Uma asserção só de "0" ou só de "2" passaria
     * com a regra errada.
     */
    conferir('a aprovada ocupa e a recusada nao', /1 de 3 m/.test(texto),
      texto.slice(0, 400).replace(/\n/g, ' | '));
  } else if (FASE === 'sem') {
    console.log('\n── sem sessao de portal, a tela manda para a entrada ──');
    /*
     * O QUE ESTA FASE MEDE MUDOU EM 05/09, porque o mecanismo mudou de lugar.
     *
     * Antes: o portal aceitava a sessão do assinante, o servidor recusava quem não tinha vínculo
     * com 403, e a tela traduzia esse 403 na frase "você não tem acesso ao portal".
     *
     * Agora o portal tem porta própria: quem não tem vínculo não obtém sessão nenhuma, e a
     * recusa é a da entrada — medida no servidor por `provar_porta_do_anunciante.sh` e na tela
     * por `entrar_no_portal.js`. O que sobra aqui, e continua valendo, é o caso de quem chega em
     * /portal sem ter entrado: a tela precisa LEVAR a pessoa para a entrada.
     *
     * Uma tela que ficasse vazia esperando dados que nunca vêm é o defeito temido de sempre — só
     * que agora ele apareceria como página em branco em vez de frase faltando.
     */
    conferir('o endereco final e a entrada do portal', /\/portal\/entrar/.test(endereco), endereco);
    conferir('a tela pede e-mail e senha', /Entrar/.test(texto) && /senha/i.test(texto),
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
