/*
 * NO CELULAR, NADA DA LISTA FICA FORA DA TELA.
 *
 * ── o que ela mede, e por que assim ─────────────────────────────────────────────────────────
 * Antes: Contratos tinha 733px de tabela em 356px de espaço, com 4 das 6 colunas fora; Arquivos,
 * 5 de 5; Clientes, 3 de 5. Quem abria no celular via as duas primeiras colunas e precisava
 * arrastar a tabela de lado — um gesto que quase ninguém tenta e que nada na tela sugere.
 *
 * Esta prova NÃO afirma que a tabela empilhou. Afirma que **todo dado da lista está dentro da
 * tela** — que é o que a pessoa sente. Se um dia alguém resolver isso de outro jeito (colunas
 * que somem, fonte menor, o que for), a prova continua valendo; se resolver empilhando e
 * esquecer uma tabela, ela acusa.
 *
 * ── e ela mede o VALOR, não a célula ────────────────────────────────────────────────────────
 * Uma `<td>` pode caber na tela com o texto dela transbordando por dentro. Por isso a medição é
 * do retângulo do TEXTO (Range sobre o nó de texto), e não da caixa que o contém — foi medindo
 * o continente e concluindo sobre o conteúdo que este projeto já errou duas vezes.
 *
 * ── as duas casas ───────────────────────────────────────────────────────────────────────────
 * Este é o único defeito do levantamento em que as duas erram igual, então a prova cobre as
 * duas com a mesma régua. Uma passar e a outra não seria o mesmo problema de novo.
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'http://127.0.0.1:3100';
const TOKEN = process.env.TOKEN || '';

const TELAS = [
  { casa: 'GESTÃO', nome: 'Contratos', caminho: '/gestao/contratos' },
  { casa: 'GESTÃO', nome: 'Clientes', caminho: '/gestao/clientes' },
  { casa: 'GESTÃO', nome: 'Financeiro', caminho: '/gestao/financeiro' },
  { casa: 'OPERAÇÃO', nome: 'Playlists', caminho: '/gestao/playlists' },
  { casa: 'OPERAÇÃO', nome: 'Telas', caminho: '/gestao/telas' },
];

const MEDIR = `() => {
  const larguraDaTela = document.documentElement.clientWidth;

  const tabela = [...document.querySelectorAll('table')]
    .filter((t) => t.offsetParent !== null && t.querySelector('tbody tr td'))[0];

  if (!tabela) return { semTabela: true };

  /*
   * O retângulo do TEXTO de cada célula. Uma td pode caber e o texto dela vazar por dentro —
   * medir a caixa diria que está tudo bem enquanto a palavra está cortada na borda.
   */
  const foraDaTela = [];
  let medidos = 0;

  /*
   * TODO nó de texto da célula, em qualquer profundidade — e não só os filhos diretos.
   *
   * A primeira versão só olhava childNodes, e as tabelas envolvem o valor em <a>, <button> ou
   * <span>: em Telas isso deu "0 valores medidos" e a prova imprimiu "ok, todos os 0 valores
   * estão dentro da tela". Verde por vazio, exatamente o que ela existe para não deixar
   * acontecer com as telas — e desta vez o defeito era dela mesma.
   */
  const nosDeTexto = (raiz) => {
    const achados = [];
    const caminhante = document.createTreeWalker(raiz, NodeFilter.SHOW_TEXT);
    let no;
    while ((no = caminhante.nextNode())) achados.push(no);
    return achados;
  };

  for (const td of tabela.querySelectorAll('tbody td')) {
    for (const no of nosDeTexto(td)) {
      const texto = no.textContent.trim();
      if (texto.length < 1) continue;

      const faixa = document.createRange();
      faixa.selectNodeContents(no);
      const r = faixa.getBoundingClientRect();
      faixa.detach();

      if (r.width === 0 && r.height === 0) continue;
      medidos++;

      /* 1px de folga para arredondamento de subpixel. */
      if (r.right > larguraDaTela + 1 || r.left < -1) {
        foraDaTela.push({
          texto: texto.slice(0, 30),
          rotulo: td.getAttribute('data-rotulo') || '(sem rótulo)',
          direita: Math.round(r.right),
          esquerda: Math.round(r.left),
        });
      }
    }
  }

  /* A largura da tabela contra a área que a contém — a medida do relatório. */
  const area = tabela.parentElement ? tabela.parentElement.getBoundingClientRect().width : 0;

  return {
    larguraDaTela,
    larguraDaTabela: Math.round(tabela.getBoundingClientRect().width),
    area: Math.round(area),
    linhas: tabela.querySelectorAll('tbody tr').length,
    medidos,
    foraDaTela: foraDaTela.slice(0, 6),
    quantosFora: foraDaTela.length,
    /* Rolagem lateral da PÁGINA, que é o sintoma que a pessoa sente primeiro. */
    paginaRolaDeLado: document.documentElement.scrollWidth > larguraDaTela + 1,
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
      await new Promise((x) => setTimeout(x, 1500));
      m = await pagina.evaluate((f) => eval(f)(), MEDIR);
    } catch (erro) {
      console.log('\n!! ' + tela.nome + ' não abriu: ' + erro.message.slice(0, 60));
      falhas++;
      await pagina.close();
      continue;
    }
    /*
     * O ÚLTIMO ITEM É ALCANÇÁVEL — a afirmação que faltava, e a que o Vitor sentiu com o dedo:
     * "quando há muitos itens não consigo rolar até embaixo".
     *
     * A página ROLAVA até o fim; o fim é que estava debaixo da barra de atalhos. O conteúdo
     * reservava 24px de respiro embaixo enquanto a barra ocupa 57 — 24px do último item ficavam
     * cobertos, e nada na tela sugeria que havia mais coisa ali.
     *
     * Nenhuma das provas via isso: elas mediam largura (nada fora da tela pelos lados) e ordem
     * (nada sobreposto dentro da linha). Ninguém perguntava se dava para CHEGAR no fim.
     */
    const fim = await pagina.evaluate(() => {
      window.scrollTo(0, 99999);
      const linhas = [...document.querySelectorAll('table tbody tr')]
        .filter((tr) => tr.getBoundingClientRect().height > 4);
      const ultima = linhas[linhas.length - 1];
      if (!ultima) return null;

      const r = ultima.getBoundingClientRect();
      const barra = document.querySelector('loop-sidebar');
      const inferior = barra && barra.shadowRoot ? barra.shadowRoot.querySelector('.inferior') : null;
      const ri = inferior ? inferior.getBoundingClientRect() : null;

      /* Coberto pela barra, ou ainda abaixo da dobra depois de rolar tudo. */
      const cobertoPelaBarra = ri ? Math.round(r.bottom - ri.top) : 0;
      const abaixoDaDobra = Math.round(r.bottom - window.innerHeight);
      return { cobertoPelaBarra, abaixoDaDobra, temBarra: !!ri };
    });

    await pagina.close();

    console.log('\n── ' + tela.casa + ' / ' + tela.nome + ' ──');

    /*
     * Sem tabela com linhas é FALHA, não sucesso: uma lista vazia também não tem dado fora da
     * tela. Já reprovei duas telas boas por réguas inventadas nesta semana — a régua aqui é
     * ter o que medir, e ela é dita, não suposta.
     */
    if (m.semTabela || !m.linhas) {
      console.log('  !! sem tabela com linhas — não há o que medir, e "nada fora da tela" seria' +
        ' verdade por vazio');
      falhas++;
      continue;
    }

    console.log('  tabela ' + m.larguraDaTabela + 'px em ' + m.area + 'px de área · ' +
      m.linhas + ' linha(s) · ' + m.medidos + ' valores medidos');

    /*
     * ZERO VALORES MEDIDOS É FALHA. Sem esta linha a prova imprimia "ok, todos os 0 valores
     * estão dentro da tela" — verde por vazio, o defeito que ela existe para achar nas telas, e
     * que ela mesma cometeu em Telas na primeira versão.
     */
    if (!m.medidos) {
      console.log('  FALHA nenhum valor de texto encontrado nas células — a prova não mediu nada');
      falhas++;
      continue;
    }

    if (m.paginaRolaDeLado) {
      console.log('  FALHA a página rola de lado');
      falhas++;
    } else {
      console.log('  ok    a página não rola de lado');
    }


    /*
     * O ÚLTIMO ITEM É ALCANÇÁVEL. Medido lá em cima, com a página ainda aberta — a primeira
     * versão media DEPOIS do `pagina.close()`, e um `.catch(() => null)` engolia o erro: a
     * afirmação simplesmente não era impressa, e a prova terminava verde sem tê-la feito.
     *
     * Um catch que devolve null transforma "quebrou" em "nada a dizer". Ele saiu.
     */
    if (fim === null) {
      console.log('  !! não havia última linha para medir');
      falhas++;
    } else if (fim.cobertoPelaBarra > 1 || fim.abaixoDaDobra > 1) {
      const quanto = Math.max(fim.cobertoPelaBarra, fim.abaixoDaDobra);
      console.log('  FALHA depois de rolar tudo, o último item ainda tem ' + quanto + 'px ' +
        (fim.cobertoPelaBarra > fim.abaixoDaDobra ? 'atrás da barra de atalhos' : 'abaixo da dobra'));
      falhas++;
    } else {
      console.log('  ok    o último item é alcançável rolando');
    }

    if (m.quantosFora) {
      console.log('  FALHA ' + m.quantosFora + ' valor(es) fora da tela de ' + m.larguraDaTela + 'px:');
      for (const v of m.foraDaTela) {
        console.log('        "' + v.texto + '" (' + v.rotulo + ') vai de ' +
          v.esquerda + ' a ' + v.direita);
      }
      falhas++;
    } else {
      console.log('  ok    todos os ' + m.medidos + ' valores estão dentro da tela');
    }
  }

  await navegador.close();

  console.log('');
  if (falhas) {
    console.log(falhas + ' FALHA(S) — há dado de lista fora da tela no celular');
    process.exit(1);
  }
  console.log('A LISTA CABE NO CELULAR');
})();
