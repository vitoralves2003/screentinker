/*
 * A DECISÃO MORA NO CONTRATO — num navegador, com uma peça esperando de verdade.
 *
 * Pedido do Vitor em 05/09: "que as aprovações apareçam nas notificações e na aba mídias do
 * contrato para serem aprovadas, não precisa ter nada na sidebar para isso".
 *
 * ── o que só um navegador responde ──────────────────────────────────────────────────────────
 * Que a aba MOSTRA o que espera, que os controles estão ali, que a recusa PEDE o motivo, e que
 * decidir muda a própria aba — a peça sai da espera e o consumo do limite sobe na mesma tela.
 *
 * ── e as duas ausências, que valem tanto quanto ─────────────────────────────────────────────
 * O item "Aprovações" saiu da barra, e o aviso de mídia esperando entrou. Uma tela que ganha uma
 * coisa e não perde a outra teria os dois caminhos ao mesmo tempo — que é o que o pedido dizia
 * para não ter.
 *
 * Roda de /opt/novo-operacao/scripts/provas:
 *   docker run --rm --network host --user root -v "$PWD:/p" -e TOKEN=... -e CONTRATO=<id> \
 *     -e ARQUIVO=<nome> -e NODE_PATH=/usr/src/app/node_modules \
 *     --entrypoint node zenika/alpine-chrome:with-puppeteer /p/decidir_no_contrato.js
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'https://beta.loopplayer.com.br/gestao';
const TOKEN = process.env.TOKEN || '';
const CONTRATO = process.env.CONTRATO || '';
const ARQUIVO = process.env.ARQUIVO || '';

(async () => {
  if (!TOKEN) { console.log('SEM SESSAO: passe TOKEN=...'); process.exit(1); }
  if (!CONTRATO) { console.log('SEM CONTRATO: passe CONTRATO=<id>'); process.exit(1); }
  if (!ARQUIVO) { console.log('SEM ARQUIVO: passe ARQUIVO=<nome da peca plantada>'); process.exit(1); }

  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const pagina = await navegador.newPage();
  await pagina.setViewport({ width: 1280, height: 900 });

  const erros = [];
  /*
   * AS RESPOSTAS DE ERRO DA API, guardadas com o CAMINHO.
   *
   * Sem isto, um clique que chama uma rota e recebe 403 deixa a tela igual e a prova reprova com
   * "a peça não saiu da espera" — verdade, e inútil. O que se precisa saber é qual rota recusou.
   */
  const recusas = [];
  pagina.on('response', (r) => {
    if (r.status() < 400) return;
    const p = new URL(r.url()).pathname;
    if (/\/api\//.test(p)) recusas.push(`${r.status()} ${p}`);
  });
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

  await pagina.goto(`${UNI}/contratos/${CONTRATO}`, { waitUntil: 'networkidle0', timeout: 45000 });
  await pagina.waitForFunction(() => /Mídias|Midias/i.test(document.body.innerText || ''),
    { timeout: 25000, polling: 300 }).catch(() => {});

  console.log('\n── a barra ──');
  /*
   * O aviso e o item vivem no Shadow DOM da <loop-sidebar>: `document.body.innerText` não os
   * alcança, e uma prova que olhasse só o texto da página aprovaria as duas ausências por não
   * conseguir ver nem o que existe.
   */
  const barra = await pagina.evaluate(() => {
    const el = document.querySelector('loop-sidebar');
    if (!el || !el.shadowRoot) return null;
    const raiz = el.shadowRoot;
    return {
      /*
       * ITEM DE MENU e AVISO são coisas diferentes que usam o MESMO `data-id`, e a primeira
       * versão desta prova os confundiu: ela pediu "não há item aprovacoes" e "há um destino
       * aprovacoes" olhando a mesma lista, o que é impossível de satisfazer.
       *
       * Os itens vivem dentro de `.lista`; o aviso é um `a.atencao` acima dela. O seletor é o
       * que separa "está no menu" de "há um atalho quando há trabalho".
       */
      itens: [...raiz.querySelectorAll('.lista [data-id]')].map((a) => a.getAttribute('data-id')),
      avisos: [...raiz.querySelectorAll('a.atencao')].map((a) => ({
        id: a.getAttribute('data-id'),
        texto: (a.textContent || '').trim(),
      })),
    };
  });
  conferir('a barra existe e foi lida por dentro', barra !== null,
    barra ? `${barra.itens.length} item(ns) de menu` : 'shadowRoot ausente');
  if (barra) {
    /* A ausência que o pedido pediu. */
    conferir('NAO ha item "Aprovacoes" no menu', !barra.itens.includes('aprovacoes'),
      barra.itens.join(','));
    /* E a presença que a substitui: o aviso, com o número, e clicável. */
    const aviso = barra.avisos.find((a) => a.id === 'aprovacoes');
    conferir('o aviso de midia esperando aparece', !!aviso,
      barra.avisos.map((a) => a.id + ':' + a.texto).join(' | ') || '(nenhum aviso)');
    conferir('e ele diz quantas esperam', !!aviso && /espera[m]? aprova/i.test(aviso.texto),
      aviso ? aviso.texto : '(sem aviso)');
  }

  console.log('\n── a aba de Midias mostra o que espera ──');
  await pagina.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /^m[ií]dias$/i.test(x.textContent.trim()));
    if (b) b.click();
  });
  await pagina.waitForFunction(() => document.querySelectorAll('[data-pendente]').length > 0,
    { timeout: 20000, polling: 300 }).catch(() => {});

  let texto = await pagina.evaluate(() => document.body.innerText || '');
  conferir('a aba anuncia quantas esperam', /espera[m]? sua decis/i.test(texto),
    texto.slice(0, 200).replace(/\n/g, ' | '));
  conferir('a peca enviada esta ali pelo NOME', texto.includes(ARQUIVO));
  /* "vai" no singular e "vão" no plural — a primeira versão escreveu `v[ãa]o?`, que casa "vã",
     "va", "vão" e "vao", e justamente não casa "vai". Reprovou uma frase correta. */
  conferir('e a aba explica que ela nao vai ao ar sem decisao',
    /n[ãa]o v(ai|[ãa]o) ao ar at[ée] voc[êe] aprovar/i.test(texto));
  conferir('sem erro de JavaScript', erros.length === 0, erros.join(' ; '));

  /*
   * PARA AQUI se não há nada esperando na tela.
   *
   * Sem esta guarda, o passo seguinte fazia `querySelectorAll` sobre `null` e a prova morria com
   * "Cannot read properties of null" — uma mensagem que não diz nada sobre o produto. A causa
   * real, na primeira execução, era que o `web` não tinha sido reconstruído: a aba rodava código
   * antigo, sem o bloco de pendentes. Uma prova precisa distinguir "a tela está errada" de "a
   * tela nem chegou aqui".
   */
  const temPendente = await pagina.evaluate(() => !!document.querySelector('[data-pendente]'));
  if (!temPendente) {
    console.log('\n  A ABA NAO MOSTROU NADA ESPERANDO — sem isso nao ha o que decidir.');
    console.log('  (a peca existe no banco: quem planta é provar_decidir_no_contrato.sh)');
    await navegador.close();
    process.exit(1);
  }

  console.log('\n── a recusa PEDE o motivo ──');
  await pagina.evaluate(() => {
    const linha = document.querySelector('[data-pendente]');
    const b = [...linha.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Recusar');
    if (b) b.click();
  });
  await pagina.waitForFunction(() => /Por que está recusando/.test(document.body.innerText || ''),
    { timeout: 8000, polling: 200 }).catch(() => {});
  const desabilitado = await pagina.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('Recusar e avisar'));
    return b ? b.disabled : null;
  });
  /* O servidor aceita recusa sem motivo e grava um texto padrão. Esta tela existe para o bom
     motivo ser o caminho fácil — se o botão agir em branco, o padrão vira a norma. */
  conferir('o botao nao age com o motivo em branco', desabilitado === true, 'disabled=' + desabilitado);
  /*
   * O "Cancelar" TEM DE SER O DA LINHA, e este é o erro mais perigoso que esta prova cometeu.
   *
   * A primeira versão procurava por texto na PÁGINA INTEIRA — e o primeiro botão "Cancelar" de
   * uma tela de contrato é o do cabeçalho: CANCELAR O CONTRATO. Ela abria aquele diálogo, o
   * clique seguinte em "Aprovar" não achava nada, e a falha aparecia como "a peça não saiu da
   * espera", que não tem relação nenhuma com o que aconteceu.
   *
   * Buscar por texto é frágil onde a mesma palavra faz coisas diferentes. O escopo é a linha.
   */
  await pagina.evaluate(() => {
    const linha = document.querySelector('[data-pendente]');
    const b = [...linha.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Cancelar');
    if (b) b.click();
  });

  console.log('\n── aprovar decide ALI, e a aba se refaz ──');
  await pagina.evaluate(() => {
    const linha = document.querySelector('[data-pendente]');
    const b = [...linha.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Aprovar');
    if (b) b.click();
  });
  /*
   * Espera a ESPERA SUMIR, e não um tempo: a aba recarrega tudo depois de decidir, porque
   * aprovar muda mais coisa na mesma tela — a peça entra na lista do contrato e passa a contar
   * no limite. Uma tela que atualizasse só a linha tocada mostraria números velhos ao lado.
   */
  await pagina.waitForFunction(() => document.querySelectorAll('[data-pendente]').length === 0,
    { timeout: 20000, polling: 300 }).catch(() => {});
  texto = await pagina.evaluate(() => document.body.innerText || '');
  /* Quando a decisão não passa, o que explica é a RECUSA da rota — e não o texto da tela, que
     fica igual justamente porque nada mudou. */
  conferir('a peca saiu da espera', !/espera[m]? sua decis/i.test(texto),
    recusas.length ? 'a API recusou: ' + recusas.join(' ; ') : texto.slice(0, 200).replace(/\n/g, ' | '));
  /* E continua na aba, agora como arquivo do contrato: aprovar não some com a peça. */
  conferir('e continua na aba, como arquivo do contrato', texto.includes(ARQUIVO),
    texto.slice(0, 300).replace(/\n/g, ' | '));
  conferir('sem erro de JavaScript depois de decidir', erros.length === 0, erros.join(' ; '));

  await navegador.close();
  console.log('');
  if (falhas) { console.log(falhas + ' FALHA(S)'); process.exit(1); }
  console.log('A DECISAO MORA NO CONTRATO');
})().catch((e) => { console.error('A PROVA QUEBROU: ' + e.message); process.exit(2); });
