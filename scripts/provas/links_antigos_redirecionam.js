/*
 * OS LINKS ANTIGOS LEVAM À TELA NOVA — e não a uma segunda cópia dela.
 *
 * Telas, Arquivos, Playlists, Layouts e a Central de ajuda vivem em React. Mas `/app#/devices`
 * está nos favoritos de alguém, colado num grupo de mensagens, no histórico do navegador. Até
 * 04/09 esse endereço abria a tela ANTIGA, funcionando — que é a pior forma de duas telas para a
 * mesma coisa: as duas funcionam, e a que mudou não é a que a pessoa está olhando.
 *
 * Agora eles redirecionam pelo href do MENU SERVIDO, que é a fonte da verdade das rotas.
 *
 * A prova exige o destino E o conteúdo: um redirecionamento que chega numa página em branco é
 * pior que nenhum. E exige que o FILTRO viaje junto — `#/devices?f=atencao` tem de virar
 * `?f=atencao` lá, senão o link do alerta cai na frota inteira e o alerta perde o sentido.
 */
const puppeteer = require('puppeteer');

const BASE = process.env.BASE || 'https://beta.loopplayer.com.br';
const TOKEN = process.env.TOKEN || '';
const TELA = process.env.TELA || '';

(async () => {
  if (!TOKEN) { console.log('SEM SESSAO: passe TOKEN=...'); process.exit(1); }
  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'], protocolTimeout: 180000 });
  const pagina = await navegador.newPage();
  await pagina.setViewport({ width: 1280, height: 900 });
  await pagina.evaluateOnNewDocument((tk) => {
    localStorage.setItem('token', tk);
    localStorage.setItem('loop_os_token', tk);
  }, TOKEN);

  let falhas = 0;
  const conferir = (o_que, condicao, detalhe) => {
    console.log('  ' + (condicao ? 'ok    ' : 'FALHA ') + o_que + (detalhe ? '   ' + detalhe : ''));
    if (!condicao) falhas++;
  };
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

  const casos = [
    ['#/devices', '/gestao/telas', 'Gerencie suas telas remotas'],
    ['#/devices?f=atencao', '/gestao/telas?f=atencao', 'precisam de atenção'],
    ['#/content', '/gestao/arquivos', 'Envie e organize suas mídias'],
    ['#/playlists', '/gestao/playlists', 'Crie e gerencie playlists'],
    ['#/layouts', '/gestao/layouts', 'Layouts e modelos de tela'],
    ['#/help', '/gestao/ajuda', 'Central de ajuda'],
  ];
  if (TELA) casos.push(['#/device/' + TELA, '/gestao/telas/' + TELA, 'Conteúdos']);

  for (const [hash, destinoEsperado, textoEsperado] of casos) {
    console.log('\n── /app' + hash + ' ──');
    await pagina.goto(BASE + '/app' + hash, { waitUntil: 'networkidle0', timeout: 45000 });
    /* O redirecionamento é uma navegação de verdade: espera a URL sair de /app. */
    await pagina.waitForFunction(() => !location.pathname.startsWith('/app'), { timeout: 20000, polling: 250 }).catch(() => {});
    await esperar(1200);
    const onde = await pagina.evaluate(() => ({
      url: location.pathname + location.search,
      texto: (document.body.innerText || '').slice(0, 2500),
      /* Voltar não pode quicar de volta para cá: o redirecionamento usa location.replace. */
      passos: history.length,
    }));
    conferir('leva para ' + destinoEsperado, onde.url === destinoEsperado || onde.url.startsWith(destinoEsperado), onde.url);
    conferir('e a tela nova DESENHOU', onde.texto.includes(textoEsperado), JSON.stringify(onde.texto.split('\n').filter(Boolean).slice(0, 2)));
  }

  console.log('');
  if (falhas) { console.log(falhas + ' FALHA(S) nos links antigos'); process.exit(1); }
  console.log('TODO LINK ANTIGO CHEGA NA TELA NOVA');
  await navegador.close();
})().catch((e) => { console.error('A PROVA QUEBROU: ' + e.message); process.exit(2); });
