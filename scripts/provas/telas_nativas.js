/*
 * A LISTA DE TELAS EM REACT ABRE, MOSTRA A FROTA E SE ATUALIZA — num navegador com sessão.
 *
 * As travas do jest prendem TEXTO e FORMA. O que só um navegador responde:
 *
 *  · a página passa o portão do AppShell e DESENHA a frota da conta;
 *  · cada linha diz o estado EM PALAVRAS, e não só por cor — quem não distingue verde de âmbar
 *    ainda precisa saber que a tela está ociosa;
 *  · o filtro por estado e a busca recortam a lista de verdade;
 *  · o recorte que vem da URL (?f=atencao) mostra a faixa e o caminho de volta;
 *  · a seleção abre a barra com os comandos que aquelas telas HONRAM;
 *  · o legado não montou junto, e o socket do painel conectou (é ele que faz a lista mudar
 *    sozinha — sem ele a página fica correta e parada, que é o defeito mais silencioso desta
 *    tela);
 *  · sem erro de JavaScript e sem 5xx.
 *
 * Roda de /opt/novo-operacao/scripts/provas:
 *   docker run --rm --network host --user root -v "$PWD:/pin" -v /tmp/provas-saida:/p \
 *     -e TOKEN=... -e SAIDA=/p -e NODE_PATH=/usr/src/app/node_modules \
 *     --entrypoint node zenika/alpine-chrome:with-puppeteer /pin/telas_nativas.js
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'https://beta.loopplayer.com.br/gestao';
const TOKEN = process.env.TOKEN || '';
const SAIDA = process.env.SAIDA || '/p';

(async () => {
  if (!TOKEN) { console.log('SEM SESSAO: passe TOKEN=...'); process.exit(1); }

  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'], protocolTimeout: 180000 });
  const pagina = await navegador.newPage();
  await pagina.setViewport({ width: 1280, height: 900 });

  const erros = [];
  const respostas5xx = [];
  const socket = { abriu: false };
  pagina.on('pageerror', (e) => erros.push('pageerror: ' + e.message.slice(0, 140)));
  pagina.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (m.text().includes('Failed to load resource')) return;
    erros.push('console.error: ' + m.text().slice(0, 140));
  });
  pagina.on('response', (r) => { if (r.status() >= 500) respostas5xx.push(r.status() + ' ' + new URL(r.url()).pathname); });
  /* O socket do painel: o pedido de upgrade e o polling do socket.io passam por aqui. */
  pagina.on('request', (r) => { if (/\/socket\.io\//.test(r.url())) socket.abriu = true; });

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

  const abrir = async (caminho) => {
    await pagina.goto(UNI + caminho, { waitUntil: 'networkidle0', timeout: 45000 });
    await pagina.waitForFunction(() => {
      const t = document.body.innerText || '';
      return document.querySelector('tbody tr[data-device-id]') || /Nenhuma tela/.test(t);
    }, { timeout: 25000, polling: 300 }).catch(() => {});
    await esperar(900);
  };

  const medir = () => pagina.evaluate(() => {
    const linhas = [...document.querySelectorAll('tbody tr[data-device-id]')];
    return {
      texto: document.body.innerText || '',
      h1s: [...document.querySelectorAll('h1')].map((h) => h.textContent.trim()),
      linhas: linhas.length,
      /* O estado de cada linha, como a pessoa o lê e como o filtro o compara. */
      estados: linhas.slice(0, 30).map((tr) => ({
        id: tr.getAttribute('data-device-id'),
        liveness: tr.getAttribute('data-liveness'),
        nome: (tr.querySelector('a') || {}).textContent || '',
        emPalavras: (tr.querySelector('td[data-principal] div:nth-of-type(2)') || {}).textContent || '',
      })),
      casco: !!(document.querySelector('#toastContainer') || document.querySelector('#banners')),
      cssVelho: [...document.querySelectorAll('style')].some((s) => /\.settings-section|--console-bg|\.list-table \{/.test(s.textContent || '')),
    };
  });

  /* ── a lista ── */
  console.log('\n── /telas ──');
  await abrir('/telas');
  const m = await medir();
  conferir('um h1 só, e é "Telas"', m.h1s.length === 1 && m.h1s[0] === 'Telas', JSON.stringify(m.h1s));
  conferir('o subtítulo e o botão de adicionar estão lá', /Gerencie suas telas remotas/.test(m.texto) && /Adicionar tela/.test(m.texto));
  conferir('a frota da conta aparece', m.linhas > 0 || /Nenhuma tela ainda/.test(m.texto), m.linhas + ' tela(s)');
  conferir('as colunas são Tela · Layout', /tela[\s\S]*layout/i.test(m.texto));
  /* Cor não é rótulo: quem não distingue verde de âmbar precisa da palavra. */
  conferir('cada linha diz o estado em PALAVRAS',
    m.estados.length > 0 && m.estados.every((e) => /Saudável|Ocioso|Aguardando|Offline/.test(e.emPalavras)),
    JSON.stringify(m.estados.slice(0, 2).map((e) => e.emPalavras)));
  conferir('o estado também vai no atributo que o filtro compara',
    m.estados.every((e) => ['healthy', 'idle', 'awaiting', 'offline', 'provisioning'].includes(e.liveness)),
    JSON.stringify([...new Set(m.estados.map((e) => e.liveness))]));
  conferir('sem CascoOperacao', !m.casco);
  conferir('sem o CSS da casa velha', !m.cssVelho);
  conferir('o socket do painel foi aberto — é ele que atualiza sozinho', socket.abriu);
  await pagina.screenshot({ path: SAIDA + '/telas-nativa.png', fullPage: true });

  /* ── a busca ── */
  if (m.linhas > 1) {
    console.log('\n── busca ──');
    const alvo = m.estados[0].nome.trim().slice(0, 4);
    await pagina.type('input[placeholder="Buscar telas..."]', alvo);
    await esperar(600);
    const depois = await pagina.evaluate(() => document.querySelectorAll('tbody tr[data-device-id]').length);
    conferir('a busca recorta a lista', depois > 0 && depois <= m.linhas, `"${alvo}" → ${depois} de ${m.linhas}`);
    await pagina.evaluate(() => {
      const i = document.querySelector('input[placeholder="Buscar telas..."]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(i, '');
      i.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await esperar(500);
  }

  /* ── a seleção e os comandos ── */
  if (m.linhas > 0) {
    console.log('\n── seleção ──');
    await pagina.evaluate(() => {
      const cb = document.querySelector('tbody tr[data-device-id] input[type=checkbox]');
      if (cb) cb.click();
    });
    await esperar(500);
    const barra = await pagina.evaluate(() => {
      const t = document.body.innerText || '';
      const seletores = [...document.querySelectorAll('select')].map((s) => (s.options[0] || {}).textContent || '');
      return {
        contagem: /1 selecionado\(s\)/.test(t),
        limpar: /Limpar seleção/.test(t),
        excluir: /Excluir 1/.test(t),
        playlist: seletores.some((o) => /Definir playlist/.test(o)),
        comando: seletores.some((o) => /Enviar comando/.test(o)),
        /* Os comandos oferecidos: têm de ser os que a tela HONRA, nunca a lista inteira sem olhar. */
        comandos: (() => {
          const s = [...document.querySelectorAll('select')].find((x) => /Enviar comando/.test((x.options[0] || {}).textContent || ''));
          return s ? [...s.options].slice(1).map((o) => o.textContent) : [];
        })(),
      };
    });
    conferir('a barra aparece com a contagem e o limpar', barra.contagem && barra.limpar);
    conferir('"Definir playlist..." e "Excluir 1" estão na barra', barra.playlist && barra.excluir);
    conferir('os comandos oferecidos são os que a tela honra', barra.comando ? barra.comandos.length > 0 : true,
      barra.comando ? JSON.stringify(barra.comandos) : 'a seleção não honra comando nenhum — o seletor não aparece, e está certo');
    await pagina.screenshot({ path: SAIDA + '/telas-selecao.png' });
    await pagina.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /Limpar seleção/.test(x.textContent || ''));
      if (b) b.click();
    });
    await esperar(400);
  }

  /* ── o recorte que vem de fora ── */
  console.log('\n── /telas?f=atencao ──');
  await abrir('/telas?f=atencao');
  const f = await pagina.evaluate(() => ({
    texto: document.body.innerText || '',
    linhas: document.querySelectorAll('tbody tr[data-device-id]').length,
    temVoltar: !![...document.querySelectorAll('a')].find((a) => /Ver todas/.test(a.textContent || '')),
  }));
  conferir('a faixa diz o que está sendo mostrado', /Mostrando \d+ telas? — precisam de atenção/.test(f.texto), f.texto.split('\n').find((l) => /Mostrando/.test(l)) || '');
  conferir('há caminho de volta para a lista inteira', f.temVoltar);
  conferir('o recorte é menor que a frota, ou diz que não achou nada',
    f.linhas < m.linhas || /Nenhuma tela neste filtro/.test(f.texto), f.linhas + ' de ' + m.linhas);
  await pagina.screenshot({ path: SAIDA + '/telas-atencao.png', fullPage: true });

  /*
   * ── o DETALHE, que ainda é a tela antiga ──
   *
   * A lista virou React; o detalhe (device-detail.js) continua hospedado, agora numa rota de
   * verdade em vez de um hash. Foi o endereço que mudou, e é justamente isso que pode quebrar
   * sem ninguém ver: a rota responde 200 porque o Next serve a casca, e a view antiga é que
   * pode não montar. Então a prova exige o CONTEÚDO dela, e não o código HTTP.
   */
  if (m.linhas > 0) {
    const idAlvo = m.estados[0].id;
    console.log('\n── /telas/' + String(idAlvo).slice(0, 8) + '… (o detalhe hospedado) ──');
    await pagina.goto(UNI + '/telas/' + idAlvo, { waitUntil: 'networkidle0', timeout: 45000 });
    await pagina.waitForFunction(() => /Conteúdos|Configurações/.test(document.body.innerText || ''),
      { timeout: 25000, polling: 300 }).catch(() => {});
    await esperar(1200);
    const det = await pagina.evaluate(() => ({
      texto: (document.body.innerText || '').slice(0, 4000),
      abas: [...document.querySelectorAll('.tab')].map((t) => t.textContent.trim()),
      hash: window.location.hash,
      caminho: window.location.pathname,
    }));
    conferir('o detalhe da tela montou', det.abas.length > 0, JSON.stringify(det.abas));
    conferir('as abas de sempre estão lá', /Conteúdos/.test(det.texto) && /Configurações/.test(det.texto));
    conferir('o nome da tela aparece', det.texto.includes(m.estados[0].nome.trim()), m.estados[0].nome.trim());
    conferir('o endereço é a rota, com o hash que a view antiga espera',
      /\/telas\//.test(det.caminho) && det.hash.startsWith('#/device/'), det.caminho + det.hash);
    await pagina.screenshot({ path: SAIDA + '/tela-detalhe.png', fullPage: true });
  }

  /* ── o celular ── */
  console.log('\n── a lista num celular (390x844) ──');
  await pagina.setViewport({ width: 390, height: 844 });
  await abrir('/telas');
  const cel = await pagina.evaluate(() => ({
    rolaDeLado: document.documentElement.scrollWidth > window.innerWidth + 1,
    linhas: document.querySelectorAll('tbody tr[data-device-id]').length,
  }));
  conferir('a página não rola para os lados no celular', !cel.rolaDeLado);
  conferir('as telas continuam aparecendo', cel.linhas > 0 || m.linhas === 0, cel.linhas + ' linha(s)');
  await pagina.screenshot({ path: SAIDA + '/telas-celular.png', fullPage: true });

  console.log('\n── erros ──');
  conferir('sem erro de JavaScript', erros.length === 0, erros.join(' | '));
  conferir('sem 5xx', respostas5xx.length === 0, respostas5xx.join(' | '));

  await navegador.close();
  console.log('');
  if (falhas) { console.log(falhas + ' FALHA(S) em Telas'); process.exit(1); }
  console.log('A LISTA DE TELAS EM REACT ESTA DE PE');
})().catch((e) => { console.error('A PROVA QUEBROU: ' + e.message); process.exit(2); });
