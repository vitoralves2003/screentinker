'use strict';

/*
 * AS FONTES DE UMA NOTÍCIA — editorias e parceiros na MESMA lista (12/09, passo E do plano).
 *
 * Decisão do Vitor: "Notícias e Notícias do Parceiro deveriam ser apenas uma, e ao escolher
 * notícias fica disponível escolher a fonte do parceiro como qualquer outra fonte que o sistema já
 * tenha, como geral, informativa, política". E, sobre o rodízio: MISTURA LIVRE — o assinante marca
 * o que quiser e o widget reveza entre tudo, em ordem de publicação, sem privilégio para ninguém.
 *
 * Fui conferir antes de unificar: os dois já desenhavam o MESMO card — foto ocupando a tela, título
 * embaixo. O parceiro só acrescenta a logo da fonte e o QR da matéria. A diferença nunca foi de
 * formato, e sim de origem. Por isso a unificação mora aqui, na origem, e não no desenho.
 *
 * O FORMATO. A config do widget passa a ter uma lista só, `fontes`, com chaves marcadas:
 *
 *     { fontes: ['g1:agro', 'parceiro:766bda82-...'] }
 *
 * `lerFontes` entende também os DOIS formatos antigos e os converte na leitura — é a conversão
 * automática que o Vitor escolheu, e ela acontece em todo lugar que lê a config, sem ninguém
 * precisar reabrir widget nenhum:
 *
 *     { feed_urls: [...] }  ou  { feed_url: '...' }   o widget de Notícias de antes
 *     { fonte_id: '...' }                             o widget de Notícias do Parceiro
 */

const G1 = 'https://g1.globo.com/rss/g1/';

/* As editorias que o produto oferece. A CHAVE é o que fica gravado; a URL é detalhe de quem busca,
   e trocá-la um dia não deve obrigar a reescrever a config de todo mundo. */
const EDITORIAS = [
  { chave: 'geral', rotulo: 'Geral', url: G1 },
  { chave: 'esportes', rotulo: 'Esportes', url: 'https://ge.globo.com/rss/ge/' },
  { chave: 'economia', rotulo: 'Economia', url: 'https://g1.globo.com/rss/g1/economia/' },
  { chave: 'politica', rotulo: 'Política', url: 'https://g1.globo.com/rss/g1/politica/' },
  { chave: 'mundo', rotulo: 'Mundo', url: 'https://g1.globo.com/rss/g1/mundo/' },
  { chave: 'tecnologia', rotulo: 'Tecnologia', url: 'https://g1.globo.com/rss/g1/tecnologia/' },
  { chave: 'saude', rotulo: 'Ciência e saúde', url: 'https://g1.globo.com/rss/g1/ciencia-e-saude/' },
  { chave: 'entretenimento', rotulo: 'Entretenimento', url: 'https://g1.globo.com/rss/g1/pop-arte/' },
  { chave: 'carros', rotulo: 'Carros', url: 'https://g1.globo.com/rss/g1/carros/' },
  { chave: 'agro', rotulo: 'Agronegócios', url: 'https://g1.globo.com/rss/g1/economia/agronegocios/' },
];

const PREFIXO_EDITORIA = 'g1:';
const PREFIXO_PARCEIRO = 'parceiro:';

function porChave(chave) {
  return EDITORIAS.find((e) => e.chave === chave) || null;
}

/* A URL gravada num widget antigo vira a chave de hoje. Sem barra final e sem esquema, porque uma
   config velha pode ter http:// onde hoje é https://. */
