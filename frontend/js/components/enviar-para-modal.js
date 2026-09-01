import { api } from '../api.js';
import { showToast } from './toast.js';
import { esc } from '../utils.js';

/*
 * ENVIAR PARA… — primeiro o TIPO de destino, depois os destinos daquele tipo.
 *
 * ── POR QUE DUAS ETAPAS ──────────────────────────────────────────────────────────────────
 * A primeira versão listava tudo junto: grupos, telas e playlists numa rolagem só. Funciona com
 * seis destinos e para de funcionar bem antes do centésimo. O Vitor: "imagine quando eu tiver 100
 * telas, 20 grupos e mais de 200 listas".
 *
 * Trezentas e vinte linhas numa lista é uma lista que ninguém percorre — a pessoa cai na busca por
 * falta de alternativa, e buscar exige lembrar o nome. Escolher o TIPO primeiro corta o problema
 * em três, e cada pedaço volta a caber numa tela.
 *
 * ── E ANTES DISSO ELE ERA DOIS MENUS ─────────────────────────────────────────────────────
 * A barra de ações em massa tinha "Adicionar à lista…" e "Enviar para tela…" lado a lado. No
 * celular são dois painéis de 230px numa barra que já não cabe, abrindo por cima um do outro.
 *
 * ── O QUE FICA MARCADO NÃO SE PERDE ──────────────────────────────────────────────────────
 * Voltar ao menu de tipos mantém o que já foi marcado nos outros, e o botão soma tudo. Mandar
 * para dois grupos E uma tela avulsa é raro, mas quando é preciso a alternativa seria enviar
 * duas vezes — e quem envia duas vezes um dia envia uma só e não percebe.
 *
 * ── E O ESPAÇO PRÓPRIO DAS TELAS NÃO É UM DESTINO ────────────────────────────────────────
 * As listas automáticas — "Bar do Porto playlist" e irmãs — são o conteúdo de uma tela,
 * alcançável só por ela. Mandar um arquivo "para a lista da Bar do Porto" é mandar para a tela
 * Bar do Porto, escrito de um jeito que ninguém reconhece; quem quer isso escolhe a TELA.
 */

const TIPOS = {
  grupos: {
    rotulo: 'Grupos',
    // Grupos primeiro: quem criou um grupo o criou para não escolher tela por tela.
    descricao: 'Manda para todas as telas do grupo de uma vez',
    icone: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>'
      + '<rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    vazio: 'Nenhum grupo criado ainda',
  },
  telas: {
    rotulo: 'Telas',
    descricao: 'Escolhe tela por tela',
    icone: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/>'
      + '<line x1="12" y1="17" x2="12" y2="21"/>',
    vazio: 'Nenhuma tela cadastrada',
  },
  listas: {
    rotulo: 'Playlists',
    descricao: 'Entra na lista, e vai para toda tela que a exibe',
    icone: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/>'
      + '<line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/>'
      + '<line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
    vazio: 'Nenhuma playlist criada ainda',
  },
};

/**
 * Abre o seletor de destino.
 *
 * `permitir` diz quais tipos fazem sentido para o que está sendo enviado: um arquivo vai para
 * tela, grupo ou lista; uma lista vai para tela ou grupo — lista dentro de lista foi retirada em
 * 31/08, porque é uma camada a mais para o player resolver e a tela já é onde as listas se juntam.
 */
