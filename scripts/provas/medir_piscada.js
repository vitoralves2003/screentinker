/*
 * QUANTO TEMPO UM WIDGET LEVA PARA PINTAR NA TV — a medição que o código pede.
 *
 * MediaPlayerManager.revealWidget grava "widget revealed on <paint|deadline> after <N>ms" e o
 * comentário ao lado diz por quê: "it is the measurement that decides whether the second WebView
 * is worth its memory: 'paint' every time and widget pages are fast, 'deadline' often and they
 * are not". Ninguém a tinha lido ainda.
 *
 * A linha não fica gravada: DebugLog só a envia com o debug remoto LIGADO (set_debug), e o
 * servidor a repassa ao vivo para a sala do painel como dashboard:device-log. Então isto liga o
 * debug na TV, escuta pelo tempo pedido, e desliga ao sair — nunca deixa uma TV de cliente
 * transmitindo log.
 *
 * O que ela responde: o tempo do loadUrl ao primeiro pixel, na TV real. Esse tempo é do WIDGET,
 * não da transição — vale igual para vídeo→widget (onde é medido) e widget→widget (onde não é).
 */
const puppeteer = require('puppeteer');

const BASE = process.env.BASE || 'https://beta.loopplayer.com.br';
const DEVICE = process.env.DEVICE || 'f41d5b96-f73e-40a0-b85b-9008a4260f93';
const TOKEN = process.env.TOKEN || '';
const ESCUTAR_MS = Number(process.env.ESCUTAR_MS || 240000);

(async () => {
  if (!TOKEN) { console.log('SEM TOKEN'); process.exit(1); }

  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const pagina = await navegador.newPage();
  await pagina.goto(BASE + '/app', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await pagina.addScriptTag({ url: BASE + '/socket.io/socket.io.js' });

  const conectou = await pagina.evaluate(async (tk, dev) => {
    return await new Promise((resolve) => {
      const s = window.io('/dashboard', { auth: { token: tk }, transports: ['websocket', 'polling'] });
      window.__s = s;
      window.__linhas = [];
      s.on('dashboard:device-log', (d) => {
        if (d && d.device_id === dev) window.__linhas.push({ ts: d.ts, tag: d.tag, msg: d.message });
      });
      s.on('connect', () => resolve('ok'));
      s.on('connect_error', (e) => resolve('erro: ' + (e && e.message)));
      setTimeout(() => resolve('tempo esgotado'), 15000);
    });
  }, TOKEN, DEVICE);
  console.log('  socket do painel: ' + conectou);
  if (conectou !== 'ok') { await navegador.close(); process.exit(1); }

  const ligar = (enabled) => pagina.evaluate((dev, en) =>
    new Promise((r) => window.__s.timeout(5000).emit('dashboard:device-command',
      { device_id: dev, type: 'set_debug', payload: { enabled: en } },
      (err, ack) => r(err ? 'erro: ' + err.message : JSON.stringify(ack)))), DEVICE, enabled);

  console.log('  set_debug ON  -> ' + (await ligar(true)));
  console.log('  escutando por ' + Math.round(ESCUTAR_MS / 1000) + 's…');
  await new Promise((r) => setTimeout(r, ESCUTAR_MS));
  console.log('  set_debug OFF -> ' + (await ligar(false)));

  const linhas = await pagina.evaluate(() => window.__linhas);
  await navegador.close();

  console.log('\n  ── linhas recebidas: ' + linhas.length + ' ──');

  /* Duas linhas, dois sentidos: "widget revealed" (vídeo→widget e widget→widget) e
     "video revealed" (widget→vídeo e imagem→vídeo, desde a 1.9.48). */
  const reveladas = linhas.filter((l) => /(widget|video) revealed/i.test(l.msg));
  const outras = linhas.filter((l) => !/(widget|video) revealed/i.test(l.msg));

  if (!reveladas.length) {
    console.log('  NENHUMA "widget revealed" — ou o debug não ligou, ou não houve vídeo→widget na janela.');
    console.log('  amostra do que chegou:');
    for (const l of outras.slice(0, 12)) console.log('    [' + l.tag + '] ' + l.msg.slice(0, 110));
    process.exit(2);
  }

  console.log('  ── a medida ──');
  const tempos = [];
  for (const l of reveladas) {
    const m = l.msg.match(/on (\w+) after (\d+)ms/);
    if (m) tempos.push({ motivo: m[1], ms: Number(m[2]) });
    console.log('    ' + l.msg);
  }
  /* "paint" é o primeiro pixel do widget; "frame" é o primeiro quadro do vídeo. Os dois são o
     caminho bom — só "deadline" significa que a página ou o arquivo não chegou a tempo. */
  const porPaint = tempos.filter((t) => t.motivo === 'paint' || t.motivo === 'frame').map((t) => t.ms);
  const porDeadline = tempos.filter((t) => t.motivo === 'deadline').length;
  const mediana = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

  console.log('\n  reveladas por PAINT:    ' + porPaint.length + (porPaint.length ? '  (mediana ' + mediana(porPaint) + 'ms, máx ' + Math.max(...porPaint) + 'ms)' : ''));
  console.log('  reveladas por DEADLINE: ' + porDeadline + '  (2000ms estourado — a página NÃO pintou a tempo)');

  /* As outras linhas dizem o que mais a TV está fazendo na troca — vale olhar. */
  const interessantes = outras.filter((l) => /widget|Widget|showWidget|reload|WebView|render/i.test(l.msg));
  if (interessantes.length) {
    console.log('\n  ── o que mais a TV disse sobre widgets ──');
    for (const l of interessantes.slice(0, 15)) console.log('    [' + l.tag + '] ' + l.msg.slice(0, 120));
  }
})().catch((e) => { console.error('QUEBROU: ' + e.message); process.exit(3); });
