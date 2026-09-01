import { api } from '../api.js';
import { showToast } from './toast.js';
import { esc } from '../utils.js';

/*
 * ENVIAR PARA… — um destino só, três tipos de destino.
 *
 * ── POR QUE UM MODAL, E NÃO DOIS MENUS SUSPENSOS ─────────────────────────────────────────
 * A barra de ações em massa tinha dois campos lado a lado: "Adicionar à lista…" e "Enviar para
 * tela…". No desktop já era estranho — a pessoa precisa saber qual dos dois é o caminho antes de
 * saber o que quer fazer. No celular não funciona: dois menus flutuantes de 230px numa barra que
 * já não cabe, abrindo por cima um do outro.
 *
 * O Vitor: "deveria abrir uma lista com opções de envio e o assinante escolhe se quer grupo,
 * telas, playlists. Temos que pensar assim pois ao abrir no mobile teremos dificuldades".
 *
 * Então é um botão, um modal, e dentro dele as três coisas que podem receber conteúdo. O modal
 * ocupa a tela no celular e uma caixa no desktop — o mesmo componente serve os dois.
 *
 * ── E O ESPAÇO PRÓPRIO DAS TELAS NÃO É UM DESTINO ────────────────────────────────────────
 * As listas automáticas — "Bar do Porto playlist" e irmãs — apareciam entre as playlists. Elas
 * são o conteúdo de uma tela, alcançável só por ela; mandar um arquivo "para a lista da Bar do
 * Porto" é mandar para a tela Bar do Porto, escrito de um jeito que ninguém reconhece. Quem quer
 * isso escolhe a TELA, que está logo acima.
 */

const TIPOS = {
  telas: { rotulo: 'Telas', vazio: 'Nenhuma tela cadastrada' },
  grupos: { rotulo: 'Grupos', vazio: 'Nenhum grupo criado' },
  listas: { rotulo: 'Playlists', vazio: 'Nenhuma playlist criada' },
};

/**
 * Abre o seletor de destino.
 *
 * `permitir` diz quais destinos fazem sentido para o que está sendo enviado: um arquivo vai para
 * tela, grupo ou lista; uma lista vai para tela ou grupo (lista dentro de lista foi retirada em
 * 31/08 — é uma camada a mais para o player resolver, e a tela já é onde as listas se juntam).
 */
