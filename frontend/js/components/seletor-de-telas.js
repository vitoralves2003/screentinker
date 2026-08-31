import { api } from '../api.js';
import { showToast } from './toast.js';
import { esc } from '../utils.js';

/*
 * MANDAR PARA VÁRIAS TELAS DE UMA VEZ — o seletor, usado pela biblioteca e pela página de listas.
 *
 * ── UM SÓ, E NÃO DOIS ────────────────────────────────────────────────────────────────────
 * Arquivos e listas vão para telas do mesmo jeito, e o que muda entre os dois chamadores é uma
 * palavra no botão. Duas cópias divergiriam no dia em que alguém acrescentasse grupos a uma e
 * esquecesse a outra — e o sintoma, "em Arquivos dá para mandar para o grupo e em Playlists não",
 * ninguém liga a uma cópia feita meses antes.
 *
 * ── POR QUE UM CAMPO DE BUSCA, E NÃO UM <select> ─────────────────────────────────────────
 * Mesma razão do seletor de listas ao lado: um <select> com trinta telas deixa de ser usável, e
 * o que a pessoa sabe é o nome da tela. Digita, reconhece, marca.
 *
 * ── E OS GRUPOS APARECEM PRIMEIRO ────────────────────────────────────────────────────────
 * Quem tem grupo criou o grupo para não escolher tela por tela; enterrá-lo no fim da lista é
 * pedir que ele faça à mão o que já organizou uma vez. Quem não tem nenhum não vê a seção.
 */

// A lista de telas muda pouco durante uma visita, e reabrir o seletor três vezes seguidas é o
// uso normal. Zerado depois de cada envio, porque a contagem de itens de cada tela mudou.
let cacheTelas = null;
let cacheGrupos = null;

export function limparCacheDeTelas() {
  cacheTelas = null;
  cacheGrupos = null;
}

/**
 * Monta o seletor dentro de `bar` (a barra de ações em massa) e liga o envio.
 *
 * `itens` é o que vai: `{ content_ids }` ou `{ playlist_ids }`. Quem chama diz o que está
 * mandando, e o servidor decide se aquilo exige plano pago — a trava não mora aqui.
 */
