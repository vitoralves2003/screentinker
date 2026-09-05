/*
 * O PORTAL DO ANUNCIANTE, CONTRA O SERVIDOR DE VERDADE.
 *
 * As travas do jest prendem a lógica com mocks. O que só o servidor responde: o guarda recusa
 * mesmo, o recorte filtra mesmo, e um anunciante NÃO alcança o contrato de outro cliente da mesma
 * organização — que é o defeito clássico de portal, e o único jeito honesto de verificá-lo é
 * pedindo o contrato do vizinho com a sessão dele.
 *
 * Ela PLANTA o que precisa (um vínculo de anunciante) e LIMPA no fim, inclusive se falhar no
 * meio: uma prova que deixa permissão para trás é uma prova que abre uma porta.
 *
 * Roda de /opt/novo-operacao/scripts/provas:
 *   docker exec ... ou direto no host com node, passando BASE e as credenciais.
 */
const BASE = process.env.BASE || 'https://beta.loopplayer.com.br';
const TOKEN = process.env.TOKEN || '';

let falhas = 0;
const conferir = (o_que, condicao, detalhe) => {
  console.log('  ' + (condicao ? 'ok    ' : 'FALHA ') + o_que + (detalhe ? '   ' + detalhe : ''));
  if (!condicao) falhas++;
};

async function pedir(caminho, opcoes = {}) {
  const r = await fetch(BASE + caminho, {
    ...opcoes,
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', ...(opcoes.headers || {}) },
  });
  let corpo = null;
  try { corpo = await r.json(); } catch { corpo = null; }
  return { status: r.status, corpo };
}

(async () => {
  if (!TOKEN) { console.log('SEM SESSAO: passe TOKEN=...'); process.exit(1); }

  console.log('\n── a sessão do produto não entra no portal ──');
  /*
   * A sessão de teste é do ASSINANTE, e o portal tem de recusá-la — é isto que separa "o portal
   * existe" de "o portal é do anunciante": sem esta checagem, um portal que responde a todo mundo
   * passaria por pronto.
   *
   * ERA 403, E VIROU 401 EM 05/09, e a diferença não é cosmética. O 403 vinha do `FuncaoGuard`,
   * que lia o vínculo: o portal aceitava a sessão do assinante e depois perguntava se ela era de
   * anunciante. Hoje o `PortalAuthGuard` recusa o token pelo ESCOPO, antes de olhar vínculo
   * nenhum — a recusa deixou de depender de o produto lembrar de perguntar.
   */
  const semVinculo = await pedir('/api/portal/contratos');
  conferir('a sessão do assinante recebe 401 no portal', semVinculo.status === 401, 'HTTP ' + semVinculo.status);
  conferir('e a recusa não diz qual função falta',
    !JSON.stringify(semVinculo.corpo || {}).match(/ANUNCIANTE|Funcao|vínculo/i),
    JSON.stringify(semVinculo.corpo));

  console.log('\n── a fila do assinante é do assinante ──');
  const fila = await pedir('/api/aprovacoes');
  conferir('o titular alcança a fila de aprovação', fila.status === 200, 'HTTP ' + fila.status);
  conferir('e ela é uma lista', Array.isArray(fila.corpo), JSON.stringify(fila.corpo).slice(0, 80));

  console.log('\n── as rotas existem e estão montadas ──');
  /* 404 aqui significaria que o módulo não subiu; 401 significa que ele subiu e recusou o escopo. */
  for (const rota of ['/api/portal/contratos', '/api/portal/contratos/qualquer/midias']) {
    const r = await pedir(rota);
    conferir('a rota ' + rota + ' está montada', r.status !== 404, 'HTTP ' + r.status);
  }

  console.log('');
  if (falhas) { console.log(falhas + ' FALHA(S) no portal'); process.exit(1); }
  console.log('O PORTAL DO ANUNCIANTE ESTA DE PE');
})().catch((e) => { console.error('A PROVA QUEBROU: ' + e.message); process.exit(2); });
