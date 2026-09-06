/*
 * ETAPA 2, NUM NAVEGADOR: a aprovacao no lugar certo.
 *
 *   1. o cartao Alertas do painel diz que ha midia esperando aprovacao, e leva a fila
 *   2. na fila, cada peca tem miniatura, e clicar nela abre a previa (o video de verdade)
 *   3. a peca pendente NAO aparece em Arquivos nem no modal "Adicionar a tela"
 *   4. mas continua na aba Midias do contrato, no bloco de pendentes -- e onde se decide
 *
 * A prova NAO aprova nem recusa nada: a peca pendente do staging e real (o Vitor subiu), e
 * decidir por ele seria decidir por ele. Sem pendente ela PARA (saida 4) em vez de reprovar.
 *
 * Sem travessao nem traco de caixa aqui, de proposito: o arquivo viaja por cat|ssh.
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'https://beta.loopplayer.com.br/gestao';
const TOKEN = process.env.TOKEN || '';
const PENDENTE = process.env.PENDENTE || '';     // nome do arquivo pendente
const CONTRATO = process.env.CONTRATO || '';     // id do contrato dele

(async () => {
  if (!TOKEN) { console.log('SEM SESSAO: passe TOKEN=...'); process.exit(1); }
  if (!PENDENTE || !CONTRATO) { console.log('SEM PENDENTE PARA MEDIR: passe PENDENTE=<nome> CONTRATO=<id>'); process.exit(4); }

  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const pagina = await navegador.newPage();
  await pagina.setViewport({ width: 1366, height: 900 });
  await pagina.evaluateOnNewDocument((tk) => {
    localStorage.setItem('token', tk);
    localStorage.setItem('loop_os_token', tk);
  }, TOKEN);

  let falhas = 0;
  const conferir = (o_que, condicao, detalhe) => {
    console.log('  ' + (condicao ? 'ok    ' : 'FALHA ') + o_que + (detalhe ? '   ' + detalhe : ''));
    if (!condicao) falhas++;
  };
  const esperar = (fn, ms, arg) => pagina.waitForFunction(fn, { timeout: ms || 25000, polling: 300 }, arg).catch(() => null);
  const texto = () => pagina.evaluate(() => document.body.innerText || '');

  /* 1: o cartao Alertas */
  console.log('\n-- o painel: Alertas diz que ha midia esperando --');
  await pagina.goto(UNI + '/dashboard', { waitUntil: 'networkidle0', timeout: 60000 });
  const temAlerta = await esperar(() => /espera(m)? sua aprova/i.test(document.body.innerText || ''), 30000);
  conferir('o alerta "midia ... espera sua aprovacao" esta no painel', !!temAlerta,
    (await texto()).match(/.{0,40}espera(m)? sua aprova.{0,20}/i)?.[0] || '');
  const tituloTraduzido = await pagina.evaluate(() => /Mídia de anunciante esperando aprovação|Midia de anunciante esperando aprovacao/.test(document.body.innerText || ''));
  conferir('e o titulo esta em portugues (nao a chave MEDIA_AWAITING_APPROVAL)', tituloTraduzido && !/MEDIA_AWAITING_APPROVAL/.test(await texto()));

  /* 2: a fila, com miniatura e previa */
  console.log('\n-- a fila: miniatura que abre a previa --');
  await pagina.goto(UNI + '/aprovacoes', { waitUntil: 'networkidle0', timeout: 60000 });
  await esperar((nome) => (document.body.innerText || '').includes(nome), 25000, PENDENTE);
  /* A miniatura e uma imagem AUTENTICADA: o componente baixa o arquivo com o token e so entao
     desenha o <img>. Olhar uma vez, logo que o cartao aparece, reprovou uma fila certa (rodada
     16 e a rodada seguinte). Espera-se pelo <img> dentro do botao, nao por milissegundos. */
  await esperar((nome) => {
    const card = [...document.querySelectorAll('[data-pedido]')].find((d) => (d.textContent || '').includes(nome));
    const btn = card && card.querySelector('button[data-previa]');
    return !!(btn && btn.querySelector('img'));
  }, 20000, PENDENTE);
  const linha = await pagina.evaluate((nome) => {
    const card = [...document.querySelectorAll('[data-pedido]')].find((d) => (d.textContent || '').includes(nome));
    if (!card) return null;
    const btn = card.querySelector('button[data-previa]');
    return { temBotao: !!btn, temImg: !!(btn && btn.querySelector('img')) };
  }, PENDENTE);
  conferir('a peca pendente esta na fila', !!linha, PENDENTE);
  if (linha) {
    conferir('e tem o botao de previa', linha.temBotao);
    conferir('com miniatura de verdade', linha.temImg);
    await pagina.evaluate((nome) => {
      const card = [...document.querySelectorAll('[data-pedido]')].find((d) => (d.textContent || '').includes(nome));
      const btn = card && card.querySelector('button[data-previa]');
      if (btn) btn.click();
    }, PENDENTE);
    /* A previa e um <video> com o link assinado -- espera-se pelo elemento, nao por milissegundos. */
    const video = await esperar(() => {
      const v = document.querySelector('video');
      /* 06/09: a prévia carrega pelo link assinado, direto na tag — não mais por blob. */
      return v && v.src && (v.src.startsWith('blob:') || v.src.includes('/api/content/'));
    }, 30000);
    conferir('clicar abre a previa com o VIDEO carregado', !!video);
    /* E os botoes de decidir continuam na fila, atras do modal -- a previa nao decide nada. */
    const decidir = await pagina.evaluate(() => /Aprovar/.test(document.body.innerText || '') && /Recusar/.test(document.body.innerText || ''));
    conferir('Aprovar/Recusar continuam la (a previa nao decide)', decidir);
  }

  /* 3: Arquivos e o modal nao mostram a pendente */
  console.log('\n-- Arquivos e "Adicionar a tela": a pendente nao aparece --');
  await pagina.goto(UNI + '/arquivos', { waitUntil: 'networkidle0', timeout: 60000 });
  await esperar(() => document.querySelectorAll('table tbody tr').length > 0, 25000);
  const emArquivos = await pagina.evaluate((nome) => (document.body.innerText || '').includes(nome), PENDENTE);
  const totalArquivos = await pagina.evaluate(() => document.querySelectorAll('table tbody tr').length);
  conferir('a lista de Arquivos tem linhas (a guarda contra medir vazio)', totalArquivos > 0, totalArquivos + ' linhas');
  conferir('e a pendente NAO esta nela', !emArquivos, PENDENTE);

  await pagina.goto(UNI + '/telas', { waitUntil: 'networkidle0', timeout: 60000 });
  await esperar(() => document.querySelector('a[href*="/telas/"]'));
  const tela = await pagina.evaluate(() => { const a = document.querySelector('a[href*="/telas/"]'); return a ? a.getAttribute('href') : null; });
  if (tela) {
    const destino = tela.startsWith('http') ? tela : (tela.startsWith('/gestao') ? 'https://beta.loopplayer.com.br' + tela : UNI + tela);
    await pagina.goto(destino, { waitUntil: 'networkidle0', timeout: 60000 });
    await esperar(() => /Adicionar m[ií]dia/.test(document.body.innerText || ''));
    await pagina.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /Adicionar m[ií]dia/.test(x.textContent)); if (b) b.click(); });
    await esperar(() => /Adicionar (a|à) tela/.test(document.body.innerText || '') && document.querySelectorAll('li').length > 3);
    const noModal = await pagina.evaluate((nome) => [...document.querySelectorAll('li')].some((li) => (li.textContent || '').includes(nome)), PENDENTE);
    const linhasModal = await pagina.evaluate(() => document.querySelectorAll('li').length);
    conferir('o modal lista arquivos (guarda)', linhasModal > 3, linhasModal + ' linhas');
    conferir('e a pendente NAO esta no modal', !noModal, PENDENTE);
  } else {
    conferir('ha uma tela para abrir o modal', false);
  }

  /* 4: a aba Midias do contrato ainda a mostra, no bloco de pendentes */
  console.log('\n-- a aba Midias do contrato: a pendente segue la, onde se decide --');
  await pagina.goto(UNI + '/contratos/' + CONTRATO + '?aba=midias', { waitUntil: 'networkidle0', timeout: 60000 });
  await esperar(() => /M(í|i)dias/.test(document.body.innerText || ''), 25000);
  /* A aba pode nao abrir sozinha pelo query: clica nela se existir. */
  await pagina.evaluate(() => { const t = [...document.querySelectorAll('button, a')].find((x) => /^M(í|i)dias$/.test((x.textContent || '').trim())); if (t) t.click(); });
  const naAba = await esperar((nome) => (document.body.innerText || '').includes(nome), 25000, PENDENTE);
  conferir('a pendente aparece na aba Midias do contrato', !!naAba, PENDENTE);
  const comDecisao = await pagina.evaluate(() => /Aprovar/.test(document.body.innerText || ''));
  conferir('com o botao de Aprovar ao lado', comDecisao);

  await navegador.close();
  console.log('');
  if (falhas) { console.log(falhas + ' FALHA(S) na Etapa 2'); process.exit(1); }
  console.log('A ETAPA 2 ESTA NA TELA');
})().catch((e) => { console.error('A PROVA QUEBROU: ' + e.message); process.exit(2); });
