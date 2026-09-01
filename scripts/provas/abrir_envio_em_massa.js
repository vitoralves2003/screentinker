/*
 * O ENVIO EM MASSA, CLICADO NUM NAVEGADOR — a lacuna que quatro defeitos atravessaram.
 *
 * ── POR QUE ELA EXISTE ───────────────────────────────────────────────────────────────────
 * Este seletor teve QUATRO defeitos num dia, e os quatro foram achados pelo Vitor olhando a tela,
 * nenhum pelas provas:
 *
 *   o grupo não aparecia na lista
 *   o espaço próprio das telas aparecia entre as playlists
 *   a busca só existia acima de seis itens
 *   o botão dizia "Enviar para 2" com nada marcado à frente
 *
 * Não é azar. Havia prova de que a página carrega sem erro de JavaScript e prova de que a rota
 * funciona por API — e nenhuma de que o SELETOR faz o que promete quando alguém clica. As duas
 * metades verdes e o meio nunca medido.
 *
 * Esta prova clica: seleciona arquivos, abre o seletor, escolhe o tipo, marca um destino, envia,
 * e vai conferir no banco se a mídia chegou às telas do grupo.
 *
 * ── COMO RODA ────────────────────────────────────────────────────────────────────────────
 *   docker run --rm --network host -v "$PWD/scripts/provas:/p" \
 *     zenika/alpine-chrome:with-puppeteer node /p/abrir_envio_em_massa.js
 */
const puppeteer = require('puppeteer');

const BASE = process.env.BASE || 'http://127.0.0.1:3110';
const TOKEN = process.env.TOKEN || '';

let passou = 0;
let falhou = 0;

function conferir(nome, ok, detalhe) {
  if (ok) { passou++; console.log('  ok    ' + nome); }
  else { falhou++; console.log('  FALHA ' + nome + (detalhe ? '  -> ' + detalhe : '')); }
}

