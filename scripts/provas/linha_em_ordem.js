/*
 * A LINHA DA LISTA ESTÁ EM ORDEM, E NADA SE SOBREPÕE.
 *
 * ── por que ela existe ──────────────────────────────────────────────────────────────────────
 * Eu quebrei Playlists, Arquivos e Telas no celular, e `lista_no_celular.js` passou. Ela afirma
 * "nenhum valor fora da tela", e isso era VERDADE: tudo estava dentro da tela — o nome solto
 * embaixo do cartão, as miniaturas por cima das palavras, os valores sem rótulo e fora de ordem.
 *
 * Uma prova que só mede posição não distingue "organizado" de "amontoado". Esta mede as duas
 * coisas que faltavam:
 *
 *   1. NADA SE SOBREPÕE — dois textos não podem ocupar o mesmo pedaço de tela
 *   2. A ORDEM VISUAL É A ORDEM DO DOM — o que a tela promete na primeira coluna aparece
 *      primeiro; o que vem depois, depois. Ler de cima para baixo e da esquerda para a direita
 *      tem de dar a mesma sequência que o código escreveu
 *
 * A segunda é a que teria pego o meu defeito: o nome estava DEPOIS da caixa de seleção no DOM e
 * apareceu depois dela na tela, sim — mas os dados de apoio apareceram ANTES do nome, porque a
 * caixa virou o título do cartão e empurrou tudo.
 *
 * ── e a terceira, que a captura do Vitor mostrou ────────────────────────────────────────────
 * 3. A MINIATURA FICA COLADA NO NOME. Em Arquivos ela vive dentro da célula do nome, e o
 *    `space-between` a jogou para o outro lado da linha. Uma imagem a 200px do texto que ela
 *    ilustra não é layout, é ruído.
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'http://127.0.0.1:3100';
const TOKEN = process.env.TOKEN || '';

const TELAS = [
  { casa: 'OPERAÇÃO', nome: 'Arquivos', caminho: '/gestao/arquivos', temMiniatura: true },
  { casa: 'OPERAÇÃO', nome: 'Playlists', caminho: '/gestao/playlists' },
  { casa: 'OPERAÇÃO', nome: 'Telas', caminho: '/gestao/telas' },
  { casa: 'GESTÃO', nome: 'Contratos', caminho: '/gestao/contratos' },
  { casa: 'GESTÃO', nome: 'Clientes', caminho: '/gestao/clientes' },
];

const MEDIR = `(temMiniatura) => {
  const tabela = [...document.querySelectorAll('table')]
    .filter((t) => t.offsetParent !== null && t.querySelector('tbody tr td'))[0];
  if (!tabela) return { semTabela: true };

  const linhas = [...tabela.querySelectorAll('tbody tr')]
    .filter((tr) => tr.getBoundingClientRect().height > 4);
  if (!linhas.length) return { semLinhas: true };

  /* Os pedaços de TEXTO de uma linha, na ordem em que o DOM os escreve. */
  const pedacosDe = (linha) => {
    const achados = [];
    const caminhante = document.createTreeWalker(linha, NodeFilter.SHOW_TEXT);
    let no;
    while ((no = caminhante.nextNode())) {
      const texto = no.textContent.trim();
      if (texto.length < 1) continue;

      const faixa = document.createRange();
      faixa.selectNodeContents(no);
      const r = faixa.getBoundingClientRect();
      faixa.detach();
      if (r.width < 1 || r.height < 1) continue;

      achados.push({
        texto: texto.slice(0, 26),
        topo: Math.round(r.top), base: Math.round(r.bottom),
        esq: Math.round(r.left), dir: Math.round(r.right),
      });
    }
    return achados;
  };

  const sobrepoe = (a, b) => {
    /*
     * Sobreposição de VERDADE, com folga: linhas de texto vizinhas quase se encostam por causa
     * da entrelinha, e 3px de tolerância separam "colado" de "por cima".
     */
    const cruzaX = a.esq < b.dir - 3 && b.esq < a.dir - 3;
    const cruzaY = a.topo < b.base - 3 && b.topo < a.base - 3;
    return cruzaX && cruzaY;
  };

  const problemas = [];
  let pedacosMedidos = 0;

  for (const linha of linhas.slice(0, 5)) {
    const pedacos = pedacosDe(linha);
    pedacosMedidos += pedacos.length;

    /*
     * 0. NADA VAZA PARA FORA DA LINHA — a afirmação que faltava, e a que o Vitor viu com o olho
     * enquanto esta prova dizia "ok".
     *
     * A linha tinha altura fixa de 58px, e o texto de apoio ficava desenhado 17px ABAIXO da
     * borda do cartão, em cima da divisa com o cartão seguinte. Nenhum texto se sobrepunha a
     * outro, e a ordem estava certa — as duas afirmações que eu tinha passavam com folga.
     *
     * O que faltava era a mais simples: o conteúdo está DENTRO da caixa que o desenha.
     *
     * (Sem crases neste comentário: ele vive dentro do template literal da medição, e uma crase
     *  aqui fecha a string no meio. Terceira vez hoje.)
     */
    const caixa = linha.getBoundingClientRect();
    for (const td of linha.querySelectorAll('td')) {
      const r = td.getBoundingClientRect();
      if (r.height < 1) continue;
      const vaza = Math.round(Math.max(r.bottom - caixa.bottom, caixa.top - r.top));
      if (vaza > 1) {
        problemas.push({ tipo: 'vaza', vaza, a: td.textContent.trim().slice(0, 26) });
      }
    }

    if (pedacos.length < 2) continue;

    /* 1. nada se sobrepõe */
    for (let i = 0; i < pedacos.length; i++) {
      for (let j = i + 1; j < pedacos.length; j++) {
        if (sobrepoe(pedacos[i], pedacos[j])) {
          problemas.push({
            tipo: 'sobreposicao',
            a: pedacos[i].texto, b: pedacos[j].texto,
          });
        }
      }
    }

    /*
     * 2. a ordem visual é a ordem do DOM.
     *
     * Ordena por linha visual (topo, com tolerância de 6px para a mesma linha) e depois pela
     * esquerda. A sequência resultante tem de ser a mesma do DOM.
     */
    const visual = pedacos.map((p, i) => ({ ...p, ordemNoDom: i }))
      .sort((a, b) => (Math.abs(a.topo - b.topo) > 6 ? a.topo - b.topo : a.esq - b.esq));

    for (let i = 1; i < visual.length; i++) {
      if (visual[i].ordemNoDom < visual[i - 1].ordemNoDom) {
        problemas.push({
          tipo: 'ordem',
          a: visual[i - 1].texto, b: visual[i].texto,
        });
        break;   /* uma por linha basta para reprovar; a lista fica legível */
      }
    }

    /* 3. a miniatura fica colada no nome */
    if (temMiniatura) {
      const img = linha.querySelector('img, .list-thumb');
      const primeiroTexto = pedacos[0];
      if (img && primeiroTexto) {
        const ri = img.getBoundingClientRect();
        if (ri.width > 2) {
          const distancia = Math.round(primeiroTexto.esq - ri.right);
          if (distancia > 60 || distancia < -4) {
            problemas.push({ tipo: 'miniatura', distancia, a: primeiroTexto.texto });
          }
        }
      }
    }
  }

  return {
    linhas: linhas.length,
    pedacosMedidos,
    problemas: problemas.slice(0, 8),
    quantosProblemas: problemas.length,
  };
}`;

(async () => {
  if (!TOKEN) { console.log('SEM SESSAO'); process.exit(1); }
  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  let falhas = 0;

  for (const tela of TELAS) {
    const pagina = await navegador.newPage();
    await pagina.setViewport({ width: 390, height: 700 });
    await pagina.evaluateOnNewDocument((tk) => {
      localStorage.setItem('token', tk);
      localStorage.setItem('loop_os_token', tk);
    }, TOKEN);

    let m;
    try {
      await pagina.goto(UNI + tela.caminho, { waitUntil: 'networkidle0', timeout: 45000 });
      await pagina.waitForFunction(() => !!document.querySelector('table tbody tr td'),
        { timeout: 20000, polling: 400 }).catch(() => {});
      await new Promise((x) => setTimeout(x, 1600));
      m = await pagina.evaluate((f, mini) => eval(f)(mini), MEDIR, !!tela.temMiniatura);
    } catch (erro) {
      console.log('\n!! ' + tela.nome + ' não abriu: ' + erro.message.slice(0, 60));
      falhas++;
      await pagina.close();
      continue;
    }
    await pagina.close();

    console.log('\n── ' + tela.casa + ' / ' + tela.nome + ' ──');

    if (m.semTabela || m.semLinhas) {
      console.log('  !! sem linhas para medir — "nada se sobrepõe" seria verdade por vazio');
      falhas++;
      continue;
    }

    /*
     * Menos de dois pedaços de texto por linha é a prova não tendo o que comparar: sobreposição
     * e ordem só existem entre PARES. Zero pares é verde por vazio, e já caí nessa hoje.
     */
    if (m.pedacosMedidos < m.linhas * 2) {
      console.log('  !! só ' + m.pedacosMedidos + ' textos em ' + m.linhas +
        ' linha(s) — poucos pares para afirmar ordem ou sobreposição');
      falhas++;
      continue;
    }

    console.log('  ' + m.linhas + ' linha(s), ' + m.pedacosMedidos + ' textos medidos');

    if (!m.quantosProblemas) {
      console.log('  ok    nada vaza para fora da linha');
      console.log('  ok    nada se sobrepõe');
      console.log('  ok    a ordem na tela é a ordem que a tela promete');
      if (tela.temMiniatura) console.log('  ok    a miniatura está colada no nome');
      continue;
    }

    falhas += m.quantosProblemas;
    for (const p of m.problemas) {
      if (p.tipo === 'sobreposicao') {
        console.log('  FALHA "' + p.a + '" e "' + p.b + '" ocupam o mesmo pedaço de tela');
      } else if (p.tipo === 'ordem') {
        console.log('  FALHA "' + p.b + '" aparece antes de "' + p.a + '", mas vem depois no código');
      } else if (p.tipo === 'vaza') {
        console.log('  FALHA "' + p.a + '" está desenhado ' + p.vaza + 'px FORA da linha');
      } else {
        console.log('  FALHA a miniatura está a ' + p.distancia + 'px de "' + p.a + '"');
      }
    }
  }

  await navegador.close();

  console.log('');
  if (falhas) {
    console.log(falhas + ' PROBLEMA(S) — a linha está amontoada ou fora de ordem');
    process.exit(1);
  }
  console.log('A LINHA ESTA EM ORDEM');
})();
