/*
 * DIAGNÓSTICO DA PRÉVIA — separar "o botão não chama" de "o player não obedece".
 *
 * A prova reprovou "o contador mudou" numa lista de 2 itens iguais e sem agenda, onde andar é
 * obrigatório. As duas causas possíveis não se distinguem de fora: o clique pode não estar
 * chamando o postMessage, ou a mensagem pode estar chegando e sendo recusada lá dentro.
 *
 * Este script mede os dois lados: instala um espião no postMessage da página, clica no botão, e
 * depois manda a MESMA mensagem à mão. Se a mão funciona e o clique não, o defeito é meu; se
 * nenhum funciona, o defeito está no player ou na origem.
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'https://beta.loopplayer.com.br/gestao';
const TOKEN = process.env.TOKEN || '';
const LISTA = process.env.LISTA || '';

(async () => {
  if (!TOKEN || !LISTA) { console.log('passe TOKEN=... e LISTA=<id da playlist>'); process.exit(1); }
  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'], protocolTimeout: 180000 });
  const pagina = await navegador.newPage();
  await pagina.setViewport({ width: 1280, height: 900 });
  pagina.on('pageerror', (e) => console.log('  pageerror: ' + e.message.slice(0, 160)));
  pagina.on('console', (m) => { if (m.type() === 'error') console.log('  console.error: ' + m.text().slice(0, 160)); });

  await pagina.evaluateOnNewDocument((tk) => {
    localStorage.setItem('token', tk);
    localStorage.setItem('loop_os_token', tk);
  }, TOKEN);

  await pagina.goto(`${UNI}/playlists/${LISTA}`, { waitUntil: 'networkidle0', timeout: 45000 });
  await new Promise((r) => setTimeout(r, 1500));

  /* O espião: guarda toda mensagem que a PÁGINA manda para qualquer janela. */
  await pagina.evaluate(() => {
    window.__enviadas = [];
    const original = window.postMessage.bind(window);
    const patchar = (janela) => {
      const antes = janela.postMessage;
      janela.postMessage = function (...args) { window.__enviadas.push(args[0]); return antes.apply(this, args); };
    };
    window.__patchar = patchar;
    window.__original = original;
  });

  await pagina.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /Pré-visualizar/.test(x.textContent || ''));
    if (b) b.click();
  });
  await pagina.waitForFunction(() => {
    const el = document.querySelector('[data-posicao-da-previa]');
    return !!el && /\d+ de \d+/.test(el.textContent || '');
  }, { timeout: 20000, polling: 300 }).catch(() => {});

  /* Agora que o iframe existe, embrulha o postMessage DELE. */
  const preparado = await pagina.evaluate(() => {
    const f = document.querySelector('iframe[title="Prévia da playlist"]');
    if (!f || !f.contentWindow) return 'sem iframe';
    window.__patchar(f.contentWindow);
    return 'espião no contentWindow do iframe';
  });
  console.log('  ' + preparado);

  const antes = await pagina.evaluate(() => (document.querySelector('[data-posicao-da-previa]') || {}).textContent?.trim());
  console.log('  contador antes:            ' + JSON.stringify(antes));

  /* 0) o botão, por dentro */
  const botao = await pagina.evaluate(() => {
    const bs = [...document.querySelectorAll('button')].filter((x) => /Próximo/.test(x.textContent || ''));
    return bs.map((b) => ({
      texto: b.textContent.trim(), desabilitado: b.disabled,
      visivel: !!(b.offsetWidth || b.offsetHeight),
      caixa: (() => { const r = b.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
      /* Quem está por cima no centro dele? Um véu invisível engole o clique de mouse. */
      porCima: (() => { const r = b.getBoundingClientRect(); const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return el ? el.tagName + '.' + (el.className || '').toString().slice(0, 40) : 'nada'; })(),
    }));
  });
  console.log('  botões "Próximo":          ' + JSON.stringify(botao));

  /* 1) pelo BOTÃO */
  await pagina.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /Próximo/.test(x.textContent || ''));
    if (b) b.click();
  });
  await new Promise((r) => setTimeout(r, 2500));
  const r1 = await pagina.evaluate(() => ({
    contador: (document.querySelector('[data-posicao-da-previa]') || {}).textContent?.trim(),
    enviadas: (window.__enviadas || []).slice(-3),
  }));
  console.log('  depois do CLIQUE:          ' + JSON.stringify(r1.contador) + '   mensagens vistas: ' + JSON.stringify(r1.enviadas));

  /* 1b) o MESMO botão, de novo, alguns segundos depois — separa "não chega" de "chegou cedo" */
  await pagina.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /Próximo/.test(x.textContent || ''));
    if (b) b.click();
  });
  await new Promise((r) => setTimeout(r, 2500));
  const r1b = await pagina.evaluate(() => (document.querySelector('[data-posicao-da-previa]') || {}).textContent?.trim());
  console.log('  segundo CLIQUE:            ' + JSON.stringify(r1b));

  /* 2) À MÃO, a mesma mensagem, endereçada do mesmo jeito */
  const r2 = await pagina.evaluate(async () => {
    const f = document.querySelector('iframe[title="Prévia da playlist"]');
    f.contentWindow.postMessage({ source: 'screentinker-preview', action: 'next' }, window.location.origin);
    await new Promise((r) => setTimeout(r, 2500));
    return (document.querySelector('[data-posicao-da-previa]') || {}).textContent?.trim();
  });
  console.log('  depois da MAO:             ' + JSON.stringify(r2));

  /* 3) o que o player pensa de si mesmo */
  const dentro = await pagina.evaluate(async () => {
    const f = document.querySelector('iframe[title="Prévia da playlist"]');
    try {
      const w = f.contentWindow;
      return {
        url: w.location.href.slice(0, 120),
        temPlaylist: typeof w.playlist !== 'undefined' ? (w.playlist || []).length : 'inacessivel',
        indice: typeof w.currentIndex !== 'undefined' ? w.currentIndex : 'inacessivel',
      };
    } catch (e) { return { erro: String(e).slice(0, 120) }; }
  });
  console.log('  dentro do player:          ' + JSON.stringify(dentro));

  await navegador.close();
})().catch((e) => { console.error('QUEBROU: ' + e.message); process.exit(2); });
