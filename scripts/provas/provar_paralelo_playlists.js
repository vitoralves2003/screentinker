/*
 * OS DOIS MOTORES DE PUBLICAR PRODUZEM O MESMO AR — Fase B (02/09).
 *
 * O orquestrador semeia pela casa VELHA: dois PNGs, uma sub-lista com os dois, uma lista
 * pai com um arquivo solto + a sub-lista (modo sequência — o embaralhado é aleatório por
 * construção e compararia dois sorteios, não dois motores). Publica na velha, espelha, e
 * então:
 *
 *   GET /api/playlists            a lista com os cinco números derivados
 *   GET /:id                      a lista aberta (itens detalhados, contagens, layout)
 *   GET /:id/telas                as duas portas do "em quantas telas"
 *   POST publish NA CASA NOVA     e o confronto: published_snapshot e published_draft
 *                                 ANALISADOS e comparados campo a campo com os da velha —
 *                                 o snapshot É o que toca numa parede; igualdade aqui é o
 *                                 motor inteiro provado, filtros de vivo, suspensão da
 *                                 Etapa 6 e achatamento incluídos
 *
 *   TOKEN=... PARENT_ID=... UNI=... node provar_paralelo_playlists.js
 */
const UNI = process.env.UNI || 'http://127.0.0.1:3100';
const TOKEN = process.env.TOKEN || '';
const PARENT_ID = process.env.PARENT_ID || '';

let passou = 0;
let falhou = 0;
function conferir(nome, ok, detalhe) {
  if (ok) { passou++; console.log('  ok    ' + nome); }
  else { falhou++; console.log('  FALHA ' + nome + (detalhe ? '  -> ' + detalhe : '')); }
}

async function pegar(caminho, opts = {}) {
  const r = await fetch(UNI + caminho, {
    method: opts.metodo || 'GET',
    headers: { Authorization: 'Bearer ' + TOKEN },
  });
  const texto = await r.text();
  let corpo = null;
  try { corpo = JSON.parse(texto); } catch { corpo = texto; }
  return { status: r.status, corpo, texto };
}

function canonico(v) {
  if (Array.isArray(v)) return v.map(canonico);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canonico(v[k]);
    return o;
  }
  return v;
}

function primeiraDiferenca(a, b, caminho) {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    return caminho + ': velho=' + JSON.stringify(a) + ' novo=' + JSON.stringify(b);
  }
  const chaves = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of chaves) {
    const d = primeiraDiferenca(a[k], b[k], caminho + '.' + k);
    if (d) return d;
  }
  return null;
}

async function comparar(nome, caminho, ignorar = []) {
  const velho = await pegar(caminho);
  const novo = await pegar('/gestao-api' + caminho);
  if (velho.status !== novo.status) {
    conferir(nome, false, 'status: velho=' + velho.status + ' novo=' + novo.status
      + ' | novo corpo: ' + String(novo.texto).slice(0, 140));
    return;
  }
  const limpar = (c) => {
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      c = { ...c };
      for (const k of ignorar) delete c[k];
    }
    return c;
  };
  const d = primeiraDiferenca(canonico(limpar(velho.corpo)), canonico(limpar(novo.corpo)), '$');
  conferir(nome + ' (status ' + velho.status + ')', !d, d);
}

(async () => {
  if (!TOKEN || !PARENT_ID) { console.log('SEM SESSAO OU SEM PARENT_ID'); process.exit(1); }

  await comparar('a lista de listas', '/api/playlists');
  await comparar('a lista aberta', '/api/playlists/' + PARENT_ID);
  await comparar('as telas onde toca', '/api/playlists/' + PARENT_ID + '/telas');

  /* O confronto dos motores. */
  const velhoAntes = await pegar('/api/playlists/' + PARENT_ID);
  const publicou = await pegar('/gestao-api/api/playlists/' + PARENT_ID + '/publish', { metodo: 'POST' });
  conferir('a casa nova publica', publicou.status === 200 || publicou.status === 201,
    'status ' + publicou.status + ' corpo ' + String(publicou.texto).slice(0, 140));

  const novoDepois = await pegar('/gestao-api/api/playlists/' + PARENT_ID);

  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const snapVelho = parse(velhoAntes.corpo && velhoAntes.corpo.published_snapshot);
  const snapNovo = parse(novoDepois.corpo && novoDepois.corpo.published_snapshot);
  const dSnap = primeiraDiferenca(canonico(snapVelho), canonico(snapNovo), '$');
  conferir('o SNAPSHOT publicado, motor contra motor'
    + (Array.isArray(snapVelho) ? ' (' + snapVelho.length + ' itens no ar)' : ''),
    Array.isArray(snapVelho) && Array.isArray(snapNovo) && !dSnap, dSnap
      || (!Array.isArray(snapVelho) ? 'snapshot velho ausente' : 'snapshot novo ausente'));

  const draftVelho = parse(velhoAntes.corpo && velhoAntes.corpo.published_draft);
  const draftNovo = parse(novoDepois.corpo && novoDepois.corpo.published_draft);
  const dDraft = primeiraDiferenca(canonico(draftVelho), canonico(draftNovo), '$');
  conferir('o rascunho publicado (o que o descartar reconstrói)',
    Array.isArray(draftVelho) && Array.isArray(draftNovo) && !dDraft, dDraft);

  console.log('\n' + passou + ' passaram, ' + falhou + ' falharam');
  process.exit(falhou ? 1 : 0);
})();