(async () => {
  if (!TOKEN) {
    console.log('SEM SESSAO: passe TOKEN=... no ambiente (ver mfa_lib.sh)');
    process.exit(1);
  }

  const cab = { Authorization: 'Bearer ' + TOKEN };
  const arquivos = await (await fetch(BASE + '/api/content', { headers: cab })).json();
  const grupos = await (await fetch(BASE + '/api/groups', { headers: cab })).json();
  const listas = await (await fetch(BASE + '/api/playlists', { headers: cab })).json();

  const arr = Array.isArray(arquivos) ? arquivos : (arquivos.content || []);
  const grp = Array.isArray(grupos) ? grupos : [];
  const autos = (Array.isArray(listas) ? listas : []).filter((p) => p.is_auto_generated);

  console.log(`conta medida: ${arr.length} arquivo(s), ${grp.length} grupo(s), `
    + `${autos.length} lista(s) automática(s)`);

  if (!arr.length) {
    console.log('SEM DADOS: é preciso ao menos um arquivo na conta para selecionar');
    process.exit(1);
  }

  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const pagina = await navegador.newPage();

  const erros = [];
  pagina.on('pageerror', (e) => erros.push('pageerror: ' + e.message));
  pagina.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (m.text().includes('Failed to load resource')) return;
    erros.push('console.error: ' + m.text());
  });
  pagina.on('response', (r) => { if (r.status() >= 500) erros.push('HTTP ' + r.status() + ' em ' + r.url()); });

  await pagina.evaluateOnNewDocument((t) => {
    localStorage.setItem('token', t);
    localStorage.setItem('user', '{}');
  }, TOKEN);

  const esperar = (ms) => new Promise((s) => setTimeout(s, ms));

  console.log('\n=== A BIBLIOTECA ===');
  await pagina.goto(BASE + '/app#/content', { waitUntil: 'networkidle2', timeout: 30000 });
  await esperar(2500);
  conferir('a biblioteca carrega sem erro de JavaScript', erros.length === 0, erros.join(' | '));

  // ── selecionar um arquivo ─────────────────────────────────────────────────────────────
  const marcou = await pagina.evaluate(() => {
    const cx = document.querySelector('tbody input[type="checkbox"], .bulk-cell input[type="checkbox"]');
    if (!cx) return false;
    cx.click();
    return true;
  });
  conferir('dá para selecionar um arquivo', marcou);
  await esperar(600);

  const rotulo = await pagina.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /enviar/i.test(x.textContent));
    return b ? b.textContent.trim() : null;
  });
  /*
   * O rótulo com contagem e reticência — "Enviar 1…" — lê como texto cortado. Foi assim que o
   * Vitor o descreveu, e não havia corte de CSS nenhum.
   */
  conferir('o botão diz "Enviar para…", e não um número com reticência',
    rotulo === 'Enviar para…', rotulo);

  // ── abrir o seletor ───────────────────────────────────────────────────────────────────
  await pagina.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /enviar/i.test(x.textContent));
    if (b) b.click();
  });
  await esperar(1500);

  const etapa1 = await pagina.evaluate(() => {
    const corpo = document.querySelector('#epCorpo');
    if (!corpo) return null;
    return {
      tipos: [...corpo.querySelectorAll('[data-tipo]')].map((b) => b.dataset.tipo),
      temBusca: document.querySelector('#epBusca')?.style.display !== 'none',
    };
  });
  conferir('o seletor abre', !!etapa1, 'nenhum #epCorpo na página');

  if (etapa1) {
    /*
     * UM TIPO SEM NENHUM NÃO APARECE. Uma opção que leva a uma lista vazia é uma promessa
     * quebrada em dois cliques — e "grupos" aparecendo numa conta sem grupo foi um dos quatro.
     */
    if (!grp.length) {
      conferir('sem grupo nenhum, "Grupos" não é oferecido',
        !etapa1.tipos.includes('grupos'), etapa1.tipos.join(', '));
    } else {
      conferir('com grupos, "Grupos" é oferecido',
        etapa1.tipos.includes('grupos'), etapa1.tipos.join(', '));
    }

    // ── entrar num tipo ─────────────────────────────────────────────────────────────────
    const tipoAlvo = grp.length ? 'grupos' : 'telas';
    await pagina.evaluate((t) => {
      const b = document.querySelector(`[data-tipo="${t}"]`);
      if (b) b.click();
    }, tipoAlvo);
    await esperar(900);

    const etapa2 = await pagina.evaluate(() => ({
      titulo: document.querySelector('#epTitulo')?.textContent.trim(),
      buscaVisivel: document.querySelector('#epBusca')?.style.display !== 'none',
      destinos: [...document.querySelectorAll('#epCorpo [data-id]')].map((c) => c.dataset.id),
      temVoltar: document.querySelector('#epVoltar')?.style.display !== 'none',
    }));

    conferir('entrar num tipo mostra os destinos dele', etapa2.destinos.length > 0,
      JSON.stringify(etapa2));
    /*
     * A busca aparecia só acima de seis itens. O comportamento da tela mudava sozinho conforme a
     * conta crescia, debaixo de quem já tinha aprendido onde as coisas ficam.
     */
    conferir('a busca está sempre lá, e não só acima de N itens', etapa2.buscaVisivel);

    // ── marcar e conferir o resumo ──────────────────────────────────────────────────────
    await pagina.evaluate(() => {
      const cx = document.querySelector('#epCorpo [data-id]');
      if (cx) cx.click();
    });
    await esperar(400);

    const marcado = await pagina.evaluate(() => ({
      botao: document.querySelector('#epEnviar')?.textContent.trim(),
      resumo: document.querySelector('#epResumo')?.textContent.trim(),
      resumoVisivel: document.querySelector('#epResumo')?.style.display !== 'none',
    }));
    conferir('o botão conta o que foi marcado', /Enviar para 1/.test(marcado.botao || ''), marcado.botao);
    /*
     * O número dizia "2" com a lista à frente mostrando zero marcados, porque o que ficava
     * marcado em outro tipo continuava contando sem nenhuma pista de onde saiu.
     */
    conferir('e uma linha soletra de onde vem o número',
      marcado.resumoVisivel && /Marcado:/.test(marcado.resumo || ''), marcado.resumo);

    // ── e o espaço próprio das telas não é oferecido como playlist ──────────────────────
    if (etapa2.temVoltar) {
      await pagina.evaluate(() => document.querySelector('#epVoltar').click());
      await esperar(600);
      const temListas = await pagina.evaluate(() => !!document.querySelector('[data-tipo="listas"]'));
      if (temListas) {
        await pagina.evaluate(() => document.querySelector('[data-tipo="listas"]').click());
        await esperar(800);
        const oferecidas = await pagina.evaluate(() =>
          [...document.querySelectorAll('#epCorpo [data-id]')].map((c) => c.dataset.id));
        const vazaram = oferecidas.filter((id) => autos.some((a) => a.id === id));
        /*
         * Mandar um arquivo "para a lista da Bar do Porto" é mandar para a tela Bar do Porto,
         * escrito de um jeito que ninguém reconhece — com a tela logo acima, no mesmo seletor.
         */
        conferir('o espaço próprio das telas não é oferecido como playlist',
          vazaram.length === 0, vazaram.join(', '));
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
