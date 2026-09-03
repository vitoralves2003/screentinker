/*
 * O CONTRASTE NAS TELAS DE VERDADE — cada texto visível, contra o fundo que ele realmente tem.
 *
 * ── POR QUE ELA NÃO É A TRAVA QUE JÁ EXISTE ─────────────────────────────────────────────────
 * `contraste-da-identidade.spec.ts` mede os TOKENS: a identidade declara vinte e tantas cores e
 * ela afirma que cada uma passa sobre o fundo em que a identidade a coloca. Isso é necessário e
 * não é suficiente, porque uma tela pode combinar dois tokens que a identidade nunca pretendeu
 * juntos — texto secundário sobre a faixa alternada, selo de aviso dentro do cartão, rótulo
 * cinza-claro sobre cinza-claro. Nenhum deles é um token errado; o PAR é que é.
 *
 * E porque 2.290 classes das telas usam a escala de cinzas que acabou de ser redefinida. Medir a
 * escala prova que cada degrau é legível sobre o papel; não prova onde as telas os põem.
 *
 * ── O QUE ELA FAZ ────────────────────────────────────────────────────────────────────────────
 * Percorre CADA elemento com texto próprio, compõe o fundo efetivo dele (subindo pelos
 * ancestrais e compondo cada véu translúcido, que é o que o olho faz) e mede. O limite segue a
 * WCAG 2.1 AA e respeita o tamanho: 3:1 para texto grande — 24px, ou 18,66px em negrito —, 4,5:1
 * para o resto.
 *
 * Ela não julga o desabilitado: `--lp-texto-desligado` mede 1,72:1 de propósito, porque "não dá
 * para usar isto" é a informação. Um campo ou botão desabilitado é reconhecido pelo atributo, e
 * não por parecer apagado.
 *
 * ── A ORDEM DAS TELAS ────────────────────────────────────────────────────────────────────────
 * As da Operação primeiro, porque são as que o Vitor usa todo dia e as que a identidade mexeu
 * por último — o cartão da tabela e a altura do botão chegaram nelas depois de tudo.
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'http://127.0.0.1:3100';
const TOKEN = process.env.TOKEN || '';

const TELAS = [
  { casa: 'OPERAÇÃO', nome: 'Telas', caminho: '/gestao/telas' },
  { casa: 'OPERAÇÃO', nome: 'Arquivos', caminho: '/gestao/arquivos' },
  { casa: 'OPERAÇÃO', nome: 'Playlists', caminho: '/gestao/playlists' },
  { casa: 'GESTÃO', nome: 'Painel', caminho: '/gestao' },
  { casa: 'GESTÃO', nome: 'Clientes', caminho: '/gestao/clientes' },
  { casa: 'GESTÃO', nome: 'Contratos', caminho: '/gestao/contratos' },
  { casa: 'GESTÃO', nome: 'Configurações', caminho: '/gestao/configuracoes' },
];

const VARRER = `() => {
  const canal = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const lum = ([r, g, b]) =>
    0.2126 * canal(r / 255) + 0.7152 * canal(g / 255) + 0.0722 * canal(b / 255);
  const contraste = (a, b) => {
    const x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const componentes = (cor) => {
    const m = String(cor).match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/);
    if (!m) return null;
    return { rgb: [+m[1], +m[2], +m[3]], alfa: m[4] === undefined ? 1 : Number(m[4]) };
  };

  /*
   * O fundo EFETIVO: sobe pelos ancestrais até um opaco, guardando cada véu, e compõe de baixo
   * para cima. Ler só o backgroundColor do elemento devolve 'rgba(0,0,0,0)' na maioria dos
   * casos, e comparar texto contra transparente não mede nada.
   */
  const fundoEfetivo = (el) => {
    const veus = [];
    let e = el;
    while (e) {
      const c = componentes(getComputedStyle(e).backgroundColor);
      if (c && c.alfa > 0) {
        veus.push(c);
        if (c.alfa === 1) break;
      }
      e = e.parentElement;
    }
    let atual = [255, 255, 255];
    for (const veu of veus.reverse()) {
      atual = atual.map((v, i) => Math.round(veu.rgb[i] * veu.alfa + v * (1 - veu.alfa)));
    }
    return atual;
  };

  /* Só quem tem texto PRÓPRIO: um container herda a cor e seria contado pelos filhos de novo. */
  const temTextoProprio = (el) =>
    [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);

  const achados = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!temTextoProprio(el)) continue;

    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;

    const c = getComputedStyle(el);
    if (c.visibility === 'hidden' || c.display === 'none') continue;
    if (Number(c.opacity) < 0.15) continue;      /* véu deliberado, não texto */

    /* Desabilitado é ilegível de propósito — reconhecido pelo atributo, não pela cor. */
    if (el.closest('[disabled], [aria-disabled="true"], .disabled')) continue;

    const cor = componentes(c.color);
    if (!cor || cor.alfa < 0.5) continue;

    const fundo = fundoEfetivo(el);
    const razao = contraste(cor.rgb, fundo);

    const px = parseFloat(c.fontSize);
    const peso = Number(c.fontWeight) || 400;
    const grande = px >= 24 || (px >= 18.66 && peso >= 700);
    const minimo = grande ? 3 : 4.5;

    if (razao >= minimo) continue;

    achados.push({
      texto: el.textContent.trim().replace(/\\s+/g, ' ').slice(0, 42),
      classe: String(el.className || '').slice(0, 40),
      cor: 'rgb(' + cor.rgb.join(',') + ')',
      fundo: 'rgb(' + fundo.join(',') + ')',
      razao: Number(razao.toFixed(2)),
      px: Math.round(px),
      peso,
      minimo,
    });
  }

  /* Uma linha por combinação, não por elemento: 40 células da mesma coluna são um só defeito. */
  const porCombinacao = new Map();
  for (const a of achados) {
    const chave = a.cor + '|' + a.fundo + '|' + a.minimo;
    const antes = porCombinacao.get(chave);
    if (antes) antes.vezes++;
    else porCombinacao.set(chave, { ...a, vezes: 1 });
  }
  return { total: achados.length, combinacoes: [...porCombinacao.values()] };
}`;

(async () => {
  if (!TOKEN) { console.log('SEM SESSAO'); process.exit(1); }
  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  let falhas = 0, telasLidas = 0;

  for (const tela of TELAS) {
    const pagina = await navegador.newPage();
    await pagina.setViewport({ width: 1440, height: 900 });
    await pagina.evaluateOnNewDocument((tk) => {
      localStorage.setItem('token', tk);
      localStorage.setItem('loop_os_token', tk);
    }, TOKEN);

    let r;
    try {
      await pagina.goto(UNI + tela.caminho, { waitUntil: 'networkidle0', timeout: 45000 });

      /*
       * Esperar a TELA, e nao o relogio. Tres segundos fixos deixaram a pagina de Telas com 187
       * caracteres -- ela busca telas, grupos e paredes antes de desenhar, e a prova mediu o
       * esqueleto. Um sleep e uma aposta sobre a rede de quem roda a prova.
       */
      try {
        await pagina.waitForFunction(() => document.body.innerText.trim().length > 400,
          { timeout: 20000, polling: 400 });
      } catch { /* segue e o proprio caso de "pouco texto" reprova, com o numero */ }
      await new Promise((x) => setTimeout(x, 900));
      r = await pagina.evaluate((fonte) => eval(fonte)(), VARRER);
    } catch (erro) {
      console.log('\n!! ' + tela.casa + ' / ' + tela.nome + ' não abriu: ' + erro.message.slice(0, 70));
      falhas++;
      await pagina.close();
      continue;
    }

    /*
     * Confere que havia texto para medir. Uma tela em branco não tem texto ilegível, e "zero
     * achados" seria verde nos dois casos — o padrão exato das provas deste projeto que passavam
     * medindo a coisa certa no estado errado.
     */
    const quantoTexto = await pagina.evaluate(() => document.body.innerText.trim().length);
    await pagina.close();

    if (quantoTexto < 200) {
      console.log('\n!! ' + tela.casa + ' / ' + tela.nome + ': só ' + quantoTexto +
        ' caracteres na tela — ela não carregou, e medir contraste aqui não afirma nada');
      falhas++;
      continue;
    }

    telasLidas++;
    console.log('\n== ' + tela.casa + ' / ' + tela.nome + '  (' + quantoTexto + ' caracteres) ==');

    if (!r.combinacoes.length) {
      console.log('  ok    todo texto legível');
      continue;
    }

    falhas += r.combinacoes.length;
    for (const c of r.combinacoes) {
      console.log('  FALHA ' + c.cor + ' sobre ' + c.fundo + ' = ' + String(c.razao).padStart(5) +
        ':1 (precisa ' + c.minimo + ') · ' + c.px + 'px/' + c.peso + ' · ' + c.vezes + 'x');
      console.log('        "' + c.texto + '"   .' + c.classe);
    }
  }

  await navegador.close();

  console.log('\n' + telasLidas + ' de ' + TELAS.length + ' telas lidas');
  if (falhas) {
    console.log(falhas + ' PROBLEMA(S) de contraste');
    process.exit(1);
  }
  console.log('TODO TEXTO LEGÍVEL NAS TELAS');
})();
