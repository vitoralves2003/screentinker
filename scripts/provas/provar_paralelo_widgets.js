/*
 * O CAMINHO PARALELO DE WIDGETS RESPONDE IGUAL À CASA VELHA — Fase B (02/09).
 *
 * O miolo dos widgets é CÓPIA verbatim nas duas casas; esta prova confere que as bordas
 * também batem. Compara com a mesma sessão:
 *
 *   GET /api/widgets                 a lista
 *   GET /api/widgets/:id             um widget aberto
 *   GET /api/widgets/weather/cities  o catálogo de cidades (rota de sessão)
 *   GET /:id/render (+?rev=1)        o HTML BYTE A BYTE, para um tipo SEM semente de rede
 *                                    (clock/text/webpage/social/directory-board — tipos com
 *                                    semente comparariam dois instantes do upstream, não as
 *                                    duas casas), e o Cache-Control do rev — a lição do
 *                                    "immutable" mora nesse cabeçalho
 *   GET /:id/data.json               para directory-board (determinístico da config)
 *   GET /:id/telemetry               null dos dois lados (ninguém reportou)
 *
 *   TOKEN=... UNI=http://127.0.0.1:3100 node provar_paralelo_widgets.js
 */
const UNI = process.env.UNI || 'http://127.0.0.1:3100';
const TOKEN = process.env.TOKEN || '';

let passou = 0;
let falhou = 0;
function conferir(nome, ok, detalhe) {
  if (ok) { passou++; console.log('  ok    ' + nome); }
  else { falhou++; console.log('  FALHA ' + nome + (detalhe ? '  -> ' + detalhe : '')); }
}

async function pegar(caminho, comAuth = true) {
  const r = await fetch(UNI + caminho, {
    headers: comAuth ? { Authorization: 'Bearer ' + TOKEN } : {},
  });
  const texto = await r.text();
  let corpo = null;
  try { corpo = JSON.parse(texto); } catch { corpo = texto; }
  return { status: r.status, corpo, texto, cache: r.headers.get('cache-control') };
}

function canonico(v) {
  if (Array.isArray(v)) {
    const itens = v.map(canonico);
    if (itens.length && itens[0] && typeof itens[0] === 'object' && 'id' in itens[0]) {
      itens.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    }
    return itens;
  }
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
    return caminho + ': velho=' + JSON.stringify(a).slice(0, 80) + ' novo=' + JSON.stringify(b).slice(0, 80);
  }
  const chaves = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of chaves) {
    const d = primeiraDiferenca(a[k], b[k], caminho + '.' + k);
    if (d) return d;
  }
  return null;
}

async function comparar(nome, caminho, comAuth = true) {
  const velho = await pegar(caminho, comAuth);
  const novo = await pegar('/gestao-api' + caminho, comAuth);
  if (velho.status !== novo.status) {
    conferir(nome, false, 'status: velho=' + velho.status + ' novo=' + novo.status
      + ' | novo corpo: ' + String(novo.texto).slice(0, 140));
    return velho;
  }
  const d = primeiraDiferenca(canonico(velho.corpo), canonico(novo.corpo), '$');
  conferir(nome + ' (status ' + velho.status + ')', !d, d);
  return velho;
}

const SEM_SEMENTE = new Set(['clock', 'text', 'webpage', 'social', 'directory-board']);

(async () => {
  if (!TOKEN) { console.log('SEM SESSAO: passe TOKEN=...'); process.exit(1); }

  const lista = await comparar('a lista de widgets', '/api/widgets');
  await comparar('o catálogo de cidades', '/api/widgets/weather/cities');

  const widgets = Array.isArray(lista.corpo) ? lista.corpo : [];
  if (widgets[0]) {
    await comparar('um widget aberto', '/api/widgets/' + widgets[0].id);
  } else {
    conferir('um widget aberto', false, 'a lista veio vazia');
  }

  const deterministico = widgets.find((w) => SEM_SEMENTE.has(w.widget_type));
  if (deterministico) {
    const cam = '/api/widgets/' + deterministico.id + '/render?rev=1';
    const velho = await pegar(cam, false);
    const novo = await pegar('/gestao-api' + cam, false);
    conferir(
      'o render byte a byte (' + deterministico.widget_type + ')',
      velho.status === 200 && novo.status === 200 && velho.texto === novo.texto,
      'status ' + velho.status + '/' + novo.status + '; tamanhos '
        + velho.texto.length + '/' + novo.texto.length,
    );
    conferir('o Cache-Control do rev, com a lição do immutable',
      velho.cache === novo.cache, 'velho=' + velho.cache + ' novo=' + novo.cache);
    await comparar('a telemetria vazia', '/api/widgets/' + deterministico.id + '/telemetry', false);
  } else {
    conferir('o render byte a byte', false,
      'nenhum widget sem semente no staging (tipos: '
        + widgets.map((w) => w.widget_type).join(', ') + ')');
  }

  const board = widgets.find((w) => w.widget_type === 'directory-board');
  if (board) {
    await comparar('o data.json do quadro', '/api/widgets/' + board.id + '/data.json', false);
  }

  console.log('\n' + passou + ' passaram, ' + falhou + ' falharam');
  process.exit(falhou ? 1 : 0);
})();
