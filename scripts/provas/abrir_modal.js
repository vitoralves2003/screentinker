/*
 * ABRE O MODAL DE ADICIONAR ITENS NUM NAVEGADOR DE VERDADE -- nos dois lugares que o usam.
 *
 * ── POR QUE ISTO EXISTE ──────────────────────────────────────────────────────────────────
 * `provar_abrir.sh` abre /app#/ e /gestao/dashboard. Nenhuma das duas carrega views/playlists.js
 * nem views/device-detail.js, e nenhuma clica em coisa nenhuma. Entao o modal -- que so passa a
 * existir quando alguem clica em "Adicionar" -- ficava inteiramente fora do alcance das provas,
 * e ele acabou de MUDAR DE CASA: saiu de views/playlists.js para components/.
 *
 * Uma mudanca de casa quebra pelo que fica para tras. Ja aconteceu duas vezes hoje:
 * `hydrateAuthImages` e `CATALOGO` vieram no codigo e ficaram de fora dos imports. Nenhum dos
 * dois e erro de sintaxe -- `node --check` passa, o servidor nao reclama, o arquivo carrega. Sao
 * ReferenceError no instante em que a linha roda, ou seja: ao abrir uma aba especifica do modal,
 * que e o unico lugar que nenhuma prova visitava.
 *
 * Esta prova vai ate la e clica.
 *
 * ── COMO RODA ────────────────────────────────────────────────────────────────────────────
 *   docker run --rm --network host -v "$PWD/scripts/provas:/p" \
 *     zenika/alpine-chrome:with-puppeteer node /p/abrir_modal.js
 */
const puppeteer = require('puppeteer');

const BASE = process.env.BASE || 'http://127.0.0.1:3110';
const TOKEN = process.env.TOKEN || '';

let passou = 0;
let falhou = 0;

function conferir(nome, ok, detalhe) {
  if (ok) {
    passou++;
    console.log('  ok    ' + nome);
  } else {
    falhou++;
    console.log('  FALHA ' + nome + (detalhe ? '  -> ' + detalhe : ''));
  }
}