export async function abrirEnviarPara({
  titulo = 'Enviar para…',
  permitir = ['grupos', 'telas', 'listas'],
  enviar,
  aoEnviar,
} = {}) {
  const marcado = { grupos: new Set(), telas: new Set(), listas: new Set() };
  let tipoAberto = null;

  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;'
    + 'align-items:center;justify-content:center;z-index:1000;padding:16px';
  modal.innerHTML = `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);
                padding:20px;max-width:520px;width:100%;max-height:85vh;display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
        <button class="btn-icon" id="epVoltar" title="Voltar" style="display:none">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
        </button>
        <h3 id="epTitulo" style="margin:0;color:var(--text-primary);font-size:17px">${esc(titulo)}</h3>
      </div>
      <div id="epSub" style="font-size:12px;color:var(--text-muted);margin-bottom:14px">
        Escolha para onde vai. O que entra numa tela já fica exibindo.
      </div>
      <!--
        O RESUMO DO QUE VAI SAIR, soletrado por tipo.

        O botão dizia "Enviar para 2" enquanto a lista à frente mostrava zero marcados, porque o
        que ficou marcado em outro tipo continuava contando. A contagem estava certa e não tinha
        como ser entendida. Esta linha é o que faltava dizer.
      -->
      <div id="epResumo" style="display:none;font-size:12px;color:var(--accent-ink);
           background:var(--bg-input);border-radius:var(--radius);padding:8px 10px;margin-bottom:12px"></div>
      <input type="text" id="epBusca" class="input" placeholder="Buscar..."
             style="width:100%;margin-bottom:12px;display:none">
      <div id="epCorpo" style="flex:1;overflow-y:auto;min-height:180px;max-height:50vh">
        <div style="color:var(--text-muted);padding:20px;text-align:center">Carregando…</div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
        <button class="btn btn-secondary" id="epFechar">Cancelar</button>
        <button class="btn btn-primary" id="epEnviar" disabled>Enviar</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const corpo = modal.querySelector('#epCorpo');
  const busca = modal.querySelector('#epBusca');
  const botao = modal.querySelector('#epEnviar');
  const voltar = modal.querySelector('#epVoltar');
  const resumo = modal.querySelector('#epResumo');
  const sub = modal.querySelector('#epSub');
  const tituloEl = modal.querySelector('#epTitulo');

  const fechar = () => modal.remove();
  modal.querySelector('#epFechar').addEventListener('click', fechar);
  modal.addEventListener('click', (e) => { if (e.target === modal) fechar(); });

  // ── o que existe ────────────────────────────────────────────────────────────────────
  let dados = { grupos: [], telas: [], listas: [] };
  try {
    const [telas, grupos, listas] = await Promise.all([
      permitir.includes('telas') ? api.getDevices() : [],
      // Grupos e listas são opcionais: um erro numa delas não pode impedir o envio pelas outras.
      permitir.includes('grupos') ? api.getGroups().catch(() => []) : [],
      permitir.includes('listas') ? api.getPlaylists().catch(() => []) : [],
    ]);
    dados = {
      grupos: Array.isArray(grupos) ? grupos : [],
      telas: Array.isArray(telas) ? telas : (telas?.devices || []),
      listas: (Array.isArray(listas) ? listas : []).filter((p) => !p.is_auto_generated),
    };
  } catch (err) {
    corpo.innerHTML = `<div style="color:var(--danger);padding:20px;text-align:center">${esc(err.message)}</div>`;
    return;
  }

  const total = () => marcado.grupos.size + marcado.telas.size + marcado.listas.size;

  const SINGULAR = { grupos: 'grupo', telas: 'tela', listas: 'playlist' };

  function atualizarBotao() {
    botao.disabled = total() === 0;
    botao.textContent = total() ? `Enviar para ${total()}` : 'Enviar';

    /*
     * E O RESUMO DIZ DE ONDE VEM O NÚMERO.
     *
     * Sem isto o botão dizia "Enviar para 2" com a lista à frente mostrando zero marcados — a
     * contagem certa e sem como ser entendida, porque o que estava marcado ficava num tipo que
     * a pessoa não estava olhando.
     */
    const partes = Object.keys(marcado)
      .filter((tipo) => marcado[tipo].size)
      .map((tipo) => {
        const n = marcado[tipo].size;
        return `${n} ${SINGULAR[tipo]}${n > 1 ? 's' : ''}`;
      });

    resumo.style.display = partes.length ? '' : 'none';
    resumo.textContent = partes.length ? `Marcado: ${partes.join(' · ')}` : '';
  }

  // ── etapa 1: o tipo ─────────────────────────────────────────────────────────────────
  function desenharTipos() {
    tipoAberto = null;
    voltar.style.display = 'none';
    busca.style.display = 'none';
    busca.value = '';
    tituloEl.textContent = titulo;
    sub.textContent = 'Escolha para onde vai. O que entra numa tela já fica exibindo.';

    /*
     * UM TIPO SEM NENHUM NÃO APARECE.
     *
     * "Não pode aparecer grupos se não haver nenhum" — e ele está certo: uma opção que leva a uma
     * lista vazia é uma promessa quebrada em dois cliques. É a mesma regra que o modal de
     * adicionar conteúdo já usa para as abas pagas, e que eu não repeti aqui.
     */
    const comAlgum = permitir.filter((tipo) => dados[tipo].length > 0);

    if (!comAlgum.length) {
      corpo.innerHTML = `<div style="color:var(--text-muted);padding:28px;text-align:center;font-size:13px">
        Não há para onde enviar ainda — cadastre uma tela ou crie uma playlist primeiro.</div>`;
      return;
    }

    /*
     * COM UM TIPO SÓ, o menu não tem escolha a oferecer: ele seria um botão único levando ao
     * único lugar possível. Vai direto para a lista, e o botão de voltar some junto (não há para
     * onde voltar).
     */
    if (comAlgum.length === 1) {
      tipoAberto = comAlgum[0];
      desenharDestinos();
      return;
    }

    corpo.innerHTML = comAlgum.map((tipo) => {
      const t = TIPOS[tipo];
      const quantos = dados[tipo].length;
      const marcados = marcado[tipo].size;
      return `
        <button type="button" data-tipo="${tipo}" style="display:flex;align-items:center;gap:14px;width:100%;
                text-align:left;padding:14px;border:1px solid var(--border);border-radius:var(--radius);
                background:var(--bg-card);margin-bottom:8px;cursor:pointer">
          <span style="width:36px;height:36px;border-radius:8px;background:var(--bg-input);flex-shrink:0;
                       display:flex;align-items:center;justify-content:center;color:var(--accent-ink)">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${t.icone}</svg>
          </span>
          <span style="flex:1;min-width:0">
            <span style="display:block;font-size:14px;font-weight:600;color:var(--text-primary)">${esc(t.rotulo)}</span>
            <span style="display:block;font-size:11px;color:var(--text-muted);margin-top:2px">${esc(t.descricao)}</span>
          </span>
          <span style="flex-shrink:0;font-size:12px;color:${marcados ? 'var(--accent-ink)' : 'var(--text-muted)'}">
            ${esc(marcados ? `${marcados} marcado(s)` : `${quantos}`)}
          </span>
        </button>`;
    }).join('');
  }

  // ── etapa 2: os destinos daquele tipo ───────────────────────────────────────────────
  function meta(tipo, x) {
    if (tipo === 'grupos') return `${x.device_count ?? 0} tela(s)`;
    if (tipo === 'telas') return x.status === 'online' ? 'no ar' : 'fora do ar';
    return `${x.item_count || 0} itens`;
  }

  function desenharDestinos() {
    const tipo = tipoAberto;
    const t = TIPOS[tipo];
    // Sem menu não há para onde voltar: com um tipo só, a lista É a primeira tela.
    const temMenu = permitir.filter((x) => dados[x].length > 0).length > 1;
    voltar.style.display = temMenu ? '' : 'none';
    /*
     * A BUSCA FICA SEMPRE.
     *
     * Ela aparecia só acima de seis itens, o que parecia limpo e era pior: o comportamento da
     * tela mudava sozinho conforme a conta crescia, debaixo de quem já tinha aprendido onde as
     * coisas ficam. E mesmo com quatro telas, digitar três letras chega antes de ler quatro linhas.
     */
    busca.style.display = '';
    tituloEl.textContent = t.rotulo;
    sub.textContent = t.descricao;

    const q = busca.value.trim().toLowerCase();
    const vis = dados[tipo].filter((x) => !q || String(x.name || '').toLowerCase().includes(q));

    if (!vis.length) {
      corpo.innerHTML = `<div style="color:var(--text-muted);padding:24px;text-align:center;font-size:13px">
        ${esc(q ? `Nada com "${busca.value.trim()}"` : t.vazio)}</div>`;
      return;
    }

    corpo.innerHTML = vis.map((x) => `
      <label style="display:flex;align-items:center;gap:10px;padding:10px;border-radius:var(--radius);
                    cursor:pointer;border:1px solid transparent">
        <input type="checkbox" data-id="${esc(x.id)}" ${marcado[tipo].has(x.id) ? 'checked' : ''}
               style="width:16px;height:16px;flex-shrink:0">
        <span style="flex:1;min-width:0;font-size:13px;color:var(--text-primary);white-space:nowrap;
                     overflow:hidden;text-overflow:ellipsis">${esc(x.name)}</span>
        <span style="flex-shrink:0;font-size:11px;color:var(--text-muted)">${esc(meta(tipo, x))}</span>
      </label>`).join('');
  }

  voltar.addEventListener('click', () => { desenharTipos(); atualizarBotao(); });
  busca.addEventListener('input', () => { if (tipoAberto) desenharDestinos(); });

  corpo.addEventListener('click', (e) => {
    const escolha = e.target.closest('[data-tipo]');
    if (!escolha) return;
    tipoAberto = escolha.dataset.tipo;
    desenharDestinos();
  });

  corpo.addEventListener('change', (e) => {
    const cx = e.target.closest('[data-id]');
    if (!cx || !tipoAberto) return;
    const conj = marcado[tipoAberto];
    if (cx.checked) conj.add(cx.dataset.id); else conj.delete(cx.dataset.id);
    // Só o botão muda: redesenhar aqui brigaria com a caixa que acabou de ser clicada.
    atualizarBotao();
  });

  botao.addEventListener('click', async () => {
    botao.disabled = true;
    botao.textContent = 'Enviando…';
    try {
      const r = await enviar({
        device_ids: [...marcado.telas],
        group_ids: [...marcado.grupos],
        playlist_alvo_ids: [...marcado.listas],
      });
      fechar();
      if (aoEnviar) await aoEnviar(r);
    } catch (err) {
      atualizarBotao();
      showToast(err.message, 'error');
    }
  });

  desenharTipos();
  atualizarBotao();
}
