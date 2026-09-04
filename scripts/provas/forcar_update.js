/*
 * PEDIR ÀS TVs QUE VERIFIQUEM A ATUALIZAÇÃO AGORA, em vez de esperar o verificador de 30 min.
 *
 * Tenta `update` (exige a capacidade system.self_update — o ack diz se a TV a declarou); se a
 * TV não aceitar, cai para `restart`, que o player entende sem capacidade e que dispara a
 * checagem de 60s-após-o-arranque. Os acks são impressos como vieram: a resposta do servidor é a
 * evidência, não a minha suposição sobre o que a TV suporta.
 */
const puppeteer = require('puppeteer');

const BASE = process.env.BASE || 'https://beta.loopplayer.com.br';
const TOKEN = process.env.TOKEN || '';
const TVS = (process.env.DEVICES || '').split(',').filter(Boolean);

(async () => {
  if (!TOKEN || !TVS.length) { console.log('SEM TOKEN ou SEM DEVICES'); process.exit(1); }

  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const pagina = await navegador.newPage();
  await pagina.goto(BASE + '/app', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await pagina.addScriptTag({ url: BASE + '/socket.io/socket.io.js' });

  const conectou = await pagina.evaluate(async (tk) => new Promise((resolve) => {
    const s = window.io('/dashboard', { auth: { token: tk }, transports: ['websocket', 'polling'] });
    window.__s = s;
    s.on('connect', () => resolve('ok'));
    s.on('connect_error', (e) => resolve('erro: ' + (e && e.message)));
    setTimeout(() => resolve('tempo esgotado'), 15000);
  }), TOKEN);
  console.log('  socket do painel: ' + conectou);
  if (conectou !== 'ok') { await navegador.close(); process.exit(1); }

  const mandar = (dev, type, payload) => pagina.evaluate((d, t, p) =>
    new Promise((r) => window.__s.timeout(8000).emit('dashboard:device-command',
      { device_id: d, type: t, payload: p || {} },
      (err, ack) => r(err ? { erro: err.message } : ack))), dev, type, payload);

  for (const dev of TVS) {
    const curto = dev.slice(0, 8);
    const a = await mandar(dev, 'update', {});
    console.log(`  ${curto}  update  -> ${JSON.stringify(a)}`);
    if (!a || !a.delivered) {
      const b = await mandar(dev, 'restart', {});
      console.log(`  ${curto}  restart -> ${JSON.stringify(b)}`);
    }
  }

  await navegador.close();
})().catch((e) => { console.error('QUEBROU: ' + e.message); process.exit(3); });
