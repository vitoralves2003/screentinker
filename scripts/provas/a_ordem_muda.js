/*
 * A ORDEM DE EXIBIÇÃO MUDA — num navegador, e conferida no BANCO depois.
 *
 * O que a tela exibe tinha ordem fixa: o arrastar da tela antiga não veio no flip, e nem as
 * setas existiam. O servidor sempre soube reordenar; era interface faltando.
 *
 * ── o que só um navegador responde ──────────────────────────────────────────────────────────
 * Que os controles EXISTEM na tela renderizada, que clicar move a linha, e que a página não
 * quebra ao fazer isso. Um teste de rota provaria o servidor, que nunca esteve em dúvida.
 *
 * ── e por que ela lê o banco no fim ─────────────────────────────────────────────────────────
 * Mover na tela é otimista de propósito: a lista muda antes da resposta. Uma prova que só olhasse
 * a tela aprovaria uma interface que reordena bonito e nunca grava — que é exatamente o defeito
 * que a otimização introduz. Quem confirma é o `sort_order`, e quem o lê é o script que chama
 * esta prova.
 *
 * As SETAS são o que se exercita aqui, e não o arrastar: HTML5 drag-and-drop não se dispara por
 * script de forma fiel (o navegador exige uma sequência de eventos de mouse com dataTransfer
 * real, e forjá-la testaria o meu forjador). As setas percorrem o MESMO caminho — a mesma função
 * `reordenar`, a mesma rota — então o que fica sem prova automática é só o gesto do mouse.
 *
 * Roda de /opt/novo-operacao/scripts/provas:
 *   docker run --rm --network host --user root -v "$PWD:/p" -e TOKEN=... -e TELA=<id> \
 *     -e NODE_PATH=/usr/src/app/node_modules --entrypoint node zenika/alpine-chrome:with-puppeteer \
 *     /p/a_ordem_muda.js
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'https://beta.loopplayer.com.br/gestao';
const TOKEN = process.env.TOKEN || '';
const TELA = process.env.TELA || '';

(async () => {
  if (!TOKEN) { console.log('SEM SESSAO: passe TOKEN=...'); process.exit(1); }
  if (!TELA) { console.log('SEM TELA: passe TELA=<id do aparelho>'); process.exit(1); }

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
  /* Espera a lista existir, e não um número de milissegundos: régua a dedo reprova tela boa em
     máquina lenta e aprova tela quebrada em máquina rápida. */
  await pagina.waitForFunction(
    () => document.querySelectorAll('[data-item-da-tela]').length > 0,
    { timeout: 25000, polling: 300 },
  ).catch(() => {});

  const idsNaTela = () => pagina.evaluate(() =>
    [...document.querySelectorAll('[data-item-da-tela]')].map((el) => el.getAttribute('data-item-da-tela')));

  const antes = await idsNaTela();
  console.log('\n── a lista desenhou ──');
  conferir('ha itens nesta tela', antes.length >= 2, antes.length + ' item(ns)');
  if (antes.length < 2) {
    console.log('\nSEM CENARIO: a prova precisa de pelo menos DOIS itens para haver ordem que mude.');
    await navegador.close();
    process.exit(3);
  }
  conferir('sem erro de JavaScript', erros.length === 0, erros.join(' ; '));

  console.log('\n── os controles existem ──');
  const controles = await pagina.evaluate(() => {
    const primeira = document.querySelector('[data-item-da-tela]');
    const botoes = [...primeira.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    return {
      cima: botoes.includes('Mover para cima'),
      baixo: botoes.includes('Mover para baixo'),
      /* Sem `draggable` no elemento, o navegador nem começa o gesto do mouse. */
      arrastavel: primeira.getAttribute('draggable') === 'true',
      /* A frase que explica POR QUE os controles existem: a ordem é o que a tela exibe. */
      explica: /ordem em que a tela exibe/i.test(document.body.innerText || ''),
    };
  });
  conferir('a seta para cima existe', controles.cima);
  conferir('a seta para baixo existe', controles.baixo);
  conferir('a linha e arrastavel', controles.arrastavel);
  conferir('e a tela diz o que a ordem significa', controles.explica);

  console.log('\n── a primeira seta para cima esta desligada ──');
  /* O primeiro item não sobe. Um botão que parece clicável e não faz nada ensina a pessoa a
     desconfiar dos outros. */
  const primeiraCimaDesligada = await pagina.evaluate(() => {
    const b = [...document.querySelector('[data-item-da-tela]').querySelectorAll('button')]
      .find((x) => x.getAttribute('aria-label') === 'Mover para cima');
    return b ? b.disabled : null;
  });
  conferir('a seta de subir do primeiro item esta desabilitada', primeiraCimaDesligada === true,
    'disabled=' + primeiraCimaDesligada);

  console.log('\n── descer o primeiro item ──');
  await pagina.evaluate(() => {
    const b = [...document.querySelector('[data-item-da-tela]').querySelectorAll('button')]
      .find((x) => x.getAttribute('aria-label') === 'Mover para baixo');
    b.click();
  });
  /* Espera a TROCA, e não um tempo: a lista muda antes da resposta do servidor, mas o aviso de
     sucesso só aparece depois — esperar a ordem inverter cobre os dois momentos. */
  await pagina.waitForFunction(
    (primeiro) => {
      const atual = [...document.querySelectorAll('[data-item-da-tela]')].map((el) => el.getAttribute('data-item-da-tela'));
      return atual[0] !== primeiro;
    },
    { timeout: 15000, polling: 200 }, antes[0],
  ).catch(() => {});

  const depois = await idsNaTela();
  conferir('o primeiro item desceu', depois[0] === antes[1] && depois[1] === antes[0],
    'antes=[' + antes.slice(0, 3).join(',') + '] depois=[' + depois.slice(0, 3).join(',') + ']');
  conferir('e nenhum item sumiu no caminho', depois.length === antes.length,
    antes.length + ' -> ' + depois.length);

  const texto = await pagina.evaluate(() => document.body.innerText || '');
  /* A promessa da mensagem é forte: ela diz que a TELA já recebeu. Se um dia a rota parar de
     aplicar no aparelho, esta frase vira mentira e é aqui que se descobre. */
  conferir('a tela avisa que o aparelho ja recebeu', /a tela já recebeu/i.test(texto),
    texto.slice(0, 160).replace(/\n/g, ' | '));
  conferir('sem erro de JavaScript depois de mover', erros.length === 0, erros.join(' ; '));

  console.log('\n── com busca ativa, a tela recusa reordenar ──');
  await pagina.evaluate(() => {
    const campo = [...document.querySelectorAll('input')].find((i) => /Buscar nesta tela/i.test(i.placeholder || ''));
    if (!campo) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(campo, 'a');
    campo.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await pagina.waitForFunction(
    () => /Limpe a busca para mudar a ordem/i.test(document.body.innerText || ''),
    { timeout: 8000, polling: 200 },
  ).catch(() => {});
  const comBusca = await pagina.evaluate(() => ({
    explica: /Limpe a busca para mudar a ordem/i.test(document.body.innerText || ''),
    aindaArrastavel: document.querySelector('[data-item-da-tela]')?.getAttribute('draggable') === 'true',
  }));
  /* Não basta desligar: sumir com o controle sem explicar faz a pessoa procurar o que sumiu. */
  conferir('a tela explica por que nao da para reordenar', comBusca.explica);
  conferir('e o arrastar fica desligado', comBusca.aindaArrastavel === false);

  /* Devolve a ordem original: uma prova que deixa a tela de outra pessoa reordenada é uma prova
     que mexeu no produto. */
  console.log('\n── devolvendo a ordem original ──');
  await pagina.evaluate(() => {
    const campo = [...document.querySelectorAll('input')].find((i) => /Buscar nesta tela/i.test(i.placeholder || ''));
    if (!campo) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(campo, '');
    campo.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await pagina.waitForFunction(() => document.querySelectorAll('[data-item-da-tela]').length > 1,
    { timeout: 8000, polling: 200 }).catch(() => {});
  await pagina.evaluate(() => {
    const linhas = [...document.querySelectorAll('[data-item-da-tela]')];
    const b = [...linhas[1].querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === 'Mover para cima');
    if (b) b.click();
  });
  await pagina.waitForFunction(
    (primeiro) => {
      const atual = [...document.querySelectorAll('[data-item-da-tela]')].map((el) => el.getAttribute('data-item-da-tela'));
      return atual[0] === primeiro;
    },
    { timeout: 15000, polling: 200 }, antes[0],
  ).catch(() => {});
  const final = await idsNaTela();
  conferir('a ordem voltou ao que era', JSON.stringify(final) === JSON.stringify(antes),
    'original=[' + antes.slice(0, 3).join(',') + '] final=[' + final.slice(0, 3).join(',') + ']');

  await navegador.close();
  console.log('');
  if (falhas) { console.log(falhas + ' FALHA(S) na ordem'); process.exit(1); }
  console.log('A ORDEM DE EXIBICAO MUDA');
})().catch((e) => { console.error('A PROVA QUEBROU: ' + e.message); process.exit(2); });
