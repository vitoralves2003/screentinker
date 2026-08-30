'use strict';

/*
 * <loop-settings-tabs> — A FILEIRA DE ABAS. Uma só, na mesma ordem, nos dois módulos.
 *
 * ── O DEFEITO QUE ISTO FECHA ─────────────────────────────────────────────────────────────
 * O servidor já dizia QUAIS abas existem (server/routes/configuracoes.js), e mesmo assim a
 * fileira era diferente conforme o lado de onde se olhava:
 *
 *     Operação   Conta · Registro · Empresa · Serviços · … · Assinatura · Pessoas
 *     Gestão     Empresa · Serviços · … · Assinatura · Pessoas  |  Conta
 *
 * Não era descuido. Os dois lados faziam a MESMA coisa: `filter(modulo === o meu)` virava aba,
 * `filter(o outro)` virava link no fim. Cada um punha os seus primeiro, e a ordem servida nunca
 * era respeitada COMO FILEIRA. Clicar em "Empresa" na Operação atravessava para a Gestão — e lá
 * a fileira estava em outra ordem. Não havia patch: era o que o desenho produzia.
 *
 * ── O QUE MUDA ───────────────────────────────────────────────────────────────────────────
 * A fileira é desenhada INTEIRA por este componente, na ordem em que o servidor mandou, com
 * TODAS as abas presentes — as deste módulo e as do outro. Quem olha vê uma fileira só, igual,
 * esteja onde estiver. O que muda entre elas é apenas o que acontece ao clicar: aba deste
 * módulo troca o painel, aba do outro atravessa.
 *
 * ── O QUE ELE NÃO FAZ ────────────────────────────────────────────────────────────────────
 * Não busca a lista (quem tem sessão é o hospedeiro), não decide quem vê o quê (isso é do
 * servidor, por plano, por papel e — no registro de atividades — por ser dono da organização),
 * e não desenha o conteúdo de aba nenhuma. Ele desenha a fileira.
 */

/*
 * A PALETA, definida aqui em vez de herdada — e a razão é medida, não estética.
 *
 * Os dois aplicativos JÁ TÊM tokens para isto, e eles NÃO batem:
 *
 *     texto secundário   Operação #475569   Gestão #64748B
 *     borda              --border: rgba(15,23,42,.10)   --border-default: #E5EAF0
 *     acento             --accent-ink: #047857          --brand-primary: #00B978
 *
 * Herdar do hospedeiro daria uma fileira com cor diferente em cada módulo — exatamente o
 * defeito que este arquivo veio fechar, só que na cor em vez de na ordem. O Shadow DOM não
 * deixa o CSS de fora entrar, então estes valores são os valores.
 *
 * ── UM TEMA SÓ ───────────────────────────────────────────────────────────────────────────
 * Este arquivo nasceu com um segundo bloco de tokens e um atributo `tema="escuro"`, porque a
 * Gestão tinha modo escuro e a Operação não. Eu marquei aquilo como uma costura de produto por
 * decidir — e o Vitor decidiu no mesmo dia: claro para todos.
 *
 * Então não há segundo bloco. Estes são os valores, nos dois módulos, sempre.
 */
const ESTILO = `
  :host {
    display: block;
    font-family: 'Geist', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;

    --texto: #475569;
    --texto-forte: #0F172A;
    --acento: #047857;
    --borda: rgba(15, 23, 42, 0.10);
    --hover-bg: rgba(15, 23, 42, 0.04);
  }

  * { box-sizing: border-box; }

  /*
   * ROLA NA HORIZONTAL EM VEZ DE QUEBRAR EM DUAS LINHAS.
   *
   * São nove abas para um Master. Quebrando, a segunda linha fica órfã embaixo da borda e a
   * fileira deixa de parecer uma fileira; rolando, a ordem continua legível e o que não coube
   * continua alcançável. É o que a Operação já fazia.
   */
  nav {
    display: flex;
    gap: 4px;
    margin-bottom: 20px;
    border-bottom: 1px solid var(--borda);
    overflow-x: auto;
    scrollbar-width: thin;
  }
  nav::-webkit-scrollbar { height: 6px; }
  nav::-webkit-scrollbar-thumb { background: var(--borda); border-radius: 3px; }

  a.aba {
    background: none;
    border: 0;
    border-bottom: 2px solid transparent;
    color: var(--texto);
    padding: 10px 14px;
    font-size: 14px;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    white-space: nowrap;
    text-decoration: none;
    flex-shrink: 0;
    transition: color .15s, border-color .15s, background .15s;
  }
  a.aba:hover { color: var(--texto-forte); background: var(--hover-bg); }

  /*
   * A ABA ABERTA é marcada por aria-current, e não por uma classe .active.
   *
   * O atributo diz a mesma coisa ao CSS e a um leitor de tela, de uma vez. A classe dizia só ao
   * CSS, e a fileira antiga não anunciava nada a quem navega por teclado.
   */
  a.aba[aria-current='page'] {
    color: var(--acento);
    border-bottom-color: var(--acento);
  }

  /*
   * A ABA DO OUTRO MÓDULO NÃO É MARCADA DE FORMA DIFERENTE, e isso é a decisão central deste
   * arquivo.
   *
   * A versão anterior separava com um divisor e desenhava as de fora como links soltos — o que
   * ANUNCIAVA a costura entre os dois sistemas justamente para quem não deveria saber que são
   * dois. Para quem usa, "Empresa" e "Conta" são duas configurações da mesma conta; que uma
   * seja desenhada por outro servidor é assunto nosso.
   *
   * O que muda é o cursor de espera enquanto a travessia acontece — ver ocupar.
   */

  a.aba[data-ocupada] { opacity: .6; cursor: progress; }

  :focus-visible { outline: 2px solid var(--acento); outline-offset: -2px; border-radius: 4px; }

  @media (prefers-reduced-motion: reduce) {
    a.aba { transition: none; }
  }
`;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

