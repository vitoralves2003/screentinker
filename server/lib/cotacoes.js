'use strict';

/*
 * COTAÇÕES DO AGRO — uma fonte só: o serviço `cotacoes` (agrobr), com cache da frota e último-bom.
 *
 * Decisão do Vitor (11/09): o agrobr é a ÚNICA fonte do widget, com o crédito "CEPEA/ESALQ" na
 * tela. O agrobr é uma biblioteca Python (MIT) que lê os indicadores diários do CEPEA direto do
 * site, com tentativas, disjuntor e fallback — e roda num contêiner ao lado da API
 * (apps/cotacoes/servidor.py), que devolve JSON pronto. Este módulo não raspa mais nada: pergunta
 * lá, traduz para o que o widget consome, e guarda o último-bom para a frota inteira. Nunca fica
 * vazio: se o serviço cair, mantém o que já tinha; se nada veio na primeiríssima vez, devolve null
 * e o widget cai no manual/amostra.
 *
 * Antes daqui (09/09 → 11/09) o agregador juntava AgroDoc (boi/soja/milho, SEM variação) e uma
 * raspagem do cotacaodocafe.com (café, com variação). Saíram os dois.
 */

const TTL_MS = 20 * 60 * 1000;
const TIMEOUT_MS = 40000; // a primeiríssima busca do serviço pode esperar o CEPEA (5 produtos, ~5 s cada)
const URL_BASE = (process.env.COTACOES_URL || 'http://cotacoes:8000').replace(/\/+$/, '');

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

// "2026-09-11" -> "11/09". O dia do indicador, não o relógio de agora.
function diaCurto(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? m[3] + '/' + m[2] : null;
}

/* Hoje em Brasília, no mesmo formato. O servidor vive em UTC; sem o fuso, das 21h à meia-noite a
   tela mostraria o dia seguinte. */
function hojeCurto(agora) {
  const d = new Date((agora || new Date()).getTime() - 3 * 60 * 60 * 1000);
  return String(d.getUTCDate()).padStart(2, '0') + '/' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

/*
 * O CRÉDITO TRAZ O DIA DE HOJE, E O DIA DA COTAÇÃO QUANDO SÃO DIFERENTES (14/09, pedido do Vitor).
 *
 * O CEPEA publica o indicador do dia no fim da tarde e não publica em fim de semana nem feriado —
 * numa segunda-feira, o mais recente que existe é o de sexta. A tela mostrava só o dia do
 * indicador, e três dias parados faziam o painel parecer abandonado.
 *
 * Só a data de hoje também não serve: ela faria o preço de sexta ser lido como preço de hoje, e
 * cotação é número que alguém contesta. Então as duas aparecem, e o rótulo diz qual é qual.
 */
function creditoDaFonte(fonte, diaDoIndicador, agora) {
  const base = fonte || 'CEPEA/ESALQ';
  const hoje = hojeCurto(agora);
  if (!diaDoIndicador) return base + ' · ' + hoje;
  if (diaDoIndicador === hoje) return base + ' · ' + hoje;
  return base + ' · ' + hoje + ' · cotação de ' + diaDoIndicador;
}

/* Tradução pura do JSON do serviço para o que o widget desenha — exportada para a prova. */
function mapear(json, agora) {
  const itens = json && Array.isArray(json.cotacoes) ? json.cotacoes : [];
  const cotacoes = [];
  for (const it of itens) {
    const valor = fmt(it.valor);
    if (!valor || !it.nome) continue;
    const linha = { nome: String(it.nome), unidade: String(it.unidade || ''), valor };
    const v = Number(it.variacao);
    if (it.variacao !== null && it.variacao !== undefined && isFinite(v)) linha.variacao = v;
    cotacoes.push(linha);
  }
  if (!cotacoes.length) return null;
  const dia = diaCurto(json.atualizado);
  return {
    cotacoes,
    atualizado: json.atualizado || new Date().toISOString(),
    // O dia do indicador guardado à parte: o crédito é remontado a cada entrega (ver getCotacoes),
    // senão a virada da meia-noite ficaria com a data de ontem até o cache vencer.
    dia,
    fonteBase: json.fonte || 'CEPEA/ESALQ',
    // O crédito que vai para a tela: o dia de hoje, e o dia do indicador quando for outro.
    fonte: creditoDaFonte(json.fonte, dia, agora),
  };
}

async function pegar() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(URL_BASE + '/cotacoes', { signal: ctl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/* O crédito é do MOMENTO DA ENTREGA, não da busca: a data de hoje vira à meia-noite, e o cache
   dura 20 minutos. Sem isto, a primeira faixa do dia mostraria a data de ontem. */
function comCreditoDeAgora(c) {
  return c ? { ...c, fonte: creditoDaFonte(c.fonteBase, c.dia) } : c;
}

async function getCotacoes() {
  const agora = Date.now();
  if (cache && agora - cacheEm < TTL_MS) return comCreditoDeAgora(cache);
  if (!buscando) {
    buscando = (async () => {
      try {
        const novo = mapear(await pegar());
        if (novo) { cache = novo; cacheEm = Date.now(); } // só troca por algo BOM; erro mantém o último-bom
      } catch (e) {
        // silencioso: uma falha de rede não deve limpar o que já temos
      } finally {
        buscando = null;
      }
    })();
  }
  await buscando;
  return cache ? comCreditoDeAgora(cache) : null; // null só na primeiríssima falha — o widget cai no manual/amostra
}

module.exports = { getCotacoes, mapear, fmt, creditoDaFonte };