export async function abrirEnviarPara({
  titulo = 'Enviar para…',
  permitir = ['telas', 'grupos', 'listas'],
  enviar,
  aoEnviar,
} = {}) {
  const marcado = { telas: new Set(), grupos: new Set(), listas: new Set() };

  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;'
    + 'align-items:center;justify-content:center;z-index:1000;padding:16px';
  modal.innerHTML = `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);
                padding:20px;max-width:520px;width:100%;max-height:85vh;display:flex;flex-direction:column">
      <h3 style="margin:0 0 4px;color:var(--text-primary)">${esc(titulo)}</h3>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:14px">
        Escolha quantos destinos quiser. O que entra numa tela já fica exibindo.
      </div>
      <input type="text" id="epBusca" class="input" placeholder="Buscar..." style="width:100%;margin-bottom:12px">
      <div id="epLista" style="flex:1;overflow-y:auto;min-height:180px;max-height:50vh">
        <div style="color:var(--text-muted);padding:20px;text-align:center">Carregando…</div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
        <button class="btn btn-secondary" id="epFechar">Cancelar</button>
        <button class="btn btn-primary" id="epEnviar" disabled>Enviar</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const lista = modal.querySelector('#epLista');
  const busca = modal.querySelector('#epBusca');
  const botao = modal.querySelector('#epEnviar');

  const fechar = () => modal.remove();
  modal.querySelector('#epFechar').addEventListener('click', fechar);
  modal.addEventListener('click', (e) => { if (e.target === modal) fechar(); });

  // ── o que existe ────────────────────────────────────────────────────────────────────
  let dados = { telas: [], grupos: [], listas: [] };
  try {
    const [telas, grupos, listas] = await Promise.all([
      permitir.includes('telas') ? api.getDevices() : [],
      // Grupos e listas são opcionais: uma conta sem nenhum não deve ver a seção, e um erro
      // numa delas não pode impedir o envio pelas outras.
      permitir.includes('grupos') ? api.getGroups().catch(() => []) : [],
      permitir.includes('listas') ? api.getPlaylists().catch(() => []) : [],
    ]);
    dados = {
      telas: Array.isArray(telas) ? telas : (telas?.devices || []),
      grupos: Array.isArray(grupos) ? grupos : [],
      /*
       * O espaço próprio das telas fica de fora. Uma lista `is_auto_generated` é o conteúdo de
       * ALGUMA tela: mandar um arquivo "para a lista da Bar do Porto" é mandar para a tela Bar
       * do Porto, escrito de um jeito que ninguém reconhece — e a tela está logo acima na mesma
       * janela.
       */
      listas: (Array.isArray(listas) ? listas : []).filter((p) => !p.is_auto_generated),
    };
  } catch (err) {
    lista.innerHTML = `<div style="color:var(--danger);padding:20px;text-align:center">${esc(err.message)}</div>`;
    return;
  }

  function total() {
    return marcado.telas.size + marcado.grupos.size + marcado.listas.size;
  }

  function desenhar() {
    const q = busca.value.trim().toLowerCase();
    const casa = (nome) => !q || String(nome || '').toLowerCase().includes(q);

    const linha = (tipo, id, nome, meta) => `
      <label style="display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:var(--radius);
                    cursor:pointer;border:1px solid transparent">
        <input type="checkbox" data-tipo="${tipo}" data-id="${esc(id)}"
               ${marcado[tipo].has(id) ? 'checked' : ''} style="width:16px;height:16px;flex-shrink:0">
        <span style="flex:1;min-width:0;font-size:13px;color:var(--text-primary);white-space:nowrap;
                     overflow:hidden;text-overflow:ellipsis">${esc(nome)}</span>
        <span style="flex-shrink:0;font-size:11px;color:var(--text-muted)">${esc(meta)}</span>
      </label>`;

    const secao = (tipo, itens, comoLinha) => {
      if (!permitir.includes(tipo)) return '';
      const vis = itens.filter((x) => casa(x.name));
      if (!vis.length && q) return '';
      return `<div style="font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;
                   color:var(--text-muted);padding:10px 10px 4px">${esc(TIPOS[tipo].rotulo)}</div>`
        + (vis.length
          ? vis.map(comoLinha).join('')
          : `<div style="font-size:12px;color:var(--text-muted);padding:4px 10px 8px">${esc(TIPOS[tipo].vazio)}</div>`);
    };

    /*
     * GRUPOS PRIMEIRO. Quem criou um grupo o criou para não escolher tela por tela; enterrá-lo
     * embaixo de trinta telas é pedir que refaça à mão o que já organizou uma vez.
     */
    const html = [
      secao('grupos', dados.grupos, (g) => linha('grupos', g.id, g.name, `${g.device_count ?? 0} tela(s)`)),
      secao('telas', dados.telas, (d) => linha('telas', d.id, d.name, d.status === 'online' ? 'no ar' : 'fora do ar')),
      secao('listas', dados.listas, (p) => linha('listas', p.id, p.name, `${p.item_count || 0} itens`)),
    ].join('');

    lista.innerHTML = html || `<div style="color:var(--text-muted);padding:20px;text-align:center">
      ${esc(q ? `Nada com "${busca.value.trim()}"` : 'Nenhum destino disponível')}</div>`;

    botao.disabled = total() === 0;
    botao.textContent = total() ? `Enviar para ${total()}` : 'Enviar';
  }

  desenhar();
  busca.addEventListener('input', desenhar);

  lista.addEventListener('change', (e) => {
    const cx = e.target.closest('[data-tipo]');
    if (!cx) return;
    const conj = marcado[cx.dataset.tipo];
    if (cx.checked) conj.add(cx.dataset.id); else conj.delete(cx.dataset.id);
    // Só o botão muda: redesenhar aqui brigaria com a caixa que acabou de ser clicada.
    botao.disabled = total() === 0;
    botao.textContent = total() ? `Enviar para ${total()}` : 'Enviar';
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
      botao.disabled = false;
      botao.textContent = `Enviar para ${total()}`;
      showToast(err.message, 'error');
    }
  });
}
