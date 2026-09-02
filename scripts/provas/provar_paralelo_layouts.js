/*
 * O CAMINHO PARALELO DE LAYOUTS RESPONDE IGUAL À CASA VELHA — Fase B (02/09).
 *
 * Antes do corte, as rotas portadas vivem em paralelo: a casa velha segue dona de
 * /api/layouts e a nova responde em /gestao-api/api/layouts, lendo o ESPELHO do Postgres
 * (scripts/migracao/espelhar_dominio.js). Paridade aqui não é "200 dos dois lados" — é o
 * MESMO corpo: mesma lista, mesmos campos, mesma ordem de zonas.
 *
 * Compara, com a mesma sessão da Operação:
 *   GET /api/layouts            a lista com zonas
 *   GET /api/layouts/:id        o primeiro layout da lista
 *   GET /api/layouts/device/:id/zones   o mapa de zonas de uma tela real
 *
 * Normaliza só o inevitável: ordena listas por id e chaves por nome. Qualquer divergência
 * imprime o caminho exato do primeiro campo que discorda.
 *
 *   TOKEN=... UNI=http://127.0.0.1:3100 node provar_paralelo_layouts.js
 */
const UNI = process.env.UNI || 'http://127.0.0.1:3100';
const TOKEN = process.env.TOKEN || '';

let passou = 0;
let falhou = 0;
function conferir(nome, ok, detalhe) {
  if (ok) { passou++; console.log('  ok    ' + nome); }
  else { falhou++; console.log('  FALHA ' + nome + (detalhe ? '  -> ' + detalhe : '')); }
}

async function pegar(caminho) {
  const r = await fetch(UNI + caminho, { headers: { Authorization: 'Bearer ' + TOKEN } });
  const corpo = await r.json().catch(() => null);
  return { status: r.status, corpo };
}

/* Canonicaliza para comparar: objetos com chaves ordenadas; arrays de objetos-com-id por id. */
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

async function comparar(nome, caminhoVelho, caminhoNovo) {
  const velho = await pegar(caminhoVelho);
  const novo = await pegar(caminhoNovo);
  if (velho.status !== novo.status) {
    conferir(nome, false, 'status: velho=' + velho.status + ' novo=' + novo.status
      + ' | novo corpo: ' + JSON.stringify(novo.corpo).slice(0, 160));
    return velho;
  }
  const d = primeiraDiferenca(canonico(velho.corpo), canonico(novo.corpo), '$');
  conferir(nome + ' (status ' + velho.status + ')', !d, d);
  return velho;
}

(async () => {
  if (!TOKEN) { console.log('SEM SESSAO: passe TOKEN=...'); process.exit(1); }

  const lista = await comparar('a lista de layouts', '/api/layouts', '/gestao-api/api/layouts');

  const primeiro = Array.isArray(lista.corpo) && lista.corpo[0];
  if (primeiro) {
    await comparar('um layout aberto', '/api/layouts/' + primeiro.id,
      '/gestao-api/api/layouts/' + primeiro.id);
  } else {
    conferir('um layout aberto', false, 'a lista veio vazia — nada para abrir');
  }

  const telas = await pegar('/api/devices');
  const tela = Array.isArray(telas.corpo) && telas.corpo[0];
  if (tela) {
    await comparar('o mapa de zonas de uma tela', '/api/layouts/device/' + tela.id + '/zones',
      '/gestao-api/api/layouts/device/' + tela.id + '/zones');
  } else {
    conferir('o mapa de zonas de uma tela', false, 'sem tela de verdade para perguntar');
  }

  console.log('\n' + passou + ' passaram, ' + falhou + ' falharam');
  process.exit(falhou ? 1 : 0);
})();