function chaveDaUrl(url) {
  const limpa = String(url || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!limpa) return null;
  const achada = EDITORIAS.find((e) => e.url.replace(/^https?:\/\//, '').replace(/\/+$/, '') === limpa);
  return achada ? achada.chave : null;
}

/**
 * O que este widget deve buscar, venha a config do formato novo ou de qualquer um dos dois antigos.
 * Devolve as chaves normalizadas (para a tela remarcar as fichas certas), as URLs das editorias
 * (para o leitor de RSS) e os ids de parceiro (para o Postgres).
 */
function lerFontes(config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const chaves = [];

  const guardar = (c) => { if (c && !chaves.includes(c)) chaves.push(c); };

  if (Array.isArray(cfg.fontes)) {
    for (const f of cfg.fontes) {
      const s = String(f || '').trim();
      if (!s) continue;
      if (s.startsWith(PREFIXO_PARCEIRO)) { guardar(s); continue; }
      if (s.startsWith(PREFIXO_EDITORIA)) { guardar(porChave(s.slice(PREFIXO_EDITORIA.length)) ? s : null); continue; }
      /* Uma chave solta ("agro") também vale: é o que o front manda antes de prefixar. */
      if (porChave(s)) guardar(PREFIXO_EDITORIA + s);
    }
  }

  /* CONVERSÃO DO FORMATO ANTIGO — só quando o novo não disse nada, para uma config já convertida
     não ser reescrita pelo que sobrou da antiga. */
  if (!chaves.length) {
    const urls = Array.isArray(cfg.feed_urls) && cfg.feed_urls.length ? cfg.feed_urls : (cfg.feed_url ? [cfg.feed_url] : []);
    for (const u of urls) {
      const c = chaveDaUrl(u);
      /* URL que não é de nenhuma editoria conhecida vira "geral": melhor a tela mostrar notícia do
         que ficar vazia por causa de um endereço que alguém editou à mão. */
      guardar(PREFIXO_EDITORIA + (c || 'geral'));
    }
    if (typeof cfg.fonte_id === 'string' && cfg.fonte_id.trim()) {
      guardar(PREFIXO_PARCEIRO + cfg.fonte_id.trim());
    }
    /* Widget de parceiro SEM fonte escolhida mostrava amostra, e continua mostrando: nenhuma chave,
       e quem chama cai no mesmo fallback de sempre. */
  }

  const editorias = [];
  const parceiros = [];
  for (const c of chaves) {
    if (c.startsWith(PREFIXO_PARCEIRO)) parceiros.push(c.slice(PREFIXO_PARCEIRO.length));
    else {
      const e = porChave(c.slice(PREFIXO_EDITORIA.length));
      if (e) editorias.push(e.url);
    }
  }
  return { chaves, editorias, parceiros };
}

/** O que se GRAVA a partir do que a tela marcou. Sempre no formato novo, sempre prefixado. */
function escreverFontes(chaves) {
  const lista = Array.isArray(chaves) ? chaves : [];
  const saida = [];
  for (const bruta of lista) {
    const s = String(bruta || '').trim();
    if (!s) continue;
    if (s.startsWith(PREFIXO_PARCEIRO) || s.startsWith(PREFIXO_EDITORIA)) { if (!saida.includes(s)) saida.push(s); continue; }
    if (porChave(s) && !saida.includes(PREFIXO_EDITORIA + s)) saida.push(PREFIXO_EDITORIA + s);
  }
  /* Nenhuma marcada: cai em Geral, que é o que o widget antigo fazia quando a lista vinha vazia. */
  return saida.length ? saida : [PREFIXO_EDITORIA + 'geral'];
}

/**
 * A MISTURA — a decisão do Vitor, "mistura livre": tudo num rodízio só, do mais novo para o mais
 * velho. Item sem data vai para o fim, na ordem em que chegou, em vez de fingir ser de hoje.
 */
function misturar(listas) {
  const todos = [];
  for (const lista of listas || []) {
    for (const item of lista || []) todos.push(item);
  }
  return todos
    .map((item, ordem) => ({ item, ordem, quando: Date.parse(item && item.date) }))
    .sort((a, b) => {
      const temA = !isNaN(a.quando), temB = !isNaN(b.quando);
      if (temA && temB) return b.quando - a.quando;
      if (temA) return -1;
      if (temB) return 1;
      return a.ordem - b.ordem;
    })
    .map((x) => x.item);
}

module.exports = {
  EDITORIAS, PREFIXO_EDITORIA, PREFIXO_PARCEIRO,
  lerFontes, escreverFontes, misturar, chaveDaUrl, porChave,
};
