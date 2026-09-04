/*
 * O QUE A TELA DE DETALHE REALMENTE MOSTRA — medição, não leitura.
 *
 * device-detail.js tem 2.777 linhas, e boa parte delas desenha blocos com `hidden` ou atrás de
 * `isPlatformAdmin`. Portar o ARQUIVO seria reescrever controles que ninguém alcança; portar a
 * TELA é reescrever o que aparece. A diferença só se sabe medindo, com a sessão de verdade, na
 * tela de verdade.
 *
 * Imprime, por aba: os controles visíveis (id + rótulo) e os que existem no HTML mas estão
 * escondidos — para a decisão de portar ou não ser tomada com a lista na mão.
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'https://beta.loopplayer.com.br/gestao';
const TOKEN = process.env.TOKEN || '';
const TELA = process.env.TELA || '';

(async () => {
  if (!TOKEN || !TELA) { console.log('passe TOKEN=... e TELA=<id do device>'); process.exit(1); }
  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'], protocolTimeout: 180000 });
  const pagina = await navegador.newPage();
  await pagina.setViewport({ width: 1280, height: 900 });
  await pagina.evaluateOnNewDocument((tk) => {
    localStorage.setItem('token', tk);
    localStorage.setItem('loop_os_token', tk);
  }, TOKEN);

  await pagina.goto(`${UNI}/telas/${TELA}`, { waitUntil: 'networkidle0', timeout: 45000 });
  await pagina.waitForFunction(() => /Conteúdos/.test(document.body.innerText || ''), { timeout: 25000, polling: 300 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));

  const medir = () => pagina.evaluate(() => {
    const visivel = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const rotulo = (el) => {
      const t = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      if (t) return t;
      const lab = el.closest('.form-group, .info-card, label')?.querySelector('label, .info-card-label');
      return lab ? (lab.textContent || '').trim().slice(0, 60) : (el.getAttribute('placeholder') || el.tagName.toLowerCase());
    };
    const controles = [...document.querySelectorAll('[id]')].filter((el) =>
      /^(BUTTON|INPUT|SELECT|TEXTAREA|CANVAS)$/.test(el.tagName) || /Btn$|Panel$|Timeline$|Grid$/.test(el.id));
    const secoes = [...document.querySelectorAll('h3, h4')].map((h) => ({ texto: (h.textContent || '').trim(), visivel: visivel(h) }));
    return {
      abaAtiva: (document.querySelector('.tab.active') || {}).textContent?.trim(),
      abas: [...document.querySelectorAll('.tab')].map((t) => t.textContent.trim()),
      visiveis: controles.filter(visivel).map((el) => `${el.id} [${el.tagName.toLowerCase()}] ${rotulo(el)}`),
      escondidos: controles.filter((el) => !visivel(el)).map((el) => el.id),
      secoes,
      texto: (document.body.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean),
    };
  });

  const conteudos = await medir();
  console.log('=== ABAS: ' + JSON.stringify(conteudos.abas) + '  (ativa: ' + conteudos.abaAtiva + ') ===');
  console.log('\n=== ABA CONTEÚDOS — controles visíveis (' + conteudos.visiveis.length + ') ===');
  for (const c of conteudos.visiveis) console.log('  ' + c);
  console.log('\n  seções: ' + JSON.stringify(conteudos.secoes.filter((s) => s.visivel).map((s) => s.texto)));

  /* A aba de Configurações */
  await pagina.evaluate(() => {
    const t = [...document.querySelectorAll('.tab')].find((x) => /Configurações/.test(x.textContent || ''));
    if (t) t.click();
  });
  await new Promise((r) => setTimeout(r, 1500));
  const conf = await medir();
  console.log('\n=== ABA CONFIGURAÇÕES — controles visíveis (' + conf.visiveis.length + ') ===');
  for (const c of conf.visiveis) console.log('  ' + c);
  console.log('\n  seções visíveis: ' + JSON.stringify(conf.secoes.filter((s) => s.visivel).map((s) => s.texto)));
  console.log('\n  ESCONDIDOS no HTML (' + conf.escondidos.length + '): ' + conf.escondidos.join(', '));
  console.log('\n=== TEXTO DA ABA CONFIGURAÇÕES ===');
  for (const l of conf.texto.slice(0, 80)) console.log('  | ' + l);

  await navegador.close();
})().catch((e) => { console.error('QUEBROU: ' + e.message); process.exit(2); });
