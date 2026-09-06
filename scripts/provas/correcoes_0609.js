/*
 * AS CORREÇÕES DE 06/09, NUM CHROME DE 390px — o que o Vitor viu no celular, uma por vez.
 *
 *   1. A rolagem depois de NAVEGAR pela gaveta e pela barra (era assim que travava: a gaveta
 *      trava o body e a página nova chegava sem destravar; abrir pelo endereço nunca reproduzia).
 *   2. "Gerar cobrança" e o "Mais" do contrato abrem uma folha que CABE na tela.
 *   3. O Dashboard tem três fatias, e o alerta navega sem passar pela página antiga.
 *   4. As linhas de mídia: sem setas na linha, "⋯" com o resto, aba "Mídias".
 *   5. A prévia: o link assinado abre sem sessão, o adulterado e o vencido recebem 403.
 *
 * Roda de /opt/novo-operacao/scripts/provas (ver provar_correcoes_0609.sh).
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'https://beta.loopplayer.com.br/gestao';
const BASE = process.env.BASE || 'https://beta.loopplayer.com.br';
const TOKEN = process.env.TOKEN || '';

let falhas = 0;
const ok = (m, x) => console.log(`  ok    ${m}${x !== undefined ? `   ${x}` : ''}`);
const falha = (m, x) => { falhas++; console.log(`  FALHA ${m}${x !== undefined ? `   ${x}` : ''}`); };
const afirmar = (c, m, x) => (c ? ok(m, x) : falha(m, x));
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!TOKEN) { console.log('SEM SESSAO: passe TOKEN=...'); process.exit(1); }
  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await navegador.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  const erros = [];
  page.on('pageerror', (e) => erros.push(String(e).slice(0, 120)));
  await page.goto(`${UNI}/ajuda`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('token', t), TOKEN);

  const ids = await page.evaluate(async (t) => {
    const h = { Authorization: 'Bearer ' + t };
    const j = async (u) => { try { const r = await fetch(u, { headers: h }); if (!r.ok) return null; return await r.json(); } catch { return null; } };
    const lista = (x) => (Array.isArray(x) ? x : (x && (x.data || x.items || x.devices || x.playlists || x.contracts)) || []);
    const devices = lista(await j('/api/devices'));
    const playlists = lista(await j('/api/playlists'));
    const contratos = lista(await j('/gestao-api/contracts'));
    const conteudos = lista(await j('/api/content'));
    return {
      tela: devices[0] && devices[0].id,
      playlist: (playlists.find((p) => (p.item_count || p.items_count || 0) > 1) || playlists[0] || {}).id,
      contrato: (contratos.find((c) => c.status !== 'DRAFT') || contratos[0] || {}).id,
      midia: (conteudos.find((c) => c.filepath && !c.remote_url) || conteudos.find((c) => !c.remote_url) || {}).id,
    };
  }, TOKEN);
  console.log('cenario: ' + JSON.stringify(ids));

  const medirRolagem = async () => page.evaluate(() => {
    const body = getComputedStyle(document.body);
    const docH = document.documentElement.scrollHeight; const inner = window.innerHeight;
    window.scrollTo(0, 999999); const chegou = window.scrollY; window.scrollTo(0, 0);
    return { url: location.pathname, fixo: body.position === 'fixed', escondido: body.overflow === 'hidden', maxScroll: docH - inner, chegou };
  });
  const confereRolagem = async (rotulo) => {
    await esperar(1500);
    const m = await medirRolagem();
    afirmar(!m.fixo && !m.escondido, `${rotulo}: o body não ficou travado`, `${m.url} position-fixed=${m.fixo} overflow-hidden=${m.escondido}`);
    if (m.maxScroll > 0) afirmar(m.chegou >= m.maxScroll - 1, `${rotulo}: a página rola até o fim`, `rolou ${m.chegou} de ${m.maxScroll}`);
    else ok(`${rotulo}: cabe na tela sem rolar`);
  };
  const pelaGaveta = async (trecho) => {
    const foi = await page.evaluate((t) => {
      const sr = document.querySelector('loop-sidebar').shadowRoot;
      const menu = sr.querySelector('.inferior .menu'); if (!menu) return 'sem botão Menu';
      menu.click();
      const a = [...sr.querySelectorAll('nav a[href]')].find((x) => (x.getAttribute('href') || '').includes(t));
      if (!a) return 'sem item ' + t;
      a.click(); return 'ok';
    }, trecho);
    if (foi !== 'ok') falha(`navegar pela gaveta até ${trecho}`, foi);
  };
  const pelaBarra = async (trecho) => {
    const foi = await page.evaluate((t) => {
      const sr = document.querySelector('loop-sidebar').shadowRoot;
      const a = [...sr.querySelectorAll('.inferior a[href]')].find((x) => (x.getAttribute('href') || '').includes(t));
      if (!a) return 'sem atalho ' + t;
      a.click(); return 'ok';
    }, trecho);
    if (foi !== 'ok') falha(`navegar pela barra até ${trecho}`, foi);
  };

  console.log('======== 1. a rolagem depois de navegar ========');
  await page.goto(`${UNI}/dashboard`, { waitUntil: 'networkidle0', timeout: 60000 });
  await pelaGaveta('/contratos'); await confereRolagem('gaveta → Contratos');
  await pelaGaveta('/configuracoes'); await confereRolagem('gaveta → Configurações');
  await pelaBarra('/arquivos'); await confereRolagem('barra → Arquivos');
  await pelaBarra('/playlists'); await confereRolagem('barra → Playlists');
  await pelaGaveta('/contratos'); await esperar(1200);
  const foiAoNovo = await page.evaluate(() => { const a = [...document.querySelectorAll('a')].find((x) => /Novo contrato/.test(x.textContent || '')); if (!a) return false; a.click(); return true; });
  if (foiAoNovo) await confereRolagem('Contratos → Novo contrato'); else falha('o botão "Novo contrato" existe na lista');
  const gavetaFechada = await page.evaluate(() => !document.querySelector('loop-sidebar').hasAttribute('aberta'));
  afirmar(gavetaFechada, 'a gaveta está fechada depois de navegar');

  console.log('======== 2. os menus cabem na tela ========');
  const folhaCabe = async (rotulo) => {
    await esperar(400);
    const r = await page.evaluate(() => {
      const folha = document.querySelector('[data-folha-inferior] [role="menu"]');
      if (!folha) return null;
      const b = folha.getBoundingClientRect();
      return { left: Math.round(b.left), right: Math.round(b.right), bottom: Math.round(b.bottom), inner: window.innerHeight, itens: folha.querySelectorAll('[role="menuitem"]').length };
    });
    afirmar(!!r, `${rotulo}: abre como folha inferior`);
    if (r) afirmar(r.left >= 0 && r.right <= 390 && r.bottom <= r.inner, `${rotulo}: a folha cabe na tela`, JSON.stringify(r));
    return r;
  };
  await page.goto(`${UNI}/financeiro`, { waitUntil: 'networkidle0', timeout: 60000 });
  await esperar(800);
  await page.click('[data-gerar-cobranca]');
  const gerar = await folhaCabe('Gerar cobrança');
  if (gerar) afirmar(gerar.itens === 3, 'com as três formas: avulsa, parcelamento e assinatura', gerar.itens);
  const opcoes = await page.evaluate(() => [...document.querySelectorAll('[data-folha-inferior] [data-opcao]')].map((b) => b.getAttribute('data-opcao')).join(','));
  afirmar(opcoes === 'avulsa,parcelamento,assinatura', 'as opções têm as marcas de sempre', opcoes);
  await page.keyboard.press('Escape'); await esperar(300);
  afirmar(await page.evaluate(() => !document.querySelector('[data-folha-inferior]')), 'Escape fecha a folha');
  if (ids.contrato) {
    await page.goto(`${UNI}/contratos/${ids.contrato}`, { waitUntil: 'networkidle0', timeout: 60000 });
    await esperar(800);
    const temMais = await page.evaluate(() => !!document.querySelector('[data-mais-acoes]'));
    if (temMais) { await page.click('[data-mais-acoes]'); await folhaCabe('"Mais" do contrato'); await page.keyboard.press('Escape'); }
    else ok('este contrato não tem "Mais" (nada a abrir)');
  }

  console.log('======== 3. o Dashboard ========');
  await page.goto(`${UNI}/dashboard`, { waitUntil: 'networkidle0', timeout: 60000 });
  await esperar(1500);
  const painel = await page.evaluate(() => document.body.innerText || '');
  afirmar(/Em dia/.test(painel) && /Vencendo/.test(painel) && /Vencidos/.test(painel), 'o donut tem Em dia, Vencendo e Vencidos');
  afirmar(!/\bEmitidos\b/.test(painel) && !/Em assinatura\b/.test(painel), 'e não tem mais as fatias Emitidos e Em assinatura');
  const overview = await page.evaluate(async (t) => { const r = await fetch('/gestao-api/dashboard/overview', { headers: { Authorization: 'Bearer ' + t } }); return r.ok ? r.json() : null; }, TOKEN);
  if (overview && overview.contracts) afirmar(overview.contracts.active >= (overview.contracts.issued || 0), 'na API, ativos ≥ emitidos (emitido conta como ativo)', `active=${overview.contracts.active} issued=${overview.contracts.issued}`);
  else falha('a API do Dashboard respondeu');
  const alertaCru = await page.evaluate(() => [...document.querySelectorAll('a')].some((a) => /^\/(contratos|financeiro|clientes)/.test(a.getAttribute('href') || '')));
  afirmar(!alertaCru, 'nenhum link do painel aponta para a raiz sem o prefixo da Gestão', await page.evaluate(() => [...document.querySelectorAll('a')].map((a) => a.getAttribute('href') || '').filter((h) => /^\/(contratos|financeiro|clientes)/.test(h)).slice(0, 4).join(' ')));

  console.log('======== 4. as linhas de mídia ========');
  const linhas = async (rotulo) => {
    await esperar(1200);
    const r = await page.evaluate(() => {
      const ls = [...document.querySelectorAll('[data-linha-de-midia]')];
      const setas = [...document.querySelectorAll('button')].filter((b) => /Mover para (cima|baixo)/.test(b.getAttribute('aria-label') || '') || /^[↑↓]$/.test((b.textContent || '').trim()));
      return { linhas: ls.length, setasNaLinha: setas.length, comMenu: ls.filter((l) => l.querySelector('[data-mais-acoes-da-midia]')).length, texto: document.body.innerText || '' };
    });
    afirmar(r.setasNaLinha === 0, `${rotulo}: nenhuma seta na linha`, r.setasNaLinha);
    return r;
  };
  if (ids.tela) {
    await page.goto(`${UNI}/telas/${ids.tela}`, { waitUntil: 'networkidle0', timeout: 60000 });
    const r = await linhas('tela');
    afirmar(/\bMídias\b/.test(r.texto) && !/\bConteúdos\b/.test(r.texto), 'a aba chama-se Mídias', '');
    afirmar(/Adicionar mídia/.test(r.texto) || r.linhas === 0, 'o botão diz "Adicionar mídia"');
  }
  if (ids.playlist) {
    await page.goto(`${UNI}/playlists/${ids.playlist}`, { waitUntil: 'networkidle0', timeout: 60000 });
    const r = await linhas('playlist');
    if (r.linhas > 0) afirmar(r.comMenu === r.linhas, 'cada item tem o "⋯" com o resto', `${r.comMenu} de ${r.linhas}`);
    if (r.linhas > 0) {
      await page.click('[data-linha-de-midia] [data-mais-acoes-da-midia]');
      const itens = await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map((b) => (b.textContent || '').trim()));
      afirmar(itens.includes('Substituir mídia') && itens.includes('Duplicar') && itens.includes('Mover para cima') && itens.includes('Mover para baixo'), 'o "⋯" tem substituir, duplicar, subir e descer', itens.join(' | '));
      await page.keyboard.press('Escape');
    }
  }

  console.log('======== 5. a prévia pelo link assinado ========');
  if (ids.midia) {
    const r = await page.evaluate(async (t, id) => {
      const h = { Authorization: 'Bearer ' + t };
      const link = await fetch(`/api/content/${id}/link`, { headers: h });
      if (!link.ok) return { erroLink: link.status };
      const { url } = await link.json();
      const semSessao = await fetch(url, { headers: { Range: 'bytes=0-99' } });
      const adulterado = await fetch(url.replace(/t=[^&]*/, 't=' + encodeURIComponent('9999999999.abc')));
      const vencido = await fetch(url.replace(/t=(\d+)/, 't=1'));
      const semNada = await fetch(`/api/content/${id}/file`);
      return { url, semSessao: semSessao.status, tipo: semSessao.headers.get('content-type'), adulterado: adulterado.status, vencido: vencido.status, semNada: semNada.status };
    }, TOKEN, ids.midia);
    if (r.erroLink) falha('a API emite o link assinado', 'HTTP ' + r.erroLink);
    else {
      afirmar(/\/api\/content\/.+\/file\?t=/.test(r.url), 'o link aponta para o arquivo com a assinatura', r.url.slice(0, 70));
      afirmar(r.semSessao === 200 || r.semSessao === 206, 'o link abre SEM sessão, por trechos', `HTTP ${r.semSessao} ${r.tipo}`);
      /* Uma mídia que já está numa playlist abre sem sessão pela regra antiga (o player baixa
         assim). O que a assinatura NÃO pode fazer é abrir ALÉM dela: adulterada e vencida valem
         exatamente o que vale um pedido sem assinatura nenhuma. */
      afirmar(r.adulterado === r.semNada, 'assinatura adulterada não vale mais que nenhuma', `adulterada=${r.adulterado} sem-nada=${r.semNada}`);
      afirmar(r.vencido === r.semNada, 'link vencido não vale mais que nenhum', `vencido=${r.vencido} sem-nada=${r.semNada}`);
      if (r.semNada === 403) ok('esta mídia está fora de playlist: só a assinatura válida abriu');
    }
  } else falha('há uma mídia com arquivo para provar a prévia');

  afirmar(erros.length === 0, 'sem erro de JavaScript', erros.join(' ; '));
  await navegador.close();
  console.log('');
  if (falhas) { console.log(`${falhas} FALHA(S) nas correções de 06/09`); process.exit(1); }
  console.log('TUDO OK: as correções de 06/09 estão no ar');
})().catch((e) => { console.error('A PROVA QUEBROU: ' + e.message); process.exit(2); });
