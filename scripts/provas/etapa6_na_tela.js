/*
 * ETAPA 6 NA TELA — a casa do anunciante (05/09).
 *
 * O que ela confere, na ordem em que o anunciante vive:
 *
 *   1. entra com a sessão do PORTAL e cai dentro do contrato (um contrato só entra direto)
 *   2. o topo tem a marca do ASSINANTE — o nome que /api/portal/identidade devolve — e não
 *      "Loop Player"; o Loop Player fica no rodapé
 *   3. a navegação tem as quatro seções; no computador é lateral, e a barra inferior não existe
 *   4. Mídias continua dizendo o que dizia (limite, Enviar mídia)
 *   5. Faturas: o número de linhas na tela é o número que a API devolve
 *   6. Relatórios: o total de exibições na tela é o que a API devolve para 30 dias
 *   7. Materiais diz "Em breve", e não finge
 *   8. no CELULAR a barra inferior aparece, DENTRO da tela, com alvos de 44px — a lição de
 *      "visível não é dentro da tela" está aqui como asserção
 *
 * Os oráculos são a própria API do portal, lida de dentro da página com o mesmo token: a tela
 * não pode dizer um número que a API não diga.
 *
 *   docker run --rm --network host --user root -v "$PWD:/p" -e TOKEN=<portal> \
 *     -e NODE_PATH=/usr/src/app/node_modules --entrypoint node \
 *     zenika/alpine-chrome:with-puppeteer /p/etapa6_na_tela.js
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'https://beta.loopplayer.com.br/gestao';
const TOKEN = process.env.TOKEN || '';

let falhas = 0;
const ok = (m, extra) => console.log(`  ok    ${m}${extra !== undefined ? `   ${extra}` : ''}`);
const falha = (m, extra) => { falhas++; console.log(`  FALHA ${m}${extra !== undefined ? `   ${extra}` : ''}`); };
const afirmar = (cond, m, extra) => (cond ? ok(m, extra) : falha(m, extra));
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function esperarAte(fn, ms = 15000, passo = 250) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    try { const v = await fn(); if (v) return v; } catch { /* ainda não */ }
    await esperar(passo);
  }
  return null;
}

