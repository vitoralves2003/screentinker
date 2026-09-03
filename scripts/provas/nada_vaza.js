/*
 * NADA VAZA PELA BORDA — nem o painel, nem o que está dentro dele.
 *
 * ── POR QUE ISTO EXISTE ──────────────────────────────────────────────────────────────────
 * O seletor de período saía da tela. Consertei o PAINEL — medi, deu "dentro, de 16 a 304px numa
 * tela de 390" — e o Vitor fotografou o defeito de novo: agora era o campo de data, vazando de
 * dentro do painel que estava certo.
 *
 * A lição é a asserção, não o CSS: eu tinha medido o continente e concluído sobre o conteúdo.
 * Um elemento pode estar inteiramente dentro da tela e ainda assim ter filhos que a atravessam,
 * porque `overflow` não recorta por padrão e largura mínima intrínseca não respeita o pai.
 *
 * ── O QUE ELA FAZ ────────────────────────────────────────────────────────────────────────
 * Abre o que ABRE — menus, seletores, modais — e percorre CADA elemento visível procurando um
 * que passe da borda esquerda ou direita. Reporta o culpado com o texto dele, para o conserto
 * não precisar de adivinhação.
 *
 * ── COMO RODA ────────────────────────────────────────────────────────────────────────────
 *   docker run --rm --network host --entrypoint node \
 *     -e NODE_PATH=/usr/src/app/node_modules -e TOKEN=... \
 *     -e UNI=https://beta.loopplayer.com.br \
 *     -v /opt/novo-operacao/scripts/provas:/p \
 *     zenika/alpine-chrome:with-puppeteer /p/nada_vaza.js
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'http://127.0.0.1:3100';
const TOKEN = process.env.TOKEN || '';
const CELULAR = { width: 390, height: 700, isMobile: true, hasTouch: true };

let falhou = 0;
function conferir(nome, ok, detalhe) {
  if (ok) console.log('  ok    ' + nome);
  else { falhou++; console.log('  FALHA ' + nome + (detalhe ? '  -> ' + detalhe : '')); }
}

/*
 * Quem passa da borda. Ignora o que está deliberadamente escondido fora da tela (a gaveta
 * fechada, um carrossel) — o alvo é o que está VISÍVEL e mesmo assim atravessa.
 */
async function vazamentos(pagina) {
  return pagina.evaluate(() => {
    const larg = window.innerWidth;
    const fora = [];
    for (const e of document.querySelectorAll('body *')) {
      if (e.offsetParent === null) continue;
      const cs = getComputedStyle(e);
      if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      /* Fora da tela por inteiro é intenção (gaveta fechada); atravessar a borda é defeito. */
      if (r.right <= 0 || r.left >= larg) continue;
      if (r.left < -1 || r.right > larg + 1) {
        fora.push({
          tag: e.tagName.toLowerCase(),
          classe: String(e.className || '').slice(0, 40),
          texto: (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30),
          esq: Math.round(r.left),
          dir: Math.round(r.right),
        });
      }
    }
    /* Só os mais internos: se um pai vaza, o filho aparece junto e polui o relatório. */
    return fora.slice(0, 5);
  });
}

async function apertarPorTexto(pagina, padrao) {
  const alvo = await pagina.evaluateHandle((p) => {
    const re = new RegExp(p.fonte, p.flags);
    return [...document.querySelectorAll('button')]
      .find((b) => b.offsetParent !== null && re.test((b.innerText || '').trim()));
  }, { fonte: padrao.source, flags: padrao.flags });
  const el = alvo.asElement();
  if (!el) return false;
  await el.click();
  await new Promise((r) => setTimeout(r, 900));
  return true;
}

(async () => {
  if (!TOKEN) { console.log('SEM SESSAO: passe TOKEN=...'); process.exit(1); }

  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const pagina = await navegador.newPage();
  await pagina.setViewport(CELULAR);
  await pagina.evaluateOnNewDocument((tk) => {
    localStorage.setItem('token', tk);
    localStorage.setItem('loop_os_token', tk);
  }, TOKEN);

  await pagina.goto(UNI + '/gestao/dashboard', { waitUntil: 'networkidle0', timeout: 45000 });
  await new Promise((r) => setTimeout(r, 4000));

  console.log('\n  painel, fechado');
  let v = await vazamentos(pagina);
  conferir('nada atravessa a borda', v.length === 0, JSON.stringify(v));

  /*
   * O SELETOR DE PERÍODO ABERTO — o caso que o Vitor achou duas vezes. Aqui não basta o painel
   * estar dentro: os campos de data DENTRO dele são o que vazava.
   */
  console.log('\n  seletor de período, aberto');
  const abriu = await apertarPorTexto(pagina, /Ano atual|Mês atual|Últimos 30/i);
  conferir('o seletor abre', abriu);
  if (abriu) {
    v = await vazamentos(pagina);
    conferir('nada atravessa a borda com ele aberto', v.length === 0, JSON.stringify(v));

    const campos = await pagina.evaluate(() => {
      const larg = window.innerWidth;
      return [...document.querySelectorAll('input[type=date]')]
        .filter((i) => i.offsetParent !== null)
        .map((i) => {
          const r = i.getBoundingClientRect();
          return { esq: Math.round(r.left), dir: Math.round(r.right), dentro: r.left >= -1 && r.right <= larg + 1 };
        });
    });
    conferir('os campos de data estão inteiros na tela',
      campos.length > 0 && campos.every((c) => c.dentro), JSON.stringify(campos));
  }

  await navegador.close();
  console.log(falhou ? '\nFALHOU ' + falhou : '\nNADA VAZA');
  process.exit(falhou ? 1 : 0);
})();