(async () => {
  if (!TOKEN) {
    console.log('SEM SESSAO: passe TOKEN=... no ambiente (ver mfa_lib.sh)');
    process.exit(1);
  }

  // Um alvo de cada: a prova precisa de uma lista e de uma tela que existam de verdade.
  const cab = { Authorization: 'Bearer ' + TOKEN };
  const listas = await (await fetch(BASE + '/api/playlists', { headers: cab })).json();
  const telas = await (await fetch(BASE + '/api/devices', { headers: cab })).json();
  const arquivos = await (await fetch(BASE + '/api/content', { headers: cab })).json();

  const arrLista = Array.isArray(listas) ? listas : (listas.playlists || listas.items || []);
  const arrTela = Array.isArray(telas) ? telas : (telas.devices || telas.items || []);
  const arrArquivo = Array.isArray(arquivos) ? arquivos : (arquivos.content || arquivos.items || []);

  /*
   * QUANTAS LINHAS A ABA DE CONTEUDO DEVE DESENHAR, e quantas devem trazer campo de duracao.
   *
   * A primeira versao desta prova exigia "pelo menos uma linha" e ficou vermelha numa conta de
   * teste que tem zero arquivos -- acusando o produto por uma condicao dos DADOS. Comparar com o
   * que a API respondeu nao tem esse defeito: numa conta vazia, zero linhas e a resposta certa,
   * e numa conta com arquivos qualquer some vira falha.
   */
  const ehVideo = (c) => String(c.mime_type || '').startsWith('video/');
  const esperado = {
    linhas: arrArquivo.length,
    // Video nao pergunta duracao: a duracao dele e a dele.
    duracoes: arrArquivo.filter((c) => !ehVideo(c) && !c.duration_sec).length,
  };

  /*
   * A lista tem de ser uma que alguem MONTOU, nao o espaco proprio de uma tela. As automaticas
   * existem por tela e nao aparecem na pagina de listas -- abrir uma delas mediria uma tela que
   * a pagina nunca oferece.
   */
  const lista = arrLista.find((p) => !p.is_auto_generated) || arrLista[0];
  const tela = arrTela[0];

  // Os espacos proprios das telas, para conferir mais abaixo que nenhum deles e oferecido.
  const arrListaAuto = arrLista.filter((p) => p.is_auto_generated).map((p) => p.id);

  if (!lista || !tela) {
    console.log('SEM DADOS: e preciso ao menos uma playlist e uma tela na conta de teste');
    console.log('  listas: ' + arrLista.length + ', telas: ' + arrTela.length);
    process.exit(1);
  }

  console.log('conta medida: ' + arrArquivo.length + ' arquivo(s), ' + arrLista.length
    + ' lista(s), ' + arrTela.length + ' tela(s)');
  if (!arrArquivo.length) {
    console.log('  aviso: sem arquivos, a aba Conteudo so pode ser medida vazia -- as abas');
    console.log('         Widgets e Playlists ainda sao medidas por inteiro');
  }

  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const pagina = await navegador.newPage();

  const erros = [];
  pagina.on('pageerror', (e) => erros.push('pageerror: ' + e.message));
  pagina.on('console', (m) => { if (m.type() === 'error') erros.push('console.error: ' + m.text()); });

  await pagina.evaluateOnNewDocument((t) => {
    localStorage.setItem('token', t);
    localStorage.setItem('user', '{}');
  }, TOKEN);

  const esperar = (ms) => new Promise((s) => setTimeout(s, ms));

  /*
   * LE O MODAL, E SO O MODAL.
   *
   * A primeira versao procurava `h3` na pagina inteira e leu o titulo de OUTRO dialogo que
   * estava no DOM atras dele -- e me fez suspeitar do produto quando o produto estava certo. O
   * titulo do modal e o h3 irmao de #addItemTabs; ancorar nele nao tem como pegar outro.
   */
  function lerModal() {
    const abas = document.getElementById('addItemTabs');
    if (!abas) return { titulo: null, abas: [], temLista: false, linhas: 0, duracoes: 0 };
    const cartao = abas.parentElement;
    const h = cartao.querySelector('h3');
    return {
      titulo: h ? h.textContent.trim() : null,
      abas: [...abas.querySelectorAll('.tab-btn')]
        .filter((b) => b.style.display !== 'none')
        .map((b) => b.textContent.trim()),
      temLista: !!cartao.querySelector('#addItemList'),
      linhas: cartao.querySelectorAll('#addItemList .add-item-btn').length,
      duracoes: cartao.querySelectorAll('#addItemList .add-item-dur').length,
    };
  }

  // ══ A LISTA ═══════════════════════════════════════════════════════════════════════════
  console.log('\n=== A PAGINA DE LISTAS ===');
  await pagina.goto(BASE + '/app#/playlists/' + lista.id, { waitUntil: 'networkidle2', timeout: 30000 });
  await esperar(2500);

  const errosDaLista = erros.length;
  conferir('a pagina de listas carrega sem erro de JavaScript', errosDaLista === 0, erros.join(' | '));

  const temBotao = await pagina.evaluate(() => !!document.getElementById('addItemBtn'));
  conferir('o botao de adicionar existe', temBotao);

  if (temBotao) {
    await pagina.click('#addItemBtn');
    await esperar(1200);

    const m = await pagina.evaluate(lerModal);

    conferir('o modal abre', !!m.titulo, JSON.stringify(m));
    conferir('o titulo diz playlist', (m.titulo || '').includes('playlist'), m.titulo);
    conferir('a aba Ferramentas NAO existe', !m.abas.includes('Ferramentas'), m.abas.join(', '));
    conferir('a aba Conteudo existe', m.abas.includes('Conteúdo'), m.abas.join(', '));
    conferir('a aba NAO diz "Sub-listas" -- o nome e Playlists',
      !m.abas.some((a) => a.toLowerCase().includes('sub-lista')), m.abas.join(', '));
    conferir('o conteudo aparece em LISTA, um arquivo por linha',
      m.temLista && m.linhas === esperado.linhas,
      'desenhou ' + m.linhas + ', a API tem ' + esperado.linhas);
    conferir('so o que PODE escolher duracao tem o campo',
      m.duracoes === esperado.duracoes,
      'desenhou ' + m.duracoes + ', esperado ' + esperado.duracoes);

    // ── a aba de widgets: onde o CATALOGO orfao teria estourado ────────────────────────
    const temAbaWidgets = await pagina.evaluate(() => {
      const b = document.querySelector('#addItemTabs [data-tab="widgets"]');
      return !!b && b.style.display !== 'none';
    });

    if (temAbaWidgets) {
      const antes = erros.length;
      await pagina.click('#addItemTabs [data-tab="widgets"]');
      await esperar(900);
      conferir('a aba Widgets abre sem erro de JavaScript', erros.length === antes,
        erros.slice(antes).join(' | '));

      const w = await pagina.evaluate(() => ({
        linhas: document.querySelectorAll('#addItemList .cat-add').length,
        duracoes: document.querySelectorAll('#addItemList .cat-dur').length,
        nomes: [...document.querySelectorAll('#addItemList .catalogue-row')].length,
      }));
      conferir('o catalogo de widgets desenha', w.linhas > 0, JSON.stringify(w));
      conferir('TODO widget pergunta a duracao', w.duracoes === w.linhas, JSON.stringify(w));
    } else {
      console.log('  --    aba Widgets escondida pelo plano; nao ha o que medir aqui');
    }

    /*
     * NA PLAYLIST, A ABA DE PLAYLISTS NAO EXISTE.
     *
     * Uma lista dentro de outra e uma camada a mais para o player resolver na exibicao, e ela
     * nao paga por si: a tela ja e onde as listas se juntam, lado a lado. Decisao do Vitor em
     * 31/08/2026.
     */
    const temAbaSub = await pagina.evaluate(() => {
      const b = document.querySelector('#addItemTabs [data-tab="sublists"]');
      return !!b && b.style.display !== 'none';
    });
    conferir('a aba Playlists NAO e oferecida dentro de uma playlist', !temAbaSub);

    await pagina.evaluate(() => document.getElementById('closeAddModal')?.click());
    await esperar(400);
  }

  // ══ A TELA ════════════════════════════════════════════════════════════════════════════
  console.log('\n=== A PAGINA DA TELA ===');
  const antesDaTela = erros.length;
  await pagina.goto(BASE + '/app#/device/' + tela.id, { waitUntil: 'networkidle2', timeout: 30000 });
  await esperar(3000);

  conferir('a pagina da tela carrega sem erro de JavaScript', erros.length === antesDaTela,
    erros.slice(antesDaTela).join(' | '));

  const abas = await pagina.evaluate(() =>
    [...document.querySelectorAll('[data-tab]')].map((b) => b.textContent.trim()).filter(Boolean));
  conferir('a aba Conteudos existe', abas.some((a) => a.includes('Conteúdo')), abas.join(', '));

  // A aba de conteudos e onde o botao vive; ela pode nao estar ativa no primeiro desenho.
  await pagina.evaluate(() => {
    const b = [...document.querySelectorAll('[data-tab]')].find((x) => x.textContent.includes('Conteúdo'));
    if (b) b.click();
  });
  await esperar(1200);

  const temBotaoTela = await pagina.evaluate(() => {
    const b = document.getElementById('addContentBtn');
    return !!b && b.offsetParent !== null;
  });
  conferir('o botao de adicionar conteudo esta VISIVEL na tela', temBotaoTela);

  if (temBotaoTela) {
    const antes = erros.length;
    await pagina.click('#addContentBtn');
    await esperar(1500);

    const t = await pagina.evaluate(lerModal);

    conferir('o modal da tela abre sem erro de JavaScript', erros.length === antes,
      erros.slice(antes).join(' | '));
    conferir('o modal da tela abre', !!t.titulo, JSON.stringify(t));
    conferir('o titulo diz TELA, nao playlist',
      (t.titulo || '') === 'Adicionar à tela', t.titulo);
    conferir('a aba Ferramentas NAO existe aqui tambem',
      !t.abas.includes('Ferramentas'), t.abas.join(', '));
    conferir('a aba Quiosque nao existe', !t.abas.some((a) => a.includes('Quiosque')), t.abas.join(', '));
    conferir('a aba NAO diz "Sub-listas" aqui tambem',
      !t.abas.some((a) => a.toLowerCase().includes('sub-lista')), t.abas.join(', '));
    conferir('o conteudo aparece em lista, um arquivo por linha',
      t.linhas === esperado.linhas,
      'desenhou ' + t.linhas + ', a API tem ' + esperado.linhas);

    /*
     * O ESPACO PROPRIO DAS TELAS NAO E OFERECIDO. Uma lista is_auto_generated e o espaco de
     * ALGUMA tela; oferece-la aqui seria oferecer "ponha esta tela dentro de outra", e a
     * propria seria "dentro dela mesma", que o servidor recusa. Oferecer o que so pode dar
     * erro e pior que nao oferecer.
     */
    const temAbaSub = await pagina.evaluate(() => {
      const b = document.querySelector('#addItemTabs [data-tab="sublists"]');
      return !!b && b.style.display !== 'none';
    });
    conferir('a aba Playlists E oferecida numa tela', temAbaSub);

    if (temAbaSub) {
      await pagina.evaluate(() => document.querySelector('#addItemTabs [data-tab="sublists"]').click());
      await esperar(900);
      const oferecidas = await pagina.evaluate(() =>
        [...document.querySelectorAll('#addItemList .sub-add')].map((b) => b.dataset.id).filter(Boolean));

      const autos = new Set(arrListaAuto);
      const vazou = oferecidas.filter((id) => autos.has(id));
      conferir('nenhum espaco proprio de tela e oferecido como lista',
        vazou.length === 0, vazou.join(', '));

      /*
       * E A CHECAGEM QUE FALTAVA: uma playlist que PODE entrar tem de APARECER.
       *
       * A versao anterior desta prova so olhava o que nao devia estar la, e por isso ficou verde
       * enquanto o Vitor via a aba vazia. Uma prova que so confere ausencias nao ve a ausencia
       * que importa. O esperado sai da propria API: toda lista que nao e automatica e nao e o
       * espaco desta tela.
       */
      const podem = arrLista
        .filter((p) => !p.is_auto_generated)
        .filter((p) => p.id !== tela.playlist_id)
        .map((p) => p.id);
      const faltando = podem.filter((id) => !oferecidas.includes(id));
      conferir('toda playlist reaproveitavel aparece na aba',
        faltando.length === 0,
        'nao apareceram: ' + faltando.length + ' de ' + podem.length);
      if (!podem.length) {
        console.log('  --    a conta nao tem nenhuma playlist reaproveitavel; a aba vazia e a');
        console.log('        resposta certa aqui, e nao um defeito');
      }
    }
  }

  console.log('\n=== ERROS DE JAVASCRIPT NO TOTAL ===');
  console.log(erros.length ? erros.map((e) => '  ' + e).join('\n') : '  nenhum');

  await navegador.close();

  console.log('\n' + passou + ' passaram, ' + falhou + ' falharam');
  process.exit(falhou === 0 && erros.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('A PROVA QUEBROU: ' + e.message);
  process.exit(1);
});