(async () => {
  if (!TOKEN) { console.log('SEM SESSAO DO PORTAL: passe TOKEN=<token de /api/portal/entrar>'); process.exit(1); }

  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await navegador.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const erros = [];
  page.on('pageerror', (e) => erros.push(String(e && e.message || e)));

  /* A sessão do portal mora em `loop_portal_token`, na origem do produto. */
  await page.goto(`${UNI}/portal/entrar`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('loop_portal_token', t), TOKEN);

  const daApi = (caminho) => page.evaluate(async (c, t) => {
    const r = await fetch(c, { headers: { Authorization: `Bearer ${t}` } });
    return r.ok ? r.json() : null;
  }, caminho, TOKEN);

  console.log('======== 1. a porta: entrar cai dentro do contrato ========');
  await page.goto(`${UNI}/portal`, { waitUntil: 'domcontentloaded' });
  const contratos = await daApi('/api/portal/contratos');
  afirmar(Array.isArray(contratos) && contratos.length > 0, 'a API tem contrato para este anunciante', contratos && contratos.length);
  if (!contratos || !contratos.length) { await navegador.close(); process.exit(1); }
  if (contratos.length > 1) {
    await esperarAte(() => page.$('[data-contrato]'));
    await page.click('[data-contrato]');
  }
  const noContrato = await esperarAte(() => /\/portal\/[^/]+\/midias$/.test(page.url()) ? page.url() : null);
  afirmar(!!noContrato, contratos.length === 1 ? 'um contrato só: entrou direto em Mídias' : 'escolhi o primeiro e entrei em Mídias', page.url().replace(UNI, ''));
  const contratoId = (page.url().match(/\/portal\/([^/]+)\/midias$/) || [])[1];
  afirmar(contratos.some((c) => c.id === contratoId), 'e o contrato aberto é um dos dele');

  console.log('======== 2. a marca no topo é a do assinante ========');
  const identidade = await daApi('/api/portal/identidade');
  afirmar(!!identidade && !!identidade.nome, 'a API diz de quem é a casa', identidade && identidade.nome);
  const topo = await esperarAte(async () => {
    const t = await page.$eval('header', (h) => h.innerText);
    return identidade && t.includes(identidade.nome) ? t : null;
  });
  afirmar(!!topo, 'o topo mostra o nome do assinante', identidade && identidade.nome);
  const textoDoTopo = await page.$eval('header', (h) => h.innerText);
  afirmar(!/Loop Player/.test(textoDoTopo), 'e NÃO diz "Loop Player" no topo');
  const rodape = await page.$eval('footer', (f) => f.innerText).catch(() => '');
  afirmar(/Loop Player/.test(rodape), 'o Loop Player fica no rodapé, discreto');
  if (identidade && identidade.logoUrl) {
    const logo = await page.$eval('header img', (i) => ({ ok: i.complete && i.naturalWidth > 0, src: i.src })).catch(() => null);
    afirmar(!!logo && logo.ok, 'a logo do assinante carregou de verdade (não só o <img>)', logo && logo.src);
  } else {
    ok('o assinante não tem logo cadastrada: só o nome (nada a conferir de imagem)');
  }
  const nomeDoContrato = contratos.find((c) => c.id === contratoId).cliente.nome;
  afirmar(textoDoTopo.includes(nomeDoContrato), 'e o cabeçalho diz em que contrato a pessoa está', nomeDoContrato);
  afirmar(textoDoTopo.includes('Meus contratos'), 'com a volta para "Meus contratos"');

  console.log('======== 3. a navegação: quatro seções, lateral no computador ========');
  const secoes = await page.$$eval('nav [data-secao]', (as) => as.map((a) => ({ id: a.dataset.secao, visivel: a.offsetParent !== null, texto: a.innerText.trim() })));
  const visiveis = secoes.filter((s) => s.visivel);
  afirmar(visiveis.length === 4, 'quatro seções visíveis', visiveis.map((s) => s.texto).join(' | '));
  for (const id of ['midias', 'faturas', 'relatorios', 'materiais']) {
    afirmar(visiveis.some((s) => s.id === id), `tem a seção ${id}`);
  }
  const barraInferior = await page.$eval('[data-barra-inferior]', (n) => n.offsetParent !== null).catch(() => false);
  afirmar(!barraInferior, 'a barra inferior NÃO aparece no computador');
  const ativa = await page.$eval('nav [data-secao][aria-current="page"]', (a) => a.dataset.secao).catch(() => null);
  afirmar(ativa === 'midias', 'a seção ativa está marcada', ativa);

  console.log('======== 4. Mídias continua dizendo o que dizia ========');
  const corpo = await page.evaluate(() => document.body.innerText);
  const contrato = contratos.find((c) => c.id === contratoId);
  if (contrato.limiteDeMidias !== null) {
    afirmar(corpo.includes(`${contrato.midiasNoAr} de ${contrato.limiteDeMidias} m`), 'o limite está na tela', `${contrato.midiasNoAr} de ${contrato.limiteDeMidias}`);
  }
  afirmar(contrato.suspenso ? corpo.includes('suspenso') : corpo.includes('Enviar mídia'), contrato.suspenso ? 'suspenso: diz por que não envia' : 'o botão Enviar mídia está lá');

  console.log('======== 5. Faturas: a tela conta o que a API conta ========');
  await page.click('nav [data-secao="faturas"]');
  await esperarAte(() => /\/faturas$/.test(page.url()));
  const faturasApi = await daApi(`/api/portal/contratos/${contratoId}/faturas`);
  afirmar(Array.isArray(faturasApi), 'a API responde as faturas', faturasApi && faturasApi.length);
  const linhas = await esperarAte(async () => {
    const n = (await page.$$('[data-fatura]')).length;
    const vazio = await page.evaluate(() => document.body.innerText.includes('Nenhuma cobrança emitida'));
    return n > 0 || vazio ? n : null;
  });
  afirmar(linhas === (faturasApi || []).length, 'linhas na tela = cobranças na API', `tela=${linhas} api=${(faturasApi || []).length}`);
  const textoFaturas = await page.evaluate(() => document.body.innerText);
  const abertas = (faturasApi || []).filter((f) => ['PENDING', 'OVERDUE', 'PARTIALLY_PAID'].includes(f.status));
  if (abertas.length) afirmar(textoFaturas.includes(`${abertas.length} em aberto`), 'o subtítulo soma o que está em aberto', `${abertas.length} em aberto`);
  const comLink = abertas.filter((f) => f.linkDePagamento);
  afirmar((textoFaturas.match(/\bPagar\b/g) || []).length === comLink.length, 'um botão Pagar por cobrança em aberto COM link', `pagar=${(textoFaturas.match(/\bPagar\b/g) || []).length} comLink=${comLink.length}`);
  /* O que o portal NÃO mostra continua não mostrando: nada de valor total do contrato. */
  afirmar(!/valor total/i.test(textoFaturas), 'e não há "valor total" do contrato na tela');

  console.log('======== 6. Relatórios: o total é o da API ========');
  await page.click('nav [data-secao="relatorios"]');
  await esperarAte(() => /\/relatorios$/.test(page.url()));
  const rel = await daApi(`/api/portal/contratos/${contratoId}/relatorio?dias=30`);
  afirmar(!!rel && rel.totais, 'a API responde o relatório de 30 dias', rel && JSON.stringify(rel.totais));
  const exib = await esperarAte(() => page.$eval('[data-total="exibicoes"]', (n) => n.innerText.replace(/\D/g, '')));
  afirmar(rel && exib === String(rel.totais.exibicoes), 'exibições na tela = exibições na API', `tela=${exib} api=${rel && rel.totais.exibicoes}`);
  const telas = await page.$eval('[data-total="telas"]', (n) => n.innerText.replace(/\D/g, '')).catch(() => null);
  afirmar(rel && telas === String(rel.totais.telas), 'telas na tela = telas na API', `tela=${telas} api=${rel && rel.totais.telas}`);
  const pressionado = await page.$eval('[aria-pressed="true"]', (b) => b.innerText).catch(() => null);
  afirmar(pressionado === 'Últimos 30 dias', 'a janela padrão é 30 dias', pressionado);
  if (rel && rel.totais.exibicoes > 0) {
    const porMidia = await page.evaluate(() => document.body.innerText.includes('Por mídia') && document.body.innerText.includes('Por tela'));
    afirmar(porMidia, 'com exibições, mostra Por mídia e Por tela');
  } else {
    afirmar(await page.evaluate(() => document.body.innerText.includes('Ainda não há exibições')), 'sem exibições, diz que não há — e não uma tabela vazia');
  }

  console.log('======== 7. Materiais diz a verdade ========');
  await page.click('nav [data-secao="materiais"]');
  await esperarAte(() => /\/materiais$/.test(page.url()));
  const mat = await esperarAte(() => page.evaluate(() => document.body.innerText.includes('Em breve') ? 1 : null));
  afirmar(!!mat, 'Materiais diz "Em breve"');

  console.log('======== 8. no celular a barra é inferior, e DENTRO da tela ========');
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(`${UNI}/portal/${contratoId}/midias`, { waitUntil: 'domcontentloaded' });
  const barra = await esperarAte(() => page.$eval('[data-barra-inferior]', (n) => {
    if (n.offsetParent === null) return null;
    const r = n.getBoundingClientRect();
    const itens = [...n.querySelectorAll('[data-secao]')].map((a) => a.getBoundingClientRect().height);
    return { top: r.top, bottom: r.bottom, itens, alturaDaJanela: window.innerHeight };
  }));
  afirmar(!!barra, 'a barra inferior aparece no celular');
  if (barra) {
    afirmar(barra.bottom <= barra.alturaDaJanela + 1 && barra.top >= 0, 'e está DENTRO da tela', `top=${Math.round(barra.top)} bottom=${Math.round(barra.bottom)} janela=${barra.alturaDaJanela}`);
    afirmar(barra.itens.length === 4 && barra.itens.every((h) => h >= 44), 'com quatro alvos de pelo menos 44px', barra.itens.map(Math.round).join(','));
  }
  const lateralNoCelular = await page.$$eval('nav [data-secao]', (as) => as.filter((a) => !a.closest('[data-barra-inferior]') && a.offsetParent !== null).length);
  afirmar(lateralNoCelular === 0, 'a lateral some no celular');
  const larguraDaPagina = await page.evaluate(() => document.documentElement.scrollWidth);
  afirmar(larguraDaPagina <= 390, 'a página não rola de lado', larguraDaPagina);

  afirmar(erros.length === 0, 'nenhum erro de JavaScript na página', erros.slice(0, 2).join(' | '));

  await navegador.close();
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTUDO OK');
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.log('ERRO', e && e.message || e); process.exit(1); });
