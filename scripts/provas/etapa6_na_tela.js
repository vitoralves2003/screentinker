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

  console.log('======== 0. a entrada já tem a cara de quem atende ========');
  const SLUG = process.env.SLUG || '';
  /* Navegador novo, sem ?de= e sem lembrança: a entrada é NEUTRA — "Portal do anunciante",
     e nunca "Loop Player", que o anunciante não contratou. */
  await page.goto(`${UNI}/portal/entrar`, { waitUntil: 'domcontentloaded' });
  const neutra = await esperarAte(() => page.$eval('[data-marca-da-entrada="sem"] h1', (n) => n.innerText.trim()));
  afirmar(neutra === 'Portal do anunciante', 'sem saber de quem é, a entrada diz "Portal do anunciante"', neutra);
  afirmar(!(await page.evaluate(() => document.body.innerText.includes('Loop Player'))), 'e "Loop Player" não aparece na entrada neutra');
  if (SLUG) {
    /* Sem sessão nenhuma ainda: a entrada do assinante é `/portal/<slug>`, o mesmo slug do
       cadastro público — o endereço diz de quem é. O oráculo é a rota pública de marca. */
    await page.goto(`${UNI}/portal/${encodeURIComponent(SLUG)}`, { waitUntil: 'domcontentloaded' });
    const marcaPublica = await page.evaluate(async (s) => {
      const r = await fetch(`/api/portal/marca/${encodeURIComponent(s)}`);
      return r.ok ? r.json() : null;
    }, SLUG);
    afirmar(!!marcaPublica && !!marcaPublica.nome, 'a rota pública de marca responde pelo slug', marcaPublica && marcaPublica.nome);
    const cartao = await esperarAte(() => page.evaluate(() => {
      const c = document.querySelector('[data-marca-da-entrada="sim"]');
      return c ? document.body.innerText : null;
    }));
    afirmar(!!cartao && marcaPublica && cartao.includes(marcaPublica.nome), 'a porta do assinante mostra o nome dele', marcaPublica && marcaPublica.nome);
    afirmar(!/Loop Player/.test(cartao || ''), 'e não "Loop Player" na porta');
    if (marcaPublica && marcaPublica.logoUrl) {
      const logo = await esperarAte(() => page.$eval('[data-marca-da-entrada="sim"] img', (i) => (i.complete && i.naturalWidth > 0 ? i.src : null)));
      afirmar(!!logo, 'a logo do assinante carregou na porta', logo);
    }
    const tituloDaAba = await esperarAte(async () => {
      const t = await page.title();
      return marcaPublica && t.includes(marcaPublica.nome) ? t : null;
    });
    afirmar(!!tituloDaAba, 'a aba do navegador é do assinante', tituloDaAba || (await page.title()));
    const lembrado = await page.evaluate(() => localStorage.getItem('loop_portal_de'));
    afirmar(lembrado === SLUG, 'a porta deixa lembrado de quem é', lembrado);
    /* Instalável como app DO ASSINANTE: manifesto por slug (nome, cores, ícones da logo). */
    const manifesto = await page.evaluate(async () => {
      const l = document.head.querySelector('link[rel="manifest"][data-portal]');
      if (!l) return { erro: 'sem <link rel=manifest>' };
      const r = await fetch(l.href);
      if (!r.ok) return { erro: 'manifesto HTTP ' + r.status };
      const m = await r.json();
      const icone = m.icons && m.icons[0] ? await fetch(m.icons[0].src) : null;
      return { name: m.name, scope: m.scope, start: m.start_url, tema: m.theme_color, icone: icone ? icone.status + ' ' + icone.headers.get('content-type') : 'sem ícone' };
    });
    afirmar(!manifesto.erro && marcaPublica && manifesto.name === marcaPublica.nome, 'o manifesto do app tem o nome do assinante', manifesto.erro || manifesto.name);
    afirmar(!manifesto.erro && new RegExp(`/portal/${SLUG}/`).test(manifesto.scope || ''), 'e o escopo é a casa dele', manifesto.scope);
    afirmar(!manifesto.erro && /^200 image\/png/.test(manifesto.icone || ''), 'e o ícone gerado da logo responde como PNG', manifesto.icone);
    /* Quem digita o endereço neutro depois disso é levado à porta certa. */
    await page.goto(`${UNI}/portal/entrar`, { waitUntil: 'domcontentloaded' });
    const levado = await esperarAte(() => (new RegExp(`/portal/${SLUG}$`).test(page.url()) ? page.url() : null));
    afirmar(!!levado, 'o endereço neutro leva à porta lembrada', page.url().replace(UNI, ''));
    const slugFalso = await page.evaluate(async () => (await fetch('/api/portal/marca/nao-existe-' + Date.now())).status);
    afirmar(slugFalso === 404, 'slug desconhecido é 404 na rota, sem explicar mais', slugFalso);
    await page.goto(`${UNI}/portal/nao-existe-${Date.now()}`, { waitUntil: 'domcontentloaded' });
    const naoExiste = await esperarAte(() => page.$('[data-endereco-nao-encontrado]'));
    afirmar(!!naoExiste, 'e um endereço inventado mostra "não existe", nunca a porta de outro');
    await page.evaluate(() => localStorage.removeItem('loop_portal_de'));
  } else {
    console.log('  (sem SLUG: a entrada com marca não foi conferida)');
  }

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
  const noContrato = await esperarAte(() => /\/portal\/[^/]+\/contratos\/[^/]+\/midias$/.test(page.url()) ? page.url() : null);
  afirmar(!!noContrato, contratos.length === 1 ? 'um contrato só: entrou direto em Mídias' : 'escolhi o primeiro e entrei em Mídias', page.url().replace(UNI, ''));
  const [, slugDaUrl, contratoId] = page.url().match(/\/portal\/([^/]+)\/contratos\/([^/]+)\/midias$/) || [];
  afirmar(!SLUG || slugDaUrl === SLUG, 'e o endereço carrega o slug do assinante', slugDaUrl);
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
  /* O interior ensina a entrada: depois de entrar, o navegador lembra de quem é a casa. */
  const ensinado = await esperarAte(() => page.evaluate(() => localStorage.getItem('loop_portal_de')));
  afirmar(!!ensinado && (!SLUG || ensinado === SLUG), 'o interior deixou o slug lembrado para a próxima entrada', ensinado);
  const nomeDoContrato = contratos.find((c) => c.id === contratoId).cliente.nome;
  afirmar(textoDoTopo.includes(nomeDoContrato), 'e o cabeçalho diz em que contrato a pessoa está', nomeDoContrato);
  afirmar(textoDoTopo.includes('Meus contratos'), 'com a volta para "Meus contratos"');

  console.log('======== 3. a navegação: quatro seções, lateral no computador ========');
  const secoes = await page.$$eval('nav [data-secao]', (as) => as.map((a) => ({ id: a.dataset.secao, visivel: a.offsetParent !== null, texto: a.innerText.trim() })));
  const visiveis = secoes.filter((s) => s.visivel);
  /* Três seções desde 06/09: Materiais saiu por decisão do Vitor, e a prova afirma a ausência. */
  afirmar(visiveis.length === 3, 'três seções visíveis', visiveis.map((s) => s.texto).join(' | '));
  for (const id of ['midias', 'faturas', 'relatorios']) {
    afirmar(visiveis.some((s) => s.id === id), `tem a seção ${id}`);
  }
  afirmar(!visiveis.some((s) => s.id === 'materiais') && !/Materiais/.test(await page.evaluate(() => document.body.innerText)), 'e Materiais não existe mais');
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
  /* Zero linhas com o aviso de vazio é resposta legítima — e zero é falso em JS. A rodada 14
     reprovou uma tela certa porque `esperarAte` leu o 0 como "ainda não". Devolve um objeto. */
  const contagem = await esperarAte(async () => {
    const n = (await page.$$('[data-fatura]')).length;
    const vazio = await page.evaluate(() => document.body.innerText.includes('Nenhuma cobrança emitida'));
    return n > 0 || vazio ? { n, vazio } : null;
  });
  const linhas = contagem ? contagem.n : null;
  afirmar(linhas === (faturasApi || []).length, 'linhas na tela = cobranças na API', `tela=${linhas} api=${(faturasApi || []).length}`);
  if ((faturasApi || []).length === 0) afirmar(!!(contagem && contagem.vazio), 'sem cobrança, a tela diz "Nenhuma cobrança emitida" — e não uma tabela vazia');
  const textoFaturas = await page.evaluate(() => document.body.innerText);
  const abertas = (faturasApi || []).filter((f) => ['PENDING', 'OVERDUE', 'PARTIALLY_PAID'].includes(f.status));
  if (abertas.length) afirmar(textoFaturas.includes(`${abertas.length} em aberto`), 'o subtítulo soma o que está em aberto', `${abertas.length} em aberto`);
  const comLink = abertas.filter((f) => f.linkDePagamento);
  afirmar((textoFaturas.match(/\bPagar\b/g) || []).length === comLink.length, 'um botão Pagar por cobrança em aberto COM link', `pagar=${(textoFaturas.match(/\bPagar\b/g) || []).length} comLink=${comLink.length}`);
  /* O que o portal NÃO mostra continua não mostrando: nada de valor total do contrato. */
  afirmar(!/valor total/i.test(textoFaturas), 'e não há "valor total" do contrato na tela');

  console.log('======== 6. Relatórios: a lista de mídias e o relatório de uma ========');
  await page.click('nav [data-secao="relatorios"]');
  await esperarAte(() => /\/relatorios$/.test(page.url()));
  const listaApi = await daApi(`/api/portal/contratos/${contratoId}/relatorio/midias`);
  afirmar(Array.isArray(listaApi), 'a API responde a lista de mídias do relatório', listaApi && listaApi.length);
  const linhasRel = await esperarAte(async () => {
    const n = (await page.$$('[data-midia-relatorio]')).length;
    const vazio = await page.evaluate(() => document.body.innerText.includes('Nenhuma mídia neste contrato'));
    return n > 0 || vazio ? { n } : null;
  });
  afirmar(!!linhasRel && linhasRel.n === (listaApi || []).length, 'mídias na tela = mídias na API', `tela=${linhasRel && linhasRel.n} api=${(listaApi || []).length}`);
  if (listaApi && listaApi.length) {
    const primeira = listaApi[0];
    const naTela = await page.$eval(`[data-midia-relatorio="${primeira.id}"]`, (a) => ({ telas: a.querySelector('[data-telas]')?.getAttribute('data-telas'), ex: a.querySelector('[data-exibicoes30]')?.getAttribute('data-exibicoes30') })).catch(() => null);
    afirmar(!!naTela && naTela.telas === String(primeira.telas) && naTela.ex === String(primeira.exibicoes30), 'telas e exibições de 30 dias iguais às da API', JSON.stringify(naTela));
    await page.click(`[data-midia-relatorio="${primeira.id}"]`);
    await esperarAte(() => new RegExp(`/relatorios/${primeira.id}$`).test(page.url()));
    const det = await daApi(`/api/portal/contratos/${contratoId}/relatorio/midias/${primeira.id}`);
    afirmar(!!det && det.totais, 'a API responde o relatório da mídia (30 dias)', det && JSON.stringify(det.totais));
    const exib = await esperarAte(() => page.$eval('[data-total="exibicoes"]', (n) => n.innerText.replace(/\D/g, '')));
    afirmar(det && exib === String(det.totais.exibicoes), 'exibições na tela = exibições na API', `tela=${exib} api=${det && det.totais.exibicoes}`);
    const pressionado = await page.$eval('[aria-pressed="true"]', (b) => b.innerText).catch(() => null);
    afirmar(pressionado === '30 dias', 'o período padrão é 30 dias', pressionado);
    const seletor = await page.$('[data-seletor-de-tela]');
    afirmar(!!seletor, 'há o seletor de tela (todas = total; uma = só nela)');
    const onde = await page.$eval('[data-telas-onde-esta]', (n) => n.innerText).catch(() => '');
    afirmar(det && (det.telas.length ? onde.includes(det.telas[0].nome) : /nenhuma tela/.test(onde)), 'a tela diz onde a mídia está, como a API', onde.slice(0, 80));
    if (det && det.totais.exibicoes === 0) {
      afirmar(await page.evaluate(() => document.body.innerText.includes('Nenhuma exibição neste período')), 'sem exibições, diz que não há — e não uma tabela vazia');
    }
    await page.goBack();
    await esperarAte(() => /\/relatorios$/.test(page.url()));
  }

  console.log('======== 7. o portal não tem rodapé do Loop Player, e os botões se leem ========');
  const semRodape = await page.evaluate(() => !document.querySelector('footer'));
  afirmar(semRodape, 'sem rodapé "Loop Player" (a casa é do assinante)');
  /* O texto do botão de período ativo tem a cor calculada pela luminância da marca. */
  const contraste = await page.$eval('[aria-pressed="true"]', (b) => {
    const cs = getComputedStyle(b);
    const rgb = (s) => (s.match(/\d+/g) || []).slice(0, 3).map(Number);
    const lum = ([r, g, bb]) => { const c = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(bb); };
    const lf = lum(rgb(cs.backgroundColor)); const lt = lum(rgb(cs.color));
    const razao = (Math.max(lf, lt) + 0.05) / (Math.min(lf, lt) + 0.05);
    return { fundo: cs.backgroundColor, texto: cs.color, razao: Math.round(razao * 10) / 10 };
  }).catch(() => null);
  afirmar(!!contraste && contraste.razao >= 3, 'o texto sobre a cor da marca tem contraste (>= 3:1)', contraste && `${contraste.texto} sobre ${contraste.fundo} = ${contraste.razao}:1`);

  console.log('======== 8. no celular a barra é inferior, e DENTRO da tela ========');
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(`${UNI}/portal/${slugDaUrl}/contratos/${contratoId}/midias`, { waitUntil: 'domcontentloaded' });
  /* A barra é `position: fixed`, e elemento fixo NÃO TEM offsetParent — perguntar por ele
     reprovou a barra certa na rodada 14. "Visível" aqui é: desenhada (display) e com altura. */
  const barra = await esperarAte(() => page.$eval('[data-barra-inferior]', (n) => {
    if (getComputedStyle(n).display === 'none') return null;
    const r = n.getBoundingClientRect();
    if (r.height === 0) return null;
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
