import { esc } from '../utils.js';

/*
 * DE QUAL CONTRATO É ESTE ARQUIVO — perguntado em duas etapas.
 *
 * ── POR QUE DUAS ETAPAS, E NÃO UMA LISTA ─────────────────────────────────────────────────
 * Uma lista de todos os contratos da conta é ilegível assim que o assinante passa de uma dúzia:
 * eles se chamam por número, e ninguém decora números de contrato. O que a pessoa sabe é o nome
 * do anunciante.
 *
 * Então: digita o nome, escolhe o anunciante, e aparecem OS CONTRATOS DELE — dois ou três, com
 * o serviço e a vigência à vista. É a diferença entre reconhecer e lembrar.
 *
 * ── ISTO SÓ EXISTE PORQUE A FEDERAÇÃO MORREU ─────────────────────────────────────────────
 * Uma tela da Operação lendo anunciantes e contratos da Gestão teria exigido, antes da Etapa 1,
 * duas rotas federadas novas, um token de troca e um porteiro. Depois da Fase B são dois `fetch`
 * na mesma origem, com a sessão que já está aqui. O plano previu esta tela como a primeira
 * funcionalidade que sairia de graça depois da unificação — e saiu.
 *
 * ── E ELE NÃO APARECE PARA QUEM NÃO TEM GESTÃO ───────────────────────────────────────────
 * Sem Gestão não há contrato nenhum, e um campo que só pode ficar vazio é uma pergunta sem
 * resposta possível. Quem chama decide, por `plan.gestao_enabled`.
 */

const API_GESTAO = '/gestao-api';

function autorizacao() {
  try {
    const t = localStorage.getItem('token');
    return t ? { Authorization: 'Bearer ' + t } : null;
  } catch {
    // Navegador com dados de site bloqueados. Sem sessão não há o que perguntar.
    return null;
  }
}

