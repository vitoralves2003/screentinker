/* Descartável: por que o passo do e-mail não avança. */
const puppeteer = require('puppeteer');
const UNI = process.env.UNI || 'http://127.0.0.1:3100';
const EMAIL = process.env.PROVA_EMAIL || 'cliente@exemplo.invalid';

async function tentar(navegador, rotulo, acao) {
  const p = await navegador.newPage();
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  const rede = [];
  p.on('response', (r) => {
    const u = new URL(r.url()).pathname;
    if (u.includes('/api/')) rede.push(r.status() + ' ' + u);
  });
  p.on('pageerror', (e) => rede.push('ERRO ' + e.message.slice(0, 60)));

  await p.goto(UNI + '/login', { waitUntil: 'networkidle0', timeout: 45000 });
  await new Promise((r) => setTimeout(r, 2000));
  rede.length = 0;

  await p.type('#loginEmail', EMAIL, { delay: 40 });
  const valor = await p.evaluate(() => document.querySelector('#loginEmail').value);

  await acao(p);
  await new Promise((r) => setTimeout(r, 4500));

  const depois = await p.evaluate(() => ({
    senha: !!document.querySelector('input[type=password]'),
    botoes: [...document.querySelectorAll('button')].filter((e) => e.offsetParent !== null)
      .map((b) => (b.innerText || '').trim().slice(0, 16)),
  }));

  console.log('\n  [' + rotulo + ']');
  console.log('    valor no campo: "' + valor + '"');
  console.log('    rede: ' + (rede.length ? rede.join(' | ') : 'NENHUMA'));
  console.log('    campo de senha apareceu: ' + depois.senha);
  console.log('    botoes: ' + depois.botoes.join(', '));
  await p.close();
}

(async () => {
  const n = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  await tentar(n, 'clique REAL no botao', async (p) => {
    const alvo = await p.evaluateHandle(() =>
      [...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && /Continuar/i.test(b.innerText)));
    const el = alvo.asElement();
    if (el) await el.click();
  });

  await tentar(n, 'Enter no campo', async (p) => {
    await p.focus('#loginEmail');
    await p.keyboard.press('Enter');
  });

  await n.close();
})();