class LoopSettingsTabs extends HTMLElement {
  static get observedAttributes() { return ['modulo', 'ativa']; }

  constructor() {
    super();
    this._abas = null;
    this.attachShadow({ mode: 'open' });
  }

  /*
   * A LISTA, como propriedade e não atributo: é um vetor de objetos. Vem de GET /api/configuracoes
   * na Operação, ou do proxy da Gestão — o hospedeiro busca, porque é ele que tem a sessão.
   */
  set abas(v) { this._abas = Array.isArray(v) ? v : null; this._desenhar(); }
  get abas() { return this._abas; }

  connectedCallback() { this._desenhar(); }
  attributeChangedCallback() { this._desenhar(); }

  /*
   * "Abrindo…" enquanto a travessia acontece.
   *
   * Atravessar para o outro módulo é uma navegação de verdade e pode demorar um instante; sem
   * sinal nenhum o clique parece não ter funcionado e a pessoa clica de novo. O texto vive
   * dentro do Shadow DOM, então o hospedeiro não o alcança: pede por aqui.
   *
   * Devolve a função que desfaz, para quem chama não precisar guardar o que estava escrito.
   */
  ocupar(id) {
    const el = this.shadowRoot && this.shadowRoot.querySelector(`a.aba[data-id="${id}"]`);
    if (!el) return () => {};
    el.setAttribute('data-ocupada', '');
    return () => el.removeAttribute('data-ocupada');
  }

  _desenhar() {
    if (!this.shadowRoot) return;

    const abas = this._abas;
    const meuModulo = this.getAttribute('modulo') || '';
    const ativa = this.getAttribute('ativa') || '';

    /*
     * SEM LISTA, NÃO DESENHA NADA — nem uma fileira de reserva.
     *
     * A tentação é cair numa lista fixa para a tela não piscar vazia. Mas uma lista escrita
     * aqui é uma SEGUNDA lista, e uma segunda lista é o defeito inteiro: ela concorda hoje e
     * diverge no dia em que alguém mexer só na do servidor. O hospedeiro segura o desenho até
     * a resposta chegar.
     */
    if (!abas || !abas.length) {
      this.shadowRoot.innerHTML = `<style>${ESTILO}</style>`;
      return;
    }

    const itens = abas.map((a) => {
      const local = a.modulo === meuModulo;
      const atual = a.id === ativa ? ' aria-current="page"' : '';
      return `<a class="aba" href="${esc(a.href)}" data-id="${esc(a.id)}"`
        + ` data-modulo="${esc(a.modulo || '')}" data-local="${local ? '1' : '0'}"${atual}>`
        + `${esc(a.rotulo)}</a>`;
    }).join('');

    this.shadowRoot.innerHTML = `<style>${ESTILO}</style><nav aria-label="Configurações">${itens}</nav>`;

    /*
     * ÂNCORA DE VERDADE, e o hospedeiro decide se assume.
     *
     * As abas são <a href> reais para que clique do meio, "abrir em nova aba" e teclado
     * funcionem sem este componente reimplementar cada um. O evento `trocar` é cancelável: se
     * o hospedeiro chamar preventDefault (para trocar o painel sem recarregar), seguramos o
     * clique; se ninguém assumir, o navegador segue o href — que é o certo para as abas do
     * outro módulo.
     *
     * Modificadores de teclado passam direto: quem segurou Ctrl quer uma aba nova do navegador,
     * não uma troca de painel.
     */
    this.shadowRoot.querySelectorAll('a.aba').forEach((a) => {
      a.addEventListener('click', (ev) => {
        if (ev.defaultPrevented) return;
        if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0) return;
        const e = new CustomEvent('trocar', {
          detail: {
            id: a.dataset.id,
            href: a.getAttribute('href'),
            modulo: a.dataset.modulo || null,
            local: a.dataset.local === '1',
          },
          bubbles: true, composed: true, cancelable: true,
        });
        if (!this.dispatchEvent(e)) ev.preventDefault();
      });
    });
  }
}

if (!customElements.get('loop-settings-tabs')) {
  customElements.define('loop-settings-tabs', LoopSettingsTabs);
}
