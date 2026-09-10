'use strict';

/*
 * COTAÇÕES DO AGRO — agregador MULTI-FONTE (grátis), com cache da frota e quedas de segurança.
 *
 * Junta o que uma fonte tem e a outra não: AgroDoc (JSON: boi, soja, milho) + cotacaodocafe.com
 * (café arábica e conilon, com variação). Mescla por PRIORIDADE — para cada produto, a primeira
 * fonte que respondeu vence — o que dá cobertura E redundância (é só cadastrar mais de uma fonte
 * por produto). Nunca fica vazio: se uma cai, mantém o ÚLTIMO-BOM; se nada veio na primeiríssima
 * vez, devolve null e o widget cai no manual/amostra. Fonte de fundo dos indicadores: CEPEA/ESALQ.
 *
 * Só LEITURA de fontes públicas, uma vez a cada TTL e compartilhada por toda a frota (o cache é do
 * processo do servidor, não do player) — nada de uma tela martelar as fontes.
 */

const TTL_MS = 20 * 60 * 1000; // no máximo 1 busca a cada 20min (AgroDoc pede moderação; o indicador muda no dia)
const TIMEOUT_MS = 12000;

let cache = null; // { cotacoes:[{nome,unidade,valor,variacao?}], atualizado, fonte }
let cacheEm = 0;
let buscando = null; // promise em voo, para duas chamadas não dispararem duas buscas

// pt-BR com milhar e 2 casas: 1647.29 -> "1.647,29"; 162 -> "162,00".
// À mão de propósito: toLocaleString('pt-BR') depende de ICU completo, que nem todo Node de
// container tem — sem ele o número sairia "1,647.29". Assim é sempre pt-BR.
function fmt(n) {
  const v = Number(n);
  if (!isFinite(v)) return null;
  const partes = v.toFixed(2).split('.');
  const inteiro = partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return inteiro + ',' + partes[1];
}

async function pegar(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LoopPlayer/1.0)' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// ── Fonte 1: AgroDoc (JSON) — boi, soja, milho. Sem variação. ────────────────────────────────
async function agrodoc() {
  const d = JSON.parse(await pegar('https://agrodocai.com.br/api/v1/cotacao'));
  const out = {};
  const boi = fmt(d.boi_gordo_cepea_sp);
  const soja = fmt(d.soja);
  const milho = fmt(d.milho);
  if (boi) out.boi = { nome: 'Boi gordo', unidade: 'R$/@ (arroba)', valor: boi };
  if (soja) out.soja = { nome: 'Soja', unidade: 'R$/saca 60kg', valor: soja };
  if (milho) out.milho = { nome: 'Milho', unidade: 'R$/saca 60kg', valor: milho };
  return out;
}

// ── Fonte 2: cotacaodocafe.com — café arábica e conilon, COM variação. ───────────────────────
// A linha do "indicador nacional" traz `csel-pr">R$ x</span><span class="var up|down">▲|▼ y%`.
function parseCafe(html, tipo) {
  const re = new RegExp(
    'data-n="' + tipo + '[^"]*indicador nacional[^>]*>[\\s\\S]*?csel-pr">R\\$\\s*([\\d.,]+)<\\/span>' +
    '<span class="var (up|down)">[^0-9]*([\\d,]+)%',
  );
  const m = re.exec(html);
  if (!m) return null;
  const variacao = (m[2] === 'down' ? -1 : 1) * parseFloat(m[3].replace(',', '.'));
  return { valor: m[1].trim(), variacao: isFinite(variacao) ? variacao : undefined };
}
async function cafe() {
  const html = await pegar('https://cotacaodocafe.com/');
  const out = {};
  const ar = parseCafe(html, 'arábica');
  const co = parseCafe(html, 'conilon');
  if (ar) out.cafe_arabica = { nome: 'Café arábica', unidade: 'R$/saca 60kg', valor: ar.valor, variacao: ar.variacao };
  if (co) out.cafe_conilon = { nome: 'Café conilon', unidade: 'R$/saca 60kg', valor: co.valor, variacao: co.variacao };
  return out;
}

// Ordem de exibição na tela. Cadastrar redundância = pôr a mesma chave em mais de uma fonte.
const ORDEM = ['boi', 'soja', 'milho', 'cafe_arabica', 'cafe_conilon'];
const FONTES = [agrodoc, cafe];

async function montar() {
  // Todas em paralelo; cada uma pode falhar sem derrubar as outras.
  const res = await Promise.allSettled(FONTES.map((f) => f()));
  const merged = {};
  for (const r of res) {
    if (r.status === 'fulfilled' && r.value) {
      for (const k of Object.keys(r.value)) if (!merged[k]) merged[k] = r.value[k]; // 1ª fonte vence
    }
  }
  const cotacoes = ORDEM.filter((k) => merged[k]).map((k) => merged[k]);
  if (!cotacoes.length) return null;
  return { cotacoes, atualizado: new Date().toISOString(), fonte: 'CEPEA/ESALQ' };
}

async function getCotacoes() {
  const agora = Date.now();
  if (cache && agora - cacheEm < TTL_MS) return cache;
  if (!buscando) {
    buscando = (async () => {
      try {
        const novo = await montar();
        if (novo) { cache = novo; cacheEm = Date.now(); } // só troca por algo BOM; erro mantém o último-bom
      } catch (e) {
        // silencioso: uma falha de rede não deve limpar o que já temos
      } finally {
        buscando = null;
      }
    })();
  }
  await buscando;
  return cache || null; // null só na primeiríssima falha — o widget cai no manual/amostra
}

module.exports = { getCotacoes };
