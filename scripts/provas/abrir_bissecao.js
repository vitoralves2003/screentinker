/*
 * MEDE OS QUATRO MODOS da página de bisseção (/gestao/paridade-teste?m=0..3).
 * Temporário como ela: morre quando o defeito da página em branco morrer.
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'http://127.0.0.1:3100';
const TOKEN = process.env.TOKEN || '';

(async () => {
  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const pagina = await navegador.newPage();
  const erros = [];
  pagina.on('pageerror', (e) => erros.push('pageerror: ' + e.message));
  pagina.on('console', (m) => {
    if (m.type() === 'error') erros.push('console.error: ' + m.text());
  });
  await pagina.evaluateOnNewDocument((t) => {
    localStorage.setItem('token', t);
    localStorage.setItem('user', '{}');
  }, TOKEN);

  for (const modo of [0, 1, 2, 3]) {
    const antes = erros.length;
    await pagina.goto(`${UNI}/gestao/paridade-teste?m=${modo}`, { waitUntil: 'networkidle2', timeout: 30000 });
    let estado = '(sem estado)';
    try {
      await pagina.waitForFunction(
        () => (document.querySelector('[data-estado]')?.textContent || '').includes('rodou'),
        { timeout: 12000 },
      );
    } catch { /* o estado abaixo conta a história */ }
    estado = await pagina.evaluate(
      () => (document.querySelector('[data-estado]')?.textContent || '(sem [data-estado] no DOM)'),
    );
    const host = await pagina.evaluate(
      () => {
        const ps = document.querySelectorAll('[data-estado]');
        const el = ps.length ? ps[0].nextElementSibling : null;
        return el ? (el.textContent || '(host vazio)').slice(0, 80) : '(sem host)';
      },
    );
    console.log(`modo ${modo}: estado="${estado}" host="${host}"`
      + (erros.length > antes ? ` ERROS: ${erros.slice(antes).join(' | ')}` : ''));
  }

  await navegador.close();
})();
