/* Descartável: o que acontece entre digitar o e-mail e a senha aparecer. */
const puppeteer = require('puppeteer');
const UNI = process.env.UNI || 'http://127.0.0.1:3100';

(async () => {
  const n = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const p = await n.newPage();
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

  p.on('response', (r) => {
    const u = new URL(r.url()).pathname;
    if (u.includes('/api/')) console.log('  rede: ' + r.status() + ' ' + u);
  });
  p.on('pageerror', (e) => console.log('  pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') console.log('  console: ' + m.text().slice(0, 120)); });

  await p.goto(UNI + '/login', { waitUntil: 'networkidle0', timeout: 45000 });
  await new Promise((r) => setTimeout(r, 2000));

  console.log('  --- antes de submeter');
  console.log('  ' + JSON.stringify(await p.evaluate(() => ({
    campos: [...document.querySelectorAll('input')].filter((e) => e.offsetParent !== null)
      .map((i) => i.type + '/' + (i.id || i.name)),
    botoes: [...document.querySelectorAll('button')].filter((e) => e.offsetParent !== null)
      .map((b) => (b.innerText || '').trim().slice(0, 18)),
  }))));

  await p.type('#loginEmail', process.env.PROVA_EMAIL || 'cliente@exemplo.invalid');
  console.log('  --- e-mail digitado, submetendo o formulario');

  /* Pelo FORM, e nao pelo botao: um submit de teclado e o que a pessoa faz no celular. */
  await p.evaluate(() => {
    const f = document.querySelector('#loginEmail').closest('form');
    if (f) f.requestSubmit ? f.requestSubmit() : f.submit();
    else {
      const b = [...document.querySelectorAll('button[type=submit]')].find((e) => e.offsetParent !== null);
      if (b) b.click();
    }
  });

  await new Promise((r) => setTimeout(r, 5000));
  console.log('  --- depois');
  console.log('  ' + JSON.stringify(await p.evaluate(() => ({
    url: location.href,
    campos: [...document.querySelectorAll('input')].filter((e) => e.offsetParent !== null)
      .map((i) => i.type + '/' + (i.id || i.name)),
    botoes: [...document.querySelectorAll('button')].filter((e) => e.offsetParent !== null)
      .map((b) => (b.innerText || '').trim().slice(0, 18)),
    texto: document.body.innerText.replace(/\s+/g, ' ').slice(0, 130),
  }))));

  await n.close();
})();