export function ligarSeletorDeTelas(bar, itens, { aoEnviar } = {}) {
  const input = bar.querySelector('#enviarTelaInput');
  const resultados = bar.querySelector('#enviarTelaResultados');
  if (!input || !resultados) return;

  const telasMarcadas = new Set();
  const gruposMarcados = new Set();
  let aoClicarFora = null;

  function fechar() {
    resultados.hidden = true;
    if (aoClicarFora) { document.removeEventListener('mousedown', aoClicarFora); aoClicarFora = null; }
  }

  async function abrir() {
    if (!cacheTelas) {
      try {
        const [telas, grupos] = await Promise.all([
          api.getDevices(),
          // Grupos são opcionais: uma conta sem nenhum não deve ver a seção, e um erro aqui não
          // pode impedir o envio para telas, que é o caminho principal.
          api.getGroups().catch(() => []),
        ]);
        cacheTelas = Array.isArray(telas) ? telas : (telas?.devices || []);
        cacheGrupos = Array.isArray(grupos) ? grupos : [];
      } catch (err) {
        showToast(err.message, 'error');
        return;
      }
    }
    desenhar();
    resultados.hidden = false;
    /*
     * Fechado por um clique FORA, e não pelo campo perder o foco. Com caixas de seleção dentro,
     * cada marcação tira o foco do campo — e fechar no blur fecharia no primeiro clique.
     */
    if (!aoClicarFora) {
      aoClicarFora = (e) => { if (!bar.contains(e.target)) fechar(); };
      document.addEventListener('mousedown', aoClicarFora);
    }
  }

  function total() {
    return telasMarcadas.size + gruposMarcados.size;
  }

  function rotuloDoBotao() {
    const t = telasMarcadas.size;
    const g = gruposMarcados.size;
    if (g && t) return `Enviar para ${t} tela(s) e ${g} grupo(s)`;
    if (g) return `Enviar para ${g} grupo(s)`;
    return `Enviar para ${t} tela(s)`;
  }

  function desenhar() {
    const q = input.value.trim().toLowerCase();
    const gruposVis = (cacheGrupos || []).filter((g) => !q || (g.name || '').toLowerCase().includes(q));
    const telasVis = (cacheTelas || []).filter((d) => !q || (d.name || '').toLowerCase().includes(q)).slice(0, 8);

    const linhaGrupo = (g) => `<label class="bulk-picker-item">
        <input type="checkbox" data-grupo="${esc(g.id)}" ${gruposMarcados.has(g.id) ? 'checked' : ''}>
        <span class="bulk-picker-name">${esc(g.name)}</span>
        <span class="bulk-picker-meta">${esc(`${g.device_count ?? '—'} tela(s)`)}</span>
      </label>`;

    const linhaTela = (d) => `<label class="bulk-picker-item">
        <input type="checkbox" data-tela="${esc(d.id)}" ${telasMarcadas.has(d.id) ? 'checked' : ''}>
        <span class="bulk-picker-name">${esc(d.name)}</span>
        <span class="bulk-picker-meta">${esc(d.status === 'online' ? 'no ar' : 'fora do ar')}</span>
      </label>`;

    const partes = [];
    // Grupos primeiro: quem criou um grupo o criou para não escolher tela por tela.
    if (gruposVis.length) {
      partes.push('<div class="bulk-picker-head">Grupos</div>');
      partes.push(gruposVis.map(linhaGrupo).join(''));
    }
    if (telasVis.length) {
      if (gruposVis.length) partes.push('<div class="bulk-picker-head">Telas</div>');
      partes.push(telasVis.map(linhaTela).join(''));
    }
    if (!partes.length) {
      partes.push(`<div class="bulk-picker-empty">${esc('Nenhuma tela ou grupo com esse nome')}</div>`);
    }

    resultados.innerHTML = `${partes.join('')}
      <div class="bulk-picker-foot">
        <button type="button" class="btn btn-primary btn-sm" id="enviarTelaGo" ${total() ? '' : 'disabled'}>
          ${esc(rotuloDoBotao())}
        </button>
      </div>`;
  }

  input.oninput = () => { if (resultados.hidden) abrir(); else desenhar(); };
  input.onfocus = abrir;
  input.onkeydown = (e) => { if (e.key === 'Escape') { fechar(); input.blur(); } };

  resultados.onchange = (e) => {
    const cx = e.target.closest('[data-tela], [data-grupo]');
    if (!cx) return;
    const alvo = cx.dataset.tela ? telasMarcadas : gruposMarcados;
    const id = cx.dataset.tela || cx.dataset.grupo;
    if (cx.checked) alvo.add(id); else alvo.delete(id);
    // Só o botão muda; redesenhar as linhas aqui brigaria com a caixa que acabou de ser clicada.
    const go = resultados.querySelector('#enviarTelaGo');
    if (go) { go.disabled = total() === 0; go.textContent = rotuloDoBotao(); }
  };

  resultados.onclick = async (e) => {
    if (!e.target.closest('#enviarTelaGo') || !total()) return;
    const corpo = {
      device_ids: [...telasMarcadas],
      group_ids: [...gruposMarcados],
      ...itens,
    };
    fechar();
    input.disabled = true;
    try {
      const r = await api.batchAssign(corpo);
      /*
       * Conta em TELAS, e não em grupos: um grupo de quatro telas que recebe dois arquivos põe
       * oito coisas no ar, e é esse número que descreve o que aconteceu. E diz que já está
       * exibindo — porque a tela é dona do próprio espaço e não tem passo de publicar.
       */
      showToast(
        `${r.postos} item(ns) em ${r.telas} tela(s) — já exibindo`,
        r.postos ? 'success' : 'info',
      );
      limparCacheDeTelas();
      if (aoEnviar) await aoEnviar(r);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      input.disabled = false;
    }
  };
}

/** O pedaço de HTML que a barra desenha. Aqui para os dois chamadores não escreverem dois. */
export function htmlSeletorDeTelas(placeholder = 'Enviar para tela…') {
  return `<span class="bulk-picker">
      <input type="text" id="enviarTelaInput" class="input btn-sm" autocomplete="off"
        placeholder="${esc(placeholder)}" style="width:230px;background:var(--bg-input)">
      <div id="enviarTelaResultados" class="bulk-picker-results" hidden></div>
    </span>`;
}
