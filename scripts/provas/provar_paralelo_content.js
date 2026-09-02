/*
 * O CAMINHO PARALELO DE CONTENT RESPONDE IGUAL À CASA VELHA — Fase B (02/09).
 *
 * O orquestrador semeia um PNG minúsculo pela casa VELHA antes do espelho (CONTENT_ID no
 * ambiente) e apaga depois. Compara com a mesma sessão:
 *
 *   GET /api/content            a lista, com o selo de agenda
 *   GET /api/content/folders    as pastas por rótulo
 *   GET /api/content/:id        a linha semeada
 *   GET /:id/file               OS BYTES — o volume da casa velha está montado
 *                               somente-leitura na casa nova; os arquivos são os mesmos
 *   GET /:id/schedules          vazio dos dois lados
 *
 * E os DOIS primeiros testes de ESCRITA do paralelo (contra o espelho, que se renova):
 *   PUT (novo) /:id/schedules   grava um bloco e o lê de volta na casa nova
 *   PUT (novo) /:id             renomeia e lê de volta — o safeFilename escapando igual
 *
 *   TOKEN=... CONTENT_ID=... UNI=http://127.0.0.1:3100 node provar_paralelo_content.js
 */
const UNI = process.env.UNI || 'http://127.0.0.1:3100';
const TOKEN = process.env.TOKEN || '';
const CONTENT_ID = process.env.CONTENT_ID || '';

let passou = 0;
let falhou = 0;
function conferir(nome, ok, detalhe) {
  if (ok) { passou++; console.log('  ok    ' + nome); }
  else { falhou++; console.log('  FALHA ' + nome + (detalhe ? '  -> ' + detalhe : '')); }
}

async function pegar(caminho, opts = {}) {
  const r = await fetch(UNI + caminho, {
    method: opts.metodo || 'GET',
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      ...(opts.corpo ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.corpo ? JSON.stringify(opts.corpo) : undefined,
  });
  const bruto = Buffer.from(await r.arrayBuffer());
  let corpo = null;
  try { corpo = JSON.parse(bruto.toString('utf8')); } catch { corpo = null; }
  return { status: r.status, corpo, bruto };
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
    return caminho + ': velho=' + JSON.stringify(a) + ' novo=' + JSON.stringify(b);
  }
  const chaves = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of chaves) {
    const d = primeiraDiferenca(a[k], b[k], caminho + '.' + k);
    if (d) return d;
  }
  return null;
}

async function comparar(nome, caminho) {
  const velho = await pegar(caminho);
  const novo = await pegar('/gestao-api' + caminho);
  if (velho.status !== novo.status) {
    conferir(nome, false, 'status: velho=' + velho.status + ' novo=' + novo.status
      + ' | novo corpo: ' + novo.bruto.toString('utf8').slice(0, 140));
    return;
  }
  const d = primeiraDiferenca(canonico(velho.corpo), canonico(novo.corpo), '$');
  conferir(nome + ' (status ' + velho.status + ')', !d, d);
}

(async () => {
  if (!TOKEN || !CONTENT_ID) { console.log('SEM SESSAO OU SEM CONTENT_ID'); process.exit(1); }

  await comparar('a lista da biblioteca', '/api/content');
  await comparar('as pastas', '/api/content/folders');
  await comparar('a linha semeada', '/api/content/' + CONTENT_ID);
  await comparar('as agendas vazias', '/api/content/' + CONTENT_ID + '/schedules');
  await comparar('as regras vazias', '/api/content/' + CONTENT_ID + '/schedule-rules');

  const bytesVelho = await pegar('/api/content/' + CONTENT_ID + '/file');
  const bytesNovo = await pegar('/gestao-api/api/content/' + CONTENT_ID + '/file');
  conferir('os bytes do arquivo, do mesmo volume',
    bytesVelho.status === 200 && bytesNovo.status === 200
      && bytesVelho.bruto.equals(bytesNovo.bruto),
    'status ' + bytesVelho.status + '/' + bytesNovo.status
      + '; tamanhos ' + bytesVelho.bruto.length + '/' + bytesNovo.bruto.length);

  /* Escrita na casa NOVA, contra o espelho — o motor dela, de ponta a ponta. */
  const bloco = { blocks: [{ days: [1, 3, 5], start: '08:00', end: '18:00' }] };
  const gravou = await pegar('/gestao-api/api/content/' + CONTENT_ID + '/schedules',
    { metodo: 'PUT', corpo: bloco });
  conferir('a casa nova grava um bloco de agenda',
    gravou.status === 200 && Array.isArray(gravou.corpo?.blocks)
      && gravou.corpo.blocks.length === 1
      && gravou.corpo.blocks[0].days.join(',') === '1,3,5',
    'status ' + gravou.status + ' corpo ' + JSON.stringify(gravou.corpo).slice(0, 120));

  const renomeou = await pegar('/gestao-api/api/content/' + CONTENT_ID,
    { metodo: 'PUT', corpo: { filename: 'prova <renomeada>.png' } });
  conferir('a casa nova renomeia escapando como a velha',
    renomeou.status === 200 && renomeou.corpo?.filename === 'prova &lt;renomeada&gt;.png',
    'status ' + renomeou.status + ' filename ' + JSON.stringify(renomeou.corpo?.filename));

  console.log('\n' + passou + ' passaram, ' + falhou + ' falharam');
  process.exit(falhou ? 1 : 0);
})();
