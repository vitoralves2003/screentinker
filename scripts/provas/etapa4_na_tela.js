/*
 * ETAPA 4, NUM NAVEGADOR: a pagina de Playlists esconde as listas automaticas de tela.
 *
 * A regua vem da API, nao de um numero decorado: a prova pede /api/playlists (que devolve
 * TODAS, com is_auto_generated), calcula quantas nao sao automaticas, e exige que a pagina
 * mostre exatamente essas -- nem uma automatica a mais, nem a do contrato a menos (o Vitor
 * decidiu que a do contrato fica).
 *
 * Sem travessao nem traco de caixa: o arquivo viaja por cat|ssh.
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'https://beta.loopplayer.com.br/gestao';
const BASE = process.env.BASE || 'https://beta.loopplayer.com.br';
const TOKEN = process.env.TOKEN || '';

(async () => {
  if (!TOKEN) { console.log('SEM SESSAO: passe TOKEN=...'); process.exit(1); }

  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const pagina = await navegador.newPage();
  await pagina.setViewport({ width: 1366, height: 900 });
  await pagina.evaluateOnNewDocument((tk) => {
    localStorage.setItem('token', tk);
    localStorage.setItem('loop_os_token', tk);
  }, TOKEN);

  let falhas = 0;
  const conferir = (o_que, condicao, detalhe) => {
    console.log('  ' + (condicao ? 'ok    ' : 'FALHA ') + o_que + (detalhe ? '   ' + detalhe : ''));
    if (!condicao) falhas++;
  };
  const esperar = (fn, ms) => pagina.waitForFunction(fn, { timeout: ms || 25000, polling: 300 }).catch(() => null);

  await pagina.goto(UNI + '/playlists', { waitUntil: 'networkidle0', timeout: 60000 });
  await esperar(() => document.querySelectorAll('table tbody tr').length > 0 || /Sem playlists/.test(document.body.innerText || ''));

  /* A verdade da API, lida da mesma sessao. */
  const todas = await pagina.evaluate(async (base, tk) => {
    const r = await fetch(base + '/api/playlists', { headers: { Authorization: 'Bearer ' + tk } });
    return r.ok ? r.json() : null;
  }, BASE, TOKEN);
  conferir('a API respondeu a lista completa', Array.isArray(todas), Array.isArray(todas) ? todas.length + ' no total' : 'sem resposta');
  if (!Array.isArray(todas)) { await navegador.close(); process.exit(1); }

  const automaticas = todas.filter((p) => p.is_auto_generated);
  const deVerdade = todas.filter((p) => !p.is_auto_generated);
  const doContrato = deVerdade.filter((p) => p.contrato_id);
  console.log('  na API: ' + automaticas.length + ' automatica(s), ' + deVerdade.length + ' de verdade (' + doContrato.length + ' de contrato)');
  /* A guarda contra medir vazio: sem automaticas no banco, esconder nao mede nada. */
  conferir('ha pelo menos uma lista automatica para esconder', automaticas.length > 0);

  const naTela = await pagina.evaluate(() => [...document.querySelectorAll('table tbody tr')].map((tr) => (tr.querySelector('td:nth-child(2)') || tr).textContent.trim()));
  const rotulo = await pagina.evaluate(() => ((document.body.innerText || '').match(/(\d+) playlists?/) || [])[0] || '');
  console.log('  na tela: ' + naTela.length + ' linha(s), rotulo "' + rotulo + '"');

  conferir('a tela mostra exatamente as de verdade', naTela.length === deVerdade.length, naTela.length + ' na tela vs ' + deVerdade.length + ' na API');
  for (const a of automaticas) {
    conferir('automatica escondida: ' + a.name, !naTela.some((n) => n.includes(a.name)));
  }
  for (const c of doContrato) {
    conferir('a do contrato FICA: ' + c.name, naTela.some((n) => n.includes(c.name)));
  }
  conferir('o rotulo conta o que esta na tela', rotulo.startsWith(String(deVerdade.length) + ' '), rotulo);

  await navegador.close();
  console.log('');
  if (falhas) { console.log(falhas + ' FALHA(S) na Etapa 4'); process.exit(1); }
  console.log('A ETAPA 4 ESTA NA TELA');
})().catch((e) => { console.error('A PROVA QUEBROU: ' + e.message); process.exit(2); });
