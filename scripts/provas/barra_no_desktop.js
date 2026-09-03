/*
 * A BARRA LATERAL NO COMPUTADOR — inteira, e sem nada do celular vazando para dentro dela.
 *
 * ── o que ela existe para impedir ───────────────────────────────────────────────────────────
 * A barra inferior de atalhos nasceu para o celular e não tinha regra que a escondesse fora dele:
 * ganhava `display` dentro do @media e nada a desligava no desktop. O resultado, medido em
 * 1440x900:
 *
 *   a barra do celular    desenhada no TOPO da lateral, 191px de altura com a barra recolhida
 *   o menu                empurrado 191px para baixo
 *   o botão de expandir   em y=1001, numa tela de 900 — fora da tela
 *
 * O Vitor viu como "o botão de voltar ao normal some" e "outros botões apareceram na parte
 * superior". O botão não sumia: estava desenhado onde ninguém alcança.
 *
 * ── por que nenhuma prova pegou ────────────────────────────────────────────────────────────
 * `celular.js` mede em 390px, onde a barra inferior DEVE aparecer — ali estava tudo certo.
 * `medir_layout.js` mede em 1440, mas olha título, ação e tabela: nunca entrou na barra.
 * Ninguém perguntava o que a barra do celular fazia num computador.
 *
 * ── e ela confere os dois estados ──────────────────────────────────────────────────────────
 * Recolhida e expandida. O defeito era MAIOR na recolhida (191px contra 57), porque os rótulos
 * dos atalhos empilham quando a lateral estreita — e recolher é o estado que fica guardado entre
 * sessões, então é o que a pessoa encontra ao voltar.
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'http://127.0.0.1:3100';
const TOKEN = process.env.TOKEN || '';

const MEDIR = `() => {
  const sb = document.querySelector('loop-sidebar');
  if (!sb || !sb.shadowRoot) return { semBarra: true };
  const sr = sb.shadowRoot;

  const caixa = (sel) => {
    const e = sr.querySelector(sel);
    if (!e) return null;
    const c = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    return {
      existe: true,
      pintado: c.display !== 'none' && c.visibility !== 'hidden' && r.width > 0 && r.height > 0,
      topo: Math.round(r.top), esq: Math.round(r.left),
      larg: Math.round(r.width), alt: Math.round(r.height),
    };
  };

  return {
    recolhida: sb.hasAttribute('recolhida'),
    inferior: caixa('.inferior'),
    abrir: caixa('.abrir'),
    veu: caixa('.veu'),
    recolher: caixa('.recolher'),
    nav: caixa('nav'),
    logo: caixa('.logo'),
    alturaDaTela: window.innerHeight,
  };
}`;

(async () => {
  if (!TOKEN) { console.log('SEM SESSAO'); process.exit(1); }
  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  const pagina = await navegador.newPage();
  await pagina.setViewport({ width: 1440, height: 900 });
  await pagina.evaluateOnNewDocument((tk) => {
    localStorage.setItem('token', tk);
    localStorage.setItem('loop_os_token', tk);
    /* Começa expandida, para o primeiro caso não depender do que ficou guardado. */
    localStorage.removeItem('loop_sidebar_recolhida');
  }, TOKEN);

  await pagina.goto(UNI + '/gestao/dashboard', { waitUntil: 'networkidle0', timeout: 45000 });
  await pagina.waitForFunction(() => {
    const sb = document.querySelector('loop-sidebar');
    return sb && sb.shadowRoot && sb.shadowRoot.querySelector('nav');
  }, { timeout: 20000, polling: 300 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));

  let falhas = 0;
  const conferir = (o_que, condicao, detalhe) => {
    console.log('    ' + (condicao ? 'ok    ' : 'FALHA ') + o_que + (detalhe ? '   ' + detalhe : ''));
    if (!condicao) falhas++;
  };

  const olhar = async (rotulo) => {
    const m = await pagina.evaluate((f) => eval(f)(), MEDIR);

    console.log('\n  ── ' + rotulo + ' ──');

    if (m.semBarra) {
      console.log('    !! a barra não existe na página — nada a medir');
      falhas++;
      return;
    }

    /*
     * A guarda: sem isto, uma barra que não desenhasse NADA passaria em todas as afirmações
     * abaixo, porque elas são todas sobre coisas que não devem aparecer.
     */
    conferir('a barra está desenhada', !!(m.nav && m.nav.pintado),
      m.nav ? m.nav.larg + 'x' + m.nav.alt : '(sem nav)');
    conferir('a logo aparece', !!(m.logo && m.logo.pintado));

    /* O que é do celular fica fora do computador. */
    conferir('a barra de atalhos do celular NÃO aparece',
      !(m.inferior && m.inferior.pintado),
      m.inferior && m.inferior.pintado ? 'está em (' + m.inferior.esq + ',' + m.inferior.topo
        + ') com ' + m.inferior.larg + 'x' + m.inferior.alt : '');
    conferir('o botão de menu do celular NÃO aparece', !(m.abrir && m.abrir.pintado));
    conferir('o véu do celular NÃO aparece', !(m.veu && m.veu.pintado));

    /*
     * O controle de recolher/expandir tem de estar ALCANÇÁVEL — dentro da tela, não só
     * desenhado. Era ele que ia parar em y=1001 numa tela de 900.
     */
    const r = m.recolher;
    conferir('o controle de recolher/expandir existe', !!(r && r.pintado));
    if (r && r.pintado) {
      conferir('e está dentro da tela',
        r.topo >= 0 && r.topo + r.alt <= m.alturaDaTela + 1,
        'de ' + r.topo + ' a ' + (r.topo + r.alt) + ', tela de ' + m.alturaDaTela);
    }

    /* A barra começa no topo da janela: nada empurrando ela para baixo. */
    conferir('a barra começa no topo', !!(m.nav && m.nav.topo <= 1),
      m.nav ? 'topo em ' + m.nav.topo : '');
  };

  await olhar('EXPANDIDA');

  await pagina.evaluate(() => {
    const sr = document.querySelector('loop-sidebar').shadowRoot;
    const b = sr.querySelector('.recolher');
    if (b) b.click();
  });
  await new Promise((r) => setTimeout(r, 900));

  await olhar('RECOLHIDA');

  /* E volta ao normal — o caminho de ida e volta, que é o que o Vitor não conseguia fazer. */
  const voltou = await pagina.evaluate(() => {
    const sb = document.querySelector('loop-sidebar');
    const b = sb.shadowRoot.querySelector('.recolher');
    if (!b) return 'sem controle';
    const r = b.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) return 'fora da tela';
    b.click();
    return 'clicou';
  });
  await new Promise((r) => setTimeout(r, 900));

  const estado = await pagina.evaluate(() =>
    document.querySelector('loop-sidebar').hasAttribute('recolhida'));

  console.log('\n  ── a volta ──');
  conferir('dá para expandir de novo', voltou === 'clicou' && estado === false,
    voltou === 'clicou' ? (estado ? 'clicou e continuou recolhida' : '') : voltou);

  await pagina.close();
  await navegador.close();

  console.log('');
  if (falhas) {
    console.log(falhas + ' FALHA(S) na barra do computador');
    process.exit(1);
  }
  console.log('A BARRA DO COMPUTADOR ESTA INTEIRA');
})();
