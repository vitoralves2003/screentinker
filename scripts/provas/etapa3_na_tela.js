/*
 * ETAPA 3, NUM NAVEGADOR: o modal "Editar conteudo" com o que o Vitor pediu, e so isso.
 *
 *   1. ficam: Nome do arquivo / Exibicao, Contrato do anunciante, Quando pode ser exibido,
 *      Substituir arquivo, Excluir, Pre-visualizar, Cancelar, Salvar alteracoes
 *   2. saem: URL remota, Tipo MIME, Conexao instavel, Ativar legendas, Arquivo de legenda
 *   3. e SALVAR NAO ZERA o que saiu da tela: os cinco valores do arquivo no servidor sao os
 *      mesmos antes e depois de salvar com o nome inalterado
 *
 * O terceiro e o que separa "tirei os campos" de "tirei os campos e quebrei os dados". A prova
 * le o arquivo pela API antes, salva pelo modal sem mudar nada, e le de novo.
 *
 * Sem travessao nem traco de caixa aqui, de proposito: o arquivo viaja por cat|ssh.
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'https://beta.loopplayer.com.br/gestao';
const BASE = process.env.BASE || 'https://beta.loopplayer.com.br';
const TOKEN = process.env.TOKEN || '';

const FICAM = ['Nome do arquivo / Exibi', 'Contrato do anunciante', 'Quando pode ser exibido', 'Substituir arquivo', 'Excluir', 'Pré-visualizar', 'Cancelar', 'Salvar altera'];
const SAEM = ['URL remota', 'Tipo MIME', 'Conexão instável', 'Ativar legendas', 'Arquivo de legenda'];
const CAMPOS_DO_SERVIDOR = ['mime_type', 'remote_url', 'unstable_connection', 'captions_enabled', 'captions_lang', 'subtitle_url'];

(async () => {
  if (!TOKEN) { console.log('SEM SESSAO: passe TOKEN=...'); process.exit(1); }

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
  const lerArquivo = (id) => pagina.evaluate(async (base, tk, id2) => {
    const r = await fetch(base + '/api/content/' + id2, { headers: { Authorization: 'Bearer ' + tk } });
    return r.ok ? r.json() : null;
  }, BASE, TOKEN, id);

  await pagina.goto(UNI + '/arquivos', { waitUntil: 'networkidle0', timeout: 60000 });
  await esperar(() => document.querySelector('table tbody tr button'));

  /* O primeiro arquivo da lista: seu id vem do botao de previa (data-*) ou da linha. */
  const alvo = await pagina.evaluate(() => {
    const tr = document.querySelector('table tbody tr');
    if (!tr) return null;
    const nome = [...tr.querySelectorAll('button')].find((x) => /hover:underline/.test(x.className));
    return nome ? nome.textContent.trim() : null;
  });
  conferir('ha um arquivo para abrir', !!alvo, alvo || '');
  if (!alvo) { await navegador.close(); process.exit(1); }

  /* Descobre o id pelo nome, na API -- e le os cinco campos ANTES. */
  const lista = await pagina.evaluate(async (base, tk) => {
    const r = await fetch(base + '/api/content?limit=500', { headers: { Authorization: 'Bearer ' + tk } });
    return r.ok ? r.json() : [];
  }, BASE, TOKEN);
  const itens = Array.isArray(lista) ? lista : (lista.content || []);
  const item = itens.find((c) => c.filename === alvo);
  conferir('o arquivo existe na API', !!item, alvo);
  if (!item) { await navegador.close(); process.exit(1); }
  const antes = await lerArquivo(item.id);
  conferir('li o arquivo antes de salvar', !!antes);

  /* 1 e 2: o modal mostra o que fica e nao mostra o que saiu */
  console.log('\n-- o modal: o que fica e o que saiu --');
  await pagina.evaluate(() => {
    const tr = document.querySelector('table tbody tr');
    const b = tr && [...tr.querySelectorAll('button')].find((x) => /hover:underline/.test(x.className));
    if (b) b.click();
  });
  await esperar(() => /Editar conte/.test(document.body.innerText || ''));
  /*
   * EM CAIXA ALTA DOS DOIS LADOS. Os rotulos dos campos sao desenhados com `text-transform:
   * uppercase`, e innerText devolve o texto TRANSFORMADO: "NOME DO ARQUIVO / EXIBICAO". A
   * primeira versao comparava com o texto do codigo e reprovou os quatro campos que ficaram --
   * enquanto os botoes (sem uppercase) passavam. Comparar tudo em maiusculas mede o que a
   * pessoa le, e nao como o CSS o escreveu.
   */
  const texto = (await pagina.evaluate(() => document.body.innerText || '')).toUpperCase();
  conferir('o modal abriu', /EDITAR CONTE/.test(texto));
  for (const f of FICAM) conferir('fica: ' + f, texto.includes(f.toUpperCase()));
  for (const s of SAEM) conferir('saiu: ' + s, !texto.includes(s.toUpperCase()));

  /* 3: salvar sem mudar nada nao zera os cinco campos */
  console.log('\n-- salvar com o nome inalterado nao zera o que saiu da tela --');
  await pagina.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /Salvar altera/.test(x.textContent || ''));
    if (b) b.click();
  });
  const fechou = await esperar(() => !/Editar conte/.test(document.body.innerText || '') || /Conteúdo atualizado|Conteudo atualizado|Horários salvos|Horarios salvos/.test(document.body.innerText || ''), 25000);
  conferir('o salvar terminou (modal fechou ou avisou)', !!fechou);
  const depois = await lerArquivo(item.id);
  conferir('li o arquivo depois de salvar', !!depois);
  if (antes && depois) {
    for (const c of CAMPOS_DO_SERVIDOR) {
      const a = antes[c] === undefined ? null : antes[c];
      const d = depois[c] === undefined ? null : depois[c];
      conferir('servidor manteve ' + c, JSON.stringify(a) === JSON.stringify(d), 'antes=' + JSON.stringify(a) + ' depois=' + JSON.stringify(d));
    }
    conferir('e o nome continua o mesmo', depois.filename === antes.filename, depois.filename);
  }

  await navegador.close();
  console.log('');
  if (falhas) { console.log(falhas + ' FALHA(S) na Etapa 3'); process.exit(1); }
  console.log('A ETAPA 3 ESTA NA TELA');
})().catch((e) => { console.error('A PROVA QUEBROU: ' + e.message); process.exit(2); });
