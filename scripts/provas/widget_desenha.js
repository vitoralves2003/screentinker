/*
 * O WIDGET DESENHA? — perguntado a um navegador, do jeito que o PLAYER carrega.
 *
 * O player não navega até a URL: ele baixa o HTML e o injeta com loadDataWithBaseURL, o que
 * produz uma ORIGEM OPACA. É por isso que ler o HTML com curl não prova nada — o HTML está
 * completo e com os dados dentro, e mesmo assim a tela fica em branco.
 *
 * `page.setContent()` reproduz exatamente isso: documento sem origem própria, com os cabeçalhos
 * de resposta aplicados por nós à mão, como o Chrome do WebView faria.
 *
 * Roda com:
 *   docker run --rm --network host -v "$PWD:/p" \
 *     --entrypoint node -e NODE_PATH=/usr/src/app/node_modules \
 *     zenika/alpine-chrome:with-puppeteer /p/provar-widget.js
 */
const puppeteer = require('puppeteer');

const BASE = process.env.BASE || 'https://beta.loopplayer.com.br';
const WIDGET = process.env.WIDGET || '9b37e840-314f-4230-87b1-82d579c52284';
const DEVICE = process.env.DEVICE || 'bf335cb8-241c-45e3-af1a-3a38e2ea56ae';

(async () => {
  const url = `${BASE}/api/widgets/${WIDGET}/render?device=${DEVICE}&rev=0`;
  const resp = await fetch(url);
  const html = await resp.text();
  const csp = resp.headers.get('content-security-policy');

  console.log('  HTTP ' + resp.status + '  ' + html.length + ' bytes');
  console.log('  CSP na resposta: ' + (csp ? csp.slice(0, 80) + '…' : '(nenhum)'));
  console.log('  a semente está no HTML: ' + html.includes('window.__WSEED__='));

  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const pagina = await navegador.newPage();

  const bloqueios = [];
  pagina.on('console', (m) => {
    const t = m.text();
    if (/Content Security Policy|Refused to/i.test(t)) bloqueios.push(t.slice(0, 150));
  });
  pagina.on('pageerror', (e) => bloqueios.push('pageerror: ' + e.message.slice(0, 120)));

  /*
   * O CSP chega por CABEÇALHO, e setContent não os aplica — então ele é reinjetado como <meta>,
   * que o Chrome honra igual. Sem isto o teste mediria um mundo sem CSP e daria verde sempre.
   */
  const comoOPlayerVe = csp
    ? html.replace(/<head>/i, `<head><meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, '&quot;')}">`)
    : html;

  await pagina.setContent(comoOPlayerVe, { waitUntil: 'networkidle0', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2500));

  const naTela = await pagina.evaluate(() => (document.body.innerText || '').trim());

  console.log('\n  ── o que aparece na tela ──');
  console.log(naTela ? naTela.split('\n').slice(0, 8).map((l) => '    ' + l).join('\n') : '    (NADA — tela em branco)');

  if (bloqueios.length) {
    console.log('\n  ── o navegador recusou ──');
    for (const b of [...new Set(bloqueios)].slice(0, 5)) console.log('    ' + b);
  }

  await navegador.close();

  /*
   * DESENHOU = O SCRIPT RODOU. Duas réguas erradas antes desta, e as duas do mesmo jeito:
   *
   *   "texto suficiente"   aprovou uma tela que dizia "--°C / Carregando…" — o esqueleto do
   *                        widget com o script bloqueado. Mediu que a página tinha CONTEÚDO.
   *   "tem temperatura"    reprovou notícias e relógio, que funcionavam perfeitamente. Mediu
   *                        uma característica do widget de CLIMA e a cobrou de todos.
   *
   * A pergunta que vale para os cinco tipos é uma só, e é a que o defeito respondia com "não":
   * o navegador executou o script inline? Isso se lê no console dele, não no formato do texto.
   */
  const cspBloqueou = bloqueios.some((b) => /Refused to execute inline script/i.test(b));
  const aindaCarregando = /Carregando…|--\s*°/.test(naTela);
  const temAlgo = naTela.length > 20;
  const desenhou = temAlgo && !cspBloqueou && !aindaCarregando;

  if (cspBloqueou) console.log('  motivo: o CSP recusou o script inline');
  else if (aindaCarregando) console.log('  motivo: o script não preencheu (ainda em "Carregando…")');
  console.log('\n  VEREDITO: ' + (desenhou ? 'o widget DESENHOU' : 'o widget NAO desenhou'));
  process.exit(desenhou ? 0 : 1);
})().catch((e) => { console.error('A PROVA QUEBROU: ' + e.message); process.exit(2); });
