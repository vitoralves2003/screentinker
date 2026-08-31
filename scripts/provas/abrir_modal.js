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

  const arrLista = Array.isArray(listas) ? listas : (listas.playlists || listas.items || []);
  const arrTela = Array.isArray(telas) ? telas : (telas.devices || telas.items || []);

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

    const m = await pagina.evaluate(() => {
      const h = [...document.querySelectorAll('h3')].map((x) => x.textContent.trim());
      const abas = [...document.querySelectorAll('#addItemTabs .tab-btn')]
        .filter((b) => b.style.display !== 'none')
        .map((b) => b.textContent.trim());
      return {
        titulo: h.find((t) => t.includes('Adicionar') || t.includes('Substituir')) || null,
        abas,
        temLista: !!document.getElementById('addItemList'),
        linhas: document.querySelectorAll('#addItemList .add-item-btn').length,
        duracoes: document.querySelectorAll('#addItemList .add-item-dur').length,
      };
    });

    conferir('o modal abre', !!m.titulo, JSON.stringify(m));
    conferir('o titulo diz playlist', (m.titulo || '').includes('playlist'), m.titulo);
    conferir('a aba Ferramentas NAO existe', !m.abas.includes('Ferramentas'), m.abas.join(', '));
    conferir('a aba Conteudo existe', m.abas.includes('Conteúdo'), m.abas.join(', '));
    conferir('o conteudo aparece em LISTA, nao em grade', m.temLista && m.linhas > 0,
      'linhas: ' + m.linhas);

    /*
     * A duracao por item so aparece onde ela e uma escolha. Se a conta de teste so tiver video,
     * zero campos e o resultado certo -- por isso a checagem compara com quantas linhas PEDEM
     * duracao, e nao com "tem pelo menos um".
     */
    const coerente = await pagina.evaluate(() => {
      const btns = [...document.querySelectorAll('#addItemList .add-item-btn')];
      const durs = [...document.querySelectorAll('#addItemList .add-item-dur')];
      return { itens: btns.length, campos: durs.length };
    });
    conferir('cada linha tem no maximo um campo de duracao',
      coerente.campos <= coerente.itens, JSON.stringify(coerente));

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

    // ── a aba de sub-listas ────────────────────────────────────────────────────────────
    const temAbaSub = await pagina.evaluate(() => {
      const b = document.querySelector('#addItemTabs [data-tab="sublists"]');
      return !!b && b.style.display !== 'none';
    });
    if (temAbaSub) {
      const antes = erros.length;
      await pagina.click('#addItemTabs [data-tab="sublists"]');
      await esperar(900);
      conferir('a aba Sub-listas abre sem erro de JavaScript', erros.length === antes,
        erros.slice(antes).join(' | '));
    }

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

    const t = await pagina.evaluate(() => {
      const h = [...document.querySelectorAll('h3')].map((x) => x.textContent.trim());
      return {
        titulo: h.find((x) => x.includes('Adicionar')) || null,
        abas: [...document.querySelectorAll('#addItemTabs .tab-btn')]
          .filter((b) => b.style.display !== 'none').map((b) => b.textContent.trim()),
        linhas: document.querySelectorAll('#addItemList .add-item-btn').length,
      };
    });

    conferir('o modal da tela abre sem erro de JavaScript', erros.length === antes,
      erros.slice(antes).join(' | '));
    conferir('o modal da tela abre', !!t.titulo, JSON.stringify(t));
    conferir('o titulo diz TELA, nao playlist',
      (t.titulo || '') === 'Adicionar à tela', t.titulo);
    conferir('a aba Ferramentas NAO existe aqui tambem',
      !t.abas.includes('Ferramentas'), t.abas.join(', '));
    conferir('a aba Quiosque nao existe', !t.abas.some((a) => a.includes('Quiosque')), t.abas.join(', '));
    conferir('o conteudo aparece em lista', t.linhas > 0, 'linhas: ' + t.linhas);

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
    if (temAbaSub) {
      await pagina.evaluate(() => document.querySelector('#addItemTabs [data-tab="sublists"]').click());
      await esperar(900);
      const oferecidas = await pagina.evaluate(() =>
        [...document.querySelectorAll('#addItemList [data-sub-id], #addItemList .add-sub-btn')]
          .map((b) => b.dataset.subId || b.dataset.id).filter(Boolean));

      const autos = new Set(arrListaAuto);
      const vazou = oferecidas.filter((id) => autos.has(id));
      conferir('nenhum espaco proprio de tela e oferecido como lista',
        vazou.length === 0, vazou.join(', '));
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
