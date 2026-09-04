/*
 * LAYOUTS EM REACT ABRE, DESENHA E DEIXA ARRASTAR — num navegador com sessão.
 *
 * A trava do jest prende TEXTO e NÚMERO. O que só um navegador responde: a lista passa o portão
 * do AppShell e desenha os modelos com as zonas de cada um; "Usar modelo" leva ao editor da CÓPIA
 * (e não do modelo); o canvas do editor copia a FORMA do layout — um layout de retrato desenha um
 * canvas em pé, que era o defeito que a versão antiga tinha e a nova herdou corrigido; arrastar
 * uma zona MOVE a zona e a trava dos limites segura no canto; e Salvar responde.
 *
 * COM o basePath (/gestao): sem ele a casa velha responde qualquer caminho com o casco dela.
 *
 * Roda de /opt/novo-operacao/scripts/provas:
 *   docker run --rm --network host --user root -v "$PWD:/p" -e TOKEN=... \
 *     -e NODE_PATH=/usr/src/app/node_modules --entrypoint node zenika/alpine-chrome:with-puppeteer \
 *     /p/layouts_nativo.js
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'https://beta.loopplayer.com.br/gestao';
const TOKEN = process.env.TOKEN || '';
const SAIDA = process.env.SAIDA || '/p';

(async () => {
  if (!TOKEN) { console.log('SEM SESSAO: passe TOKEN=...'); process.exit(1); }

  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const pagina = await navegador.newPage();
  await pagina.setViewport({ width: 1280, height: 900 });

  const erros = [];
  const respostas5xx = [];
  pagina.on('pageerror', (e) => erros.push('pageerror: ' + e.message.slice(0, 140)));
  pagina.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (m.text().includes('Failed to load resource')) return;
    erros.push('console.error: ' + m.text().slice(0, 140));
  });
  pagina.on('response', (r) => { if (r.status() >= 500) respostas5xx.push(r.status() + ' ' + new URL(r.url()).pathname); });

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
    await pagina.waitForFunction(() => !!document.querySelector('h1, h3'), { timeout: 20000, polling: 300 }).catch(() => {});
    await esperar(900);
  };

  /* ── a lista ── */
  console.log('\n── /layouts ──');
  await abrir('/layouts');
  let m = await pagina.evaluate(() => {
    const texto = document.body.innerText || '';
    const cartoes = [...document.querySelectorAll('[data-layout-id]')];
    return {
      h1s: [...document.querySelectorAll('h1')].map((h) => h.textContent.trim()),
      texto,
      cartoes: cartoes.length,
      /* Um cartão desenha o retrato do layout: as zonas nos seus percentuais. */
      comZonaDesenhada: cartoes.filter((c) => c.querySelectorAll('div[style*="%"]').length > 0).length,
      /* Um modelo de retrato tem o cartão MAIS ALTO que largo — a forma vem do próprio layout. */
      formas: cartoes.slice(0, 20).map((c) => {
        const face = c.firstElementChild;
        const r = face ? face.getBoundingClientRect() : { width: 0, height: 0 };
        return { nome: (c.innerText || '').split('\n')[0], deitado: r.width >= r.height };
      }),
      casco: !!(document.querySelector('#toastContainer') || document.querySelector('#banners')),
      cssVelho: [...document.querySelectorAll('style')].some((s) => /\.settings-section|--console-bg|\.list-table \{/.test(s.textContent || '')),
    };
  });
  conferir('um h1 só, e é "Layouts"', m.h1s.length === 1 && m.h1s[0] === 'Layouts', JSON.stringify(m.h1s));
  conferir('as duas seções: Modelos e Meus layouts', /modelos/i.test(m.texto) && /meus layouts/i.test(m.texto));
  conferir('o botão "Novo layout" existe', /Novo layout/i.test(m.texto));
  conferir('os modelos aparecem', m.cartoes > 0, m.cartoes + ' cartão(ões)');
  conferir('cada cartão desenha as zonas do layout', m.comZonaDesenhada === m.cartoes, m.comZonaDesenhada + ' de ' + m.cartoes);
  conferir('"Usar modelo" aparece nos modelos', /Usar modelo/.test(m.texto));
  conferir('a contagem de zonas está escrita', /\d+ zonas|1 zona/.test(m.texto));
  {
    /* A forma vem do layout: os "Retrato — ..." têm de vir EM PÉ, e os de paisagem deitados. */
    const retratos = m.formas.filter((f) => /retrato/i.test(f.nome));
    const paisagens = m.formas.filter((f) => !/retrato/i.test(f.nome));
    conferir('os modelos de retrato desenham em pé', retratos.length > 0 && retratos.every((f) => !f.deitado),
      retratos.length + ' retrato(s), em pé: ' + retratos.filter((f) => !f.deitado).length);
    conferir('os de paisagem desenham deitados', paisagens.length > 0 && paisagens.every((f) => f.deitado),
      paisagens.length + ' paisagem(ns)');
  }
  conferir('sem CascoOperacao', !m.casco);
  conferir('sem o CSS da casa velha', !m.cssVelho);
  await pagina.screenshot({ path: SAIDA + '/layouts-nativo.png', fullPage: true });

  /* ── o editor, pela cópia de um modelo de RETRATO ── */
  console.log('\n── "Usar modelo" num modelo de retrato ──');
  const alvo = await pagina.evaluate(() => {
    const c = [...document.querySelectorAll('[data-layout-id]')].find((x) => /retrato/i.test(x.innerText || ''));
    if (!c) return null;
    const b = [...c.querySelectorAll('button')].find((x) => /Usar modelo/.test(x.textContent || ''));
    if (!b) return null;
    b.click();
    return { nome: (c.innerText || '').split('\n')[0], id: c.getAttribute('data-layout-id') };
  });
  conferir('achou um modelo de retrato para duplicar', !!alvo, alvo ? alvo.nome : '');

  if (alvo) {
    await pagina.waitForFunction(() => /\/layouts\/[^/]+$/.test(location.pathname) && !/\/layouts$/.test(location.pathname),
      { timeout: 20000, polling: 300 }).catch(() => {});
    await esperar(1200);
    const url = pagina.url();
    conferir('foi para o editor de OUTRO layout (a cópia, não o modelo)',
      /\/layouts\/[^/]+$/.test(url) && !url.endsWith('/layouts/' + alvo.id), url.replace(/^https?:\/\/[^/]+/, ''));

    const e = await pagina.evaluate(() => {
      const canvas = document.querySelector('[data-zona]')?.parentElement || null;
      const r = canvas ? canvas.getBoundingClientRect() : null;
      return {
        texto: document.body.innerText || '',
        nomeNoCampo: (document.querySelector('input[aria-label^="Nome do layout"]') || {}).value ?? null,
        zonas: document.querySelectorAll('[data-zona]').length,
        canvasEmPe: r ? r.height > r.width : null,
        canvas: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,
      };
    });
    conferir('o campo do nome do layout existe e traz a cópia', typeof e.nomeNoCampo === 'string' && e.nomeNoCampo.length > 0, JSON.stringify(e.nomeNoCampo));
    conferir('"Adicionar zona", "Salvar" e "Voltar para layouts" estão lá',
      /Adicionar zona/.test(e.texto) && /Salvar/.test(e.texto) && /Voltar para layouts/.test(e.texto));
    conferir('as zonas do layout aparecem no canvas', e.zonas > 0, e.zonas + ' zona(s)');
    /* O defeito nomeado no código: canvas travado em 16:9 fazia desenhar retrato num palco deitado. */
    conferir('o canvas copia a FORMA do layout — retrato desenha em pé', e.canvasEmPe === true, JSON.stringify(e.canvas));

    /* ── arrastar ── */
    console.log('\n── arrastar uma zona ──');
    const antes = await pagina.evaluate(() => {
      const z = document.querySelector('[data-zona]');
      const r = z.getBoundingClientRect();
      return { x: r.x, y: r.y, cx: r.x + r.width / 2, cy: r.y + r.height / 2, w: r.width, h: r.height };
    });
    await pagina.mouse.move(antes.cx, antes.cy);
    await pagina.mouse.down();
    await pagina.mouse.move(antes.cx + 60, antes.cy + 40, { steps: 12 });
    await pagina.mouse.up();
    await esperar(400);
    const depois = await pagina.evaluate(() => {
      const z = document.querySelector('[data-zona]');
      const r = z.getBoundingClientRect();
      return { x: r.x, y: r.y, painel: document.body.innerText.includes('Propriedades') };
    });
    conferir('a zona se moveu com o mouse', Math.abs(depois.x - antes.x) > 5 || Math.abs(depois.y - antes.y) > 5,
      'dx=' + Math.round(depois.x - antes.x) + ' dy=' + Math.round(depois.y - antes.y));
    conferir('arrastar seleciona a zona e abre Propriedades', depois.painel);

    /* A trava dos limites: puxar para muito longe encosta na borda e PARA — nunca sai do canvas. */
    const meio = await pagina.evaluate(() => {
      const r = document.querySelector('[data-zona]').getBoundingClientRect();
      return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    });
    await pagina.mouse.move(meio.cx, meio.cy);
    await pagina.mouse.down();
    await pagina.mouse.move(meio.cx + 4000, meio.cy + 4000, { steps: 10 });
    await pagina.mouse.up();
    await esperar(400);
    const preso = await pagina.evaluate(() => {
      const z = document.querySelector('[data-zona]');
      const zr = z.getBoundingClientRect();
      const cr = z.parentElement.getBoundingClientRect();
      return { dentro: zr.right <= cr.right + 2 && zr.bottom <= cr.bottom + 2 };
    });
    conferir('a zona não escapa do canvas por mais que se puxe', preso.dentro);

    await pagina.screenshot({ path: SAIDA + '/layout-editor-nativo.png', fullPage: true });

    /* ── salvar ── */
    console.log('\n── salvar ──');
    const salvou = await pagina.evaluate(async () => {
      const b = [...document.querySelectorAll('button')].find((x) => /^Salvar/.test((x.textContent || '').trim()));
      if (!b) return 'sem botão Salvar';
      b.click();
      return 'clicado';
    });
    await esperar(2500);
    const aviso = await pagina.evaluate(() => document.body.innerText || '');
    conferir('Salvar responde "Layout salvo"', /Layout salvo/.test(aviso), salvou);

    /* Limpa a cópia que esta prova criou — senão cada rodada deixa um layout novo na conta. */
    const idDaCopia = pagina.url().split('/layouts/')[1];
    if (idDaCopia) {
      const apagou = await pagina.evaluate(async (id) => {
        const r = await fetch('/api/layouts/' + id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
        return r.status;
      }, idDaCopia);
      conferir('a cópia da prova foi apagada', apagou === 200 || apagou === 204, 'HTTP ' + apagou);
    }
  }

  console.log('\n── erros ──');
  conferir('sem erro de JavaScript', erros.length === 0, erros.join(' | '));
  conferir('sem 5xx', respostas5xx.length === 0, respostas5xx.join(' | '));

  await navegador.close();
  console.log('');
  if (falhas) { console.log(falhas + ' FALHA(S) em Layouts'); process.exit(1); }
  console.log('LAYOUTS EM REACT ESTA DE PE');
})().catch((e) => { console.error('A PROVA QUEBROU: ' + e.message); process.exit(2); });