async function buscar(caminho) {
  const cab = autorizacao();
  if (!cab) return null;
  try {
    const r = await fetch(API_GESTAO + caminho, { headers: cab });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/*
 * Monta o campo dentro de `host`. Devolve `{ valor() }` — quem chama lê no momento de salvar,
 * em vez de receber um evento a cada tecla.
 *
 * `contratoAtual` e `nomeAtual` desenham o estado inicial sem uma ida ao servidor: a lista de
 * conteúdo já traz o id, e o nome vem junto quando a API o tiver. Sem nome, mostra o id — que é
 * feio e honesto, e melhor que uma linha em branco sobre um vínculo que existe.
 */
export function montarCampoContrato(host, { contratoAtual = null, nomeAtual = null } = {}) {
  let escolhido = contratoAtual || null;

  host.innerHTML = `
    <div class="form-group">
      <label>Contrato do anunciante</label>
      <div id="ccEscolhido" style="display:${escolhido ? 'flex' : 'none'};align-items:center;gap:8px;
           padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-input)">
        <span style="flex:1;min-width:0;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
              id="ccRotulo">${esc(nomeAtual || escolhido || '')}</span>
        <button type="button" class="btn btn-secondary btn-sm" id="ccTirar">Tirar</button>
      </div>
      <div id="ccBusca" style="display:${escolhido ? 'none' : 'block'}">
        <input type="text" id="ccAnunciante" class="input" placeholder="Buscar anunciante..." autocomplete="off">
        <div id="ccResultados" style="margin-top:6px"></div>
      </div>
      <div class="form-hint" style="font-size:11px;color:var(--text-muted);margin-top:6px">
        Ligar o arquivo a um contrato faz a exibição dele parar quando aquele contrato para —
        por cancelamento, encerramento ou atraso. Deixe vazio para material da sua própria empresa.
      </div>
    </div>
  `;

  const campoBusca = host.querySelector('#ccAnunciante');
  const resultados = host.querySelector('#ccResultados');
  const caixaEscolhido = host.querySelector('#ccEscolhido');
  const rotulo = host.querySelector('#ccRotulo');
  const busca = host.querySelector('#ccBusca');

  function mostrarEscolhido(id, texto) {
    escolhido = id;
    rotulo.textContent = texto;
    caixaEscolhido.style.display = 'flex';
    busca.style.display = 'none';
    resultados.innerHTML = '';
  }

  host.querySelector('#ccTirar').addEventListener('click', () => {
    escolhido = null;
    caixaEscolhido.style.display = 'none';
    busca.style.display = 'block';
    campoBusca.value = '';
    resultados.innerHTML = '';
    campoBusca.focus();
  });

  function vazio(msg) {
    resultados.innerHTML = `<div style="font-size:12px;color:var(--text-muted);padding:8px 2px">${esc(msg)}</div>`;
  }

  function linha(texto, sub, aoClicar) {
    const el = document.createElement('button');
    el.type = 'button';
    el.style.cssText = 'display:block;width:100%;text-align:left;padding:8px 10px;border:1px solid var(--border);'
      + 'border-radius:var(--radius);background:var(--bg-card);margin-bottom:4px;cursor:pointer';
    el.innerHTML = `<div style="font-size:13px;color:var(--text-primary)">${esc(texto)}</div>`
      + (sub ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px">${esc(sub)}</div>` : '');
    el.addEventListener('click', aoClicar);
    resultados.appendChild(el);
    return el;
  }

  /*
   * A SEGUNDA ETAPA. Escolhido o anunciante, aparecem os contratos DELE — pelo filtro
   * `clientId` na mesma lista que a tela de Contratos usa, e não por uma consulta própria.
   */
  async function mostrarContratos(cliente) {
    resultados.innerHTML = '';
    vazio('Carregando contratos…');
    const d = await buscar(`/contracts?clientId=${encodeURIComponent(cliente.id)}&limit=50`);
    const itens = (d && (d.items || d)) || [];
    resultados.innerHTML = '';

    if (!Array.isArray(itens) || !itens.length) {
      vazio(`${cliente.name} não tem contrato nenhum.`);
      return;
    }

    for (const c of itens) {
      const numero = c.number ? `Contrato ${c.number}` : 'Contrato sem número';
      const servico = c.template?.service?.name || c.template?.name || '';
      const situacao = c.status === 'ACTIVE' ? '' : ` · ${c.status}`;
      linha(`${numero}${situacao}`, [cliente.name, servico].filter(Boolean).join(' · '),
        () => mostrarEscolhido(c.id, `${cliente.name} — ${numero}`));
    }
  }

  /*
   * A PRIMEIRA. Sem "debounce" elaborado: uma espera curta basta, e o que ela evita é uma ida
   * ao servidor por tecla — não um problema de correção, mas de uma lista piscando embaixo de
   * quem está digitando.
   */
  let timer = null;
  campoBusca.addEventListener('input', () => {
    const termo = campoBusca.value.trim();
    clearTimeout(timer);
    if (termo.length < 2) { resultados.innerHTML = ''; return; }

    timer = setTimeout(async () => {
      vazio('Buscando…');
      const d = await buscar(`/clients?search=${encodeURIComponent(termo)}`);
      const itens = (d && (d.items || d)) || [];
      resultados.innerHTML = '';

      if (!Array.isArray(itens) || !itens.length) {
        vazio(`Nenhum anunciante com "${termo}"`);
        return;
      }
      for (const cl of itens.slice(0, 8)) {
        linha(cl.name, cl.document || '', () => void mostrarContratos(cl));
      }
    }, 250);
  });

  /*
   * `undefined` quando nada mudou, para quem chama não mandar o campo à toa: o servidor trata
   * qualquer `contrato_id` recebido como uma mudança e republica as listas por causa dele.
   */
  return {
    valor() {
      const antes = contratoAtual || null;
      return escolhido === antes ? undefined : escolhido;
    },
  };
}
