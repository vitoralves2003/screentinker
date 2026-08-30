'use strict';

/*
 * <loop-sidebar> — A BARRA. Uma só, para os dois módulos.
 *
 * ── POR QUE ISTO EXISTE ──────────────────────────────────────────────────────────────────
 * A Fase anterior fez o servidor dizer QUAIS itens existem (server/routes/menu.js), e a barra
 * continuou sendo duas: a Operação desenhava em HTML + 66 regras de CSS, a Gestão em React
 * (app-shell.tsx, 1417 linhas). Tudo o que a lista servida não ditava era decidido duas vezes
 * — e divergia. O que o Vitor viu na tela, lado a lado:
 *
 *     nome do lugar    "Vitor"  ×  "Vitor's organization"
 *     papel            "user"   ×  "TITULAR"
 *     logotipo, caixa do workspace, onde a pílula quebra a linha: tudo diferente
 *
 * Lista compartilhada é necessária e não é suficiente. Enquanto houver dois desenhistas, cada
 * pixel é decidido duas vezes, e consertar divergência a divergência nunca converge — foi o
 * que eu tentei, e é por isso que este arquivo existe.
 *
 * ── POR QUE UM WEB COMPONENT, E NÃO UMA REESCRITA ────────────────────────────────────────
 * Um custom element em JS puro monta nos dois mundos: a Operação põe a tag no HTML, a Gestão
 * a monta dentro do React. E o Shadow DOM isola o CSS — nem o main.css daqui nem o Tailwind de
 * lá alcançam o que está aqui dentro. É o que torna a divergência IMPOSSÍVEL, e não só
 * improvável. As 24 views e as 32 mil linhas da Operação não são tocadas.
 *
 * ── O QUE ESTE COMPONENTE NÃO FAZ ────────────────────────────────────────────────────────
 * NÃO BUSCA O MENU. Quem busca é o hospedeiro, que é quem tem a sessão: a Operação com o token
 * dela, a Gestão pela API dela. Buscar aqui exigiria que o componente conhecesse dois esquemas
 * de autenticação, e a barra passaria a ser um lugar onde credencial mora.
 *
 * NÃO DECIDE NAVEGAÇÃO. Emite `navegar` e deixa o hospedeiro escolher: a Gestão chama
 * router.push (rota do lado do cliente), a Operação escreve no hash. É a única coisa
 * genuinamente diferente entre os dois, e são três linhas de cada lado.
 *
 * NÃO DECIDE QUEM VÊ O QUÊ. Isso já é do servidor, item por item, por plano e por papel.
 *
 * ── COMO SE USA ──────────────────────────────────────────────────────────────────────────
 *     const barra = document.querySelector('loop-sidebar');
 *     barra.menu = payload;                     // de GET /api/menu (ou do proxy da Gestão)
 *     barra.setAttribute('nome', 'Vitor');      // a pessoa, da sessão do hospedeiro
 *     barra.setAttribute('config-href', '#/settings');
 *     barra.addEventListener('navegar', (e) => { ... e.preventDefault() para assumir ... });
 *     barra.addEventListener('sair', () => { ... });
 */

const CHAVE_RECOLHIDA = 'loop_os_sidebar_collapsed'; // a MESMA chave dos dois lados

const LARGURA_ABERTA = '232px';
const LARGURA_RECOLHIDA = '72px';

/*
 * A PALETA, copiada de variables.css e fixada aqui.
 *
 * Fixada, e não herdada, de propósito: herdar traria de volta exatamente o problema que este
 * arquivo fecha — dois conjuntos de variáveis, um por aplicativo, livres para divergir. O
 * Shadow DOM não deixa o CSS de fora entrar, então estes valores são os valores, nos dois.
 *
 * A fonte também. A divergência tipográfica real deste produto não era Geist × Geist: era a
 * Gestão baixando Geist e renderizando Arial, contra o Segoe UI da Operação. Uma pilha
 * declarada aqui não tem como ser duas.
 */
const ESTILO = `
  :host {
    display: block;
    width: ${LARGURA_ABERTA};
    flex-shrink: 0;
    height: 100vh;
    height: 100dvh;
    position: sticky;
    top: 0;
    box-sizing: border-box;
    transition: width .18s ease;

    --bg: #031525;
    --texto: #94A3B8;
    --texto-forte: #FFFFFF;
    --texto-fraco: #748499;
    --marca: #20DF91;
    --ativo-bg: rgba(32, 223, 145, 0.10);
    --hover-bg: rgba(255, 255, 255, 0.06);
    --borda: rgba(148, 163, 184, 0.10);
    --perigo: #EF4444;
    --transicao: .18s ease;

    font-family: 'Geist', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
    line-height: 1.4;
  }

  :host([recolhida]) { width: ${LARGURA_RECOLHIDA}; }

  * { box-sizing: border-box; }

  nav {
    height: 100%;
    background: var(--bg);
    color: var(--texto);
    border-right: 1px solid var(--borda);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── topo ───────────────────────────────────────────────────────────────────── */
  .topo { padding: 28px 18px 0; }

  .logo {
    display: flex; align-items: center; justify-content: center;
    height: 96px;
  }
  .logo img {
    width: 58%; max-width: 140px; max-height: 44px; height: auto;
    object-fit: contain; display: block;
    transition: transform var(--transicao);
  }
  .logo img:hover { transform: scale(1.04); }
  /* Em 72px a palavra "Loop Player" (4,2:1) não cabe; o símbolo cabe. */
  :host([recolhida]) .logo { height: 64px; }
  :host([recolhida]) .logo img { width: 32px; max-width: 32px; }

  /*
   * DE QUEM É ESTA TELA.
   *
   * O rótulo diz "CLIENTE" e não "WORKSPACE": workspace deixou de ser um conceito do produto
   * (decisão do Vitor — um cliente é uma operação), e o nome que aparece aqui é o da
   * organização, que é a razão social do contrato e da fatura.
   *
   * Em VERMELHO quando é acesso de suporte. Um administrador de plataforma alcança o tenant de
   * um cliente e passa a ver contratos e dinheiro que não são dele; sem um lugar na tela
   * dizendo de quem é, o erro que isso produz não é uma tela errada, é uma decisão tomada
   * sobre o cliente errado.
   */
  .lugar {
    margin-top: 16px;
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--hover-bg);
    border: 1px solid var(--borda);
  }
  .lugar .rotulo {
    font-size: 9.5px; letter-spacing: .14em; text-transform: uppercase;
    color: var(--texto-fraco); margin-bottom: 2px;
  }
  .lugar .nome {
    font-size: 13px; font-weight: 500; color: var(--texto-forte);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .lugar[data-suporte='1'] {
    background: rgba(239, 68, 68, .10);
    border-color: rgba(239, 68, 68, .34);
  }
  .lugar[data-suporte='1'] .rotulo { color: var(--perigo); }

  /* ── pílula de atenção ──────────────────────────────────────────────────────── */
  /*
   * Uma frase, não um distintivo. E some por completo quando nada está errado: um indicador
   * permanente deixa de ser visto, e a noite em que uma tela morre é a noite que importa.
   *
   * Aponta para o RECORTE (?f=atencao), não para a lista inteira: ela já respondeu "quais
   * duas", e mandar para uma página com quarenta devolveria a pergunta ao leitor.
   */
  .atencao {
    display: flex; align-items: center; gap: 8px;
    margin: 14px 18px 0; padding: 8px 10px;
    border-radius: 8px;
    background: rgba(239, 68, 68, .10);
    border: 1px solid rgba(239, 68, 68, .28);
    color: var(--perigo);
    font-size: 12px; font-weight: 500; text-decoration: none;
  }
  .atencao .ponto {
    width: 6px; height: 6px; border-radius: 50%;
    background: currentColor; flex-shrink: 0;
  }
  :host([recolhida]) .atencao {
    margin: 14px 12px 0; justify-content: center; padding: 8px 0;
  }
  :host([recolhida]) .atencao .texto { display: none; }

  /* ── lista ──────────────────────────────────────────────────────────────────── */
  .lista { flex: 1; padding: 12px 8px; overflow-y: auto; overflow-x: hidden; min-height: 0; }
  .lista::-webkit-scrollbar { width: 6px; }
  .lista::-webkit-scrollbar-thumb { background: var(--borda); border-radius: 3px; }

  .secao {
    padding: 16px 12px 5px;
    font-size: 9.5px; letter-spacing: .14em; text-transform: uppercase;
    color: var(--texto-fraco);
  }
  :host([recolhida]) .secao { visibility: hidden; height: 12px; padding: 6px 0 0; }

  .risco { height: 1px; margin: 10px 12px 6px; background: rgba(255,255,255,.08); }

  a.item {
    display: flex; align-items: center; gap: 16px;
    height: 48px; padding: 0 12px; margin-bottom: 2px;
    border-radius: 12px;
    color: var(--texto); text-decoration: none;
    font-size: 14px; font-weight: 500;
    transition: background var(--transicao), color var(--transicao);
  }
  a.item:hover { background: var(--hover-bg); color: var(--texto-forte); }
  /*
   * O ativo é uma LAVAGEM de verde a 10%, não um bloco sólido: numa barra escura um preenchimento
   * saturado vira a coisa mais barulhenta da tela e puxa o olho para longe do conteúdo que ele
   * está apontando.
   */
  a.item[aria-current='page'] { background: var(--ativo-bg); color: var(--texto-forte); }
  a.item svg { flex-shrink: 0; color: var(--texto-fraco); transition: color var(--transicao); }
  a.item:hover svg { color: var(--texto-forte); }
  a.item[aria-current='page'] svg { color: var(--marca); }

  /* O rótulo some por LARGURA, não por display:none — assim a transição acontece. */
  a.item .texto {
    overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
    transition: max-width var(--transicao), opacity var(--transicao);
    max-width: 160px; opacity: 1;
  }
  :host([recolhida]) a.item { justify-content: center; gap: 0; }
  :host([recolhida]) a.item .texto { max-width: 0; opacity: 0; }

  /* ── rodapé ─────────────────────────────────────────────────────────────────── */
  .rodape { padding: 8px; border-top: 1px solid var(--borda); }

  .recolher {
    display: flex; align-items: center; justify-content: flex-end;
    width: 100%; padding: 8px 12px 4px;
    background: none; border: 0; cursor: pointer;
    color: var(--texto-fraco);
    transition: color var(--transicao);
  }
  .recolher:hover { color: var(--texto-forte); }
  :host([recolhida]) .recolher { justify-content: center; }
  :host([recolhida]) .recolher svg { transform: rotate(180deg); }

  .pessoa {
    display: flex; align-items: center; gap: 8px;
    padding: 12px 10px 4px;
    border-top: 1px solid var(--borda);
    margin-top: 4px;
  }
  .pessoa .avatar {
    width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0;
    background: var(--marca); color: #062017;
    display: flex; align-items: center; justify-content: center;
    font-size: 12px; font-weight: 600;
    object-fit: cover;
  }
  .pessoa .quem { flex: 1; min-width: 0; transition: max-width var(--transicao), opacity var(--transicao); max-width: 140px; }
  .pessoa .nome {
    font-size: 12px; font-weight: 500; color: var(--texto-forte);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .pessoa .papel { font-size: 10px; color: var(--texto-fraco); }
  .pessoa button {
    flex-shrink: 0; background: none; border: 0; padding: 6px;
    border-radius: 6px; cursor: pointer; color: var(--texto-fraco);
    display: flex; transition: color var(--transicao), background var(--transicao);
  }
  .pessoa button:hover { color: var(--texto-forte); background: var(--hover-bg); }

  :host([recolhida]) .lugar,
  :host([recolhida]) .pessoa .quem { max-width: 0; opacity: 0; overflow: hidden; padding-left: 0; padding-right: 0; border-width: 0; }
  :host([recolhida]) .pessoa { justify-content: center; }

  :focus-visible { outline: 2px solid var(--marca); outline-offset: 2px; }

  /*
   * MÓVEL: a barra vira gaveta — mas só onde o hospedeiro já tinha gaveta.
   *
   * ── A COSTURA, DECLARADA ─────────────────────────────────────────────────────────────────
   * Este é o único lugar deste arquivo onde os dois módulos ainda diferem, e a diferença não é
   * de desenho: é de CHROME. A Operação tem uma barra superior com hambúrguer no celular
   * (#mobileMenuBtn), e por isso a barra pode virar gaveta — há como reabri-la. A Gestão não
   * tem hambúrguer nenhum: no celular ela usa o próprio recolher, virando trilho de ícones.
   *
   * Virar gaveta lá deixaria a barra fechada SEM PORTA — nada na tela a traria de volta. Então
   * movel preserva o que cada um já tem:
   *
   *     movel="gaveta"  (padrão)  fecha para fora da tela; precisa de um hambúrguer
   *     movel="trilho"            continua trilho de ícones, como no computador
   *
   * A SAÍDA está nomeada: dar à Gestão a mesma barra superior com hambúrguer, e então apagar
   * este atributo e este bloco. É trabalho de produto — uma peça de interface que não existe —
   * e não uma divergência de renderização, que é o que esta etapa veio fechar. Fazê-lo aqui,
   * de contrabando, seria acrescentar tela nova no meio de um conserto.
   *
   * RECOLHER DEIXA DE EXISTIR na gaveta: numa barra que se abre por cima do conteúdo,
   * "estreita" não quer dizer nada — ela é a tela inteira ou nenhuma. O estado guardado
   * permanece (a pessoa volta ao computador e encontra como deixou), só não se aplica.
   *
   * Por isso o bloco repete os seletores de [recolhida] desfazendo-os, em vez de mexer nos de
   * cima: têm a mesma especificidade e este vem depois, então ganha — e quem ler os de cima
   * continua vendo a regra do computador inteira, num lugar só.
   */
  @media (max-width: 768px) {
    :host(:not([movel='trilho'])),
    :host(:not([movel='trilho'])[recolhida]) {
      position: fixed; left: 0; top: 0; z-index: 150;
      width: ${LARGURA_ABERTA};
      transform: translateX(-100%);
      transition: transform .3s ease;
    }
    :host(:not([movel='trilho'])[aberta]) { transform: translateX(0); }

    :host(:not([movel='trilho'])) .recolher { display: none; }
    :host(:not([movel='trilho'])[recolhida]) .logo { height: 96px; }
    :host(:not([movel='trilho'])[recolhida]) .logo img { width: 58%; max-width: 140px; }
    :host(:not([movel='trilho'])[recolhida]) .lugar {
      max-width: none; opacity: 1; overflow: visible;
      padding: 10px 12px; border-width: 1px;
    }
    :host(:not([movel='trilho'])[recolhida]) .atencao { margin: 14px 18px 0; justify-content: flex-start; padding: 8px 10px; }
    :host(:not([movel='trilho'])[recolhida]) .atencao .texto { display: inline; }
    :host(:not([movel='trilho'])[recolhida]) .secao { visibility: visible; height: auto; padding: 16px 12px 5px; }
    :host(:not([movel='trilho'])[recolhida]) a.item { justify-content: flex-start; gap: 16px; }
    :host(:not([movel='trilho'])[recolhida]) a.item .texto { max-width: 160px; opacity: 1; }
    :host(:not([movel='trilho'])[recolhida]) .pessoa { justify-content: flex-start; }
    :host(:not([movel='trilho'])[recolhida]) .pessoa .quem { max-width: 140px; opacity: 1; overflow: hidden; }

    a.item { min-height: 44px; }
  }

  @media (prefers-reduced-motion: reduce) {
    :host, a.item, a.item .texto, .pessoa .quem, .recolher svg, .logo img { transition: none; }
  }
`;

// O ícone de Configurações. É o único desenhado aqui: todos os outros vêm carimbados no menu
// servido (TRACO, em routes/menu.js), e Configurações fica de fora da lista de propósito por
// ser rota LOCAL de cada módulo. Ver a nota no cabeçalho do menu.js.
const ICONE_CONFIG = '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>';

const ICONE_SAIR = '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

class LoopSidebar extends HTMLElement {
  static get observedAttributes() {
    return ['nome', 'avatar', 'ativo', 'config-href', 'assets'];
  }

  constructor() {
    super();
    this._menu = null;
    this._rotulos = null;
    this.attachShadow({ mode: 'open' });
  }

  /*
   * O MENU vem do hospedeiro, como propriedade e não como atributo: é um objeto, e serializar
   * o payload inteiro para dentro de um atributo HTML seria trocar uma referência por uma
   * string de alguns kilobytes a cada render.
   */
  set menu(v) { this._menu = v || null; this._desenhar(); }
  get menu() { return this._menu; }

  /*
   * RÓTULOS TRADUZIDOS, quando o hospedeiro tem tradução — um mapa id → texto.
   *
   * Existe para NÃO REGREDIR algo que já funcionava: a Operação traduz a barra em sete idiomas
   * (i18n/, e renderNavLabels em app.js sobrescrevia os rótulos servidos). Passar a desenhar a
   * partir do menu, sem isto, faria a barra falar português para quem escolheu inglês.
   *
   * O rótulo servido é o padrão, e este mapa só o substitui onde existe tradução. A Gestão não
   * passa nada — ela é só pt-BR — e em pt-BR os dois textos são os MESMOS: 'nav.displays' em
   * i18n/pt.js é 'Telas', que é exatamente o que routes/menu.js manda. Conferido antes de
   * escolher este caminho, porque duas fontes de rótulo que discordam seriam a divergência de
   * volta, agora em cima da palavra.
   *
   * A costura fica visível no dia em que a Gestão ganhar seletor de idioma. Aí a resposta é o
   * servidor mandar o rótulo já traduzido, e este mapa sair. Não antes: hoje isso seria uma
   * camada de i18n no servidor para nenhum usuário.
   */
  set rotulos(v) { this._rotulos = v || null; this._desenhar(); }
  get rotulos() { return this._rotulos; }

  connectedCallback() {
    /*
     * O ESTADO RECOLHIDO É COMPARTILHADO, e é por isso que a leitura acontece aqui e não no
     * construtor: os dois módulos estão na mesma origem desde a Fase B, então o localStorage é
     * o mesmo. Recolher num e atravessar chega no outro já recolhido.
     *
     * Em try/catch porque um navegador com dados de site bloqueados LANÇA ao acessar
     * localStorage — e uma barra que não carrega é bem pior que uma barra que não lembra.
     */
    try {
      if (localStorage.getItem(CHAVE_RECOLHIDA) === 'true') this.setAttribute('recolhida', '');
    } catch (e) { /* segue aberta */ }
    this._desenhar();
  }

  attributeChangedCallback() { this._desenhar(); }

  _recolher() {
    const agora = !this.hasAttribute('recolhida');
    this.toggleAttribute('recolhida', agora);
    try { localStorage.setItem(CHAVE_RECOLHIDA, String(agora)); } catch (e) { /* não lembra */ }
    this.dispatchEvent(new CustomEvent('recolher', { detail: { recolhida: agora }, bubbles: true }));
    this._desenhar();
  }

  /*
   * QUAL ITEM ESTÁ ABERTO.
   *
   * O atributo `ativo` ganha quando o hospedeiro o define — ele conhece a própria rota melhor
   * do que qualquer heurística. Sem ele, casa pelo href: comparar o endereço do item com o da
   * janela funciona nos dois módulos sem que nenhum precise traduzir rota para id de item.
   */
  _estaAtivo(item) {
    const dito = this.getAttribute('ativo');
    if (dito) return item.id === dito;
    if (!item.href) return false;
    try {
      const alvo = new URL(item.href, location.href);
      if (alvo.pathname !== location.pathname) return false;
      return alvo.hash ? alvo.hash === location.hash : !location.hash || location.hash === '#/';
    } catch (e) {
      return false;
    }
  }

  /*
   * "Abrindo…" enquanto uma travessia acontece.
   *
   * Atravessar para a Gestão pede um token de troca ao servidor antes de sair da página, e sem
   * sinal nenhum o clique parece não ter funcionado — a pessoa clica de novo. O texto vive
   * dentro do Shadow DOM, então o hospedeiro não o alcança: pede por aqui.
   *
   * Devolve a função que desfaz, em vez de exigir uma segunda chamada com o texto original.
   * Quem chama não precisa guardar o que estava escrito, e não há como restaurar errado.
   */
  ocupar(id, texto) {
    const el = this.shadowRoot && this.shadowRoot.querySelector(`a[data-id="${id}"] .texto`);
    if (!el) return () => {};
    const antes = el.textContent;
    el.textContent = texto;
    return () => { el.textContent = antes; };
  }

  _item(it) {
    const icone = it.icone
      ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${it.icone}</svg>`
      : '<svg width="18" height="18" aria-hidden="true"></svg>';
    const atual = this._estaAtivo(it) ? ' aria-current="page"' : '';
    const rotulo = (this._rotulos && this._rotulos[it.id]) || it.rotulo;
    return `<a class="item" href="${esc(it.href)}" data-id="${esc(it.id)}" data-modulo="${esc(it.modulo || '')}"${atual}>`
      + icone + `<span class="texto">${esc(rotulo)}</span></a>`;
  }

  _desenhar() {
    if (!this.shadowRoot) return;
    const m = this._menu;
    const assets = this.getAttribute('assets') || '/assets';
    const recolhida = this.hasAttribute('recolhida');
    /*
     * No móvel a barra é gaveta e nunca fica estreita (ver o @media lá em cima), então o
     * símbolo daria uma marca cortada numa barra de largura inteira. A pergunta é feita ao
     * navegador em vez de deduzida da largura da janela, para casar exatamente com o mesmo
     * ponto de quebra que o CSS usa — dois números que precisam concordar acabam discordando.
     */
    const estreitavel = !(window.matchMedia && window.matchMedia('(max-width: 768px)').matches);
    const logo = (recolhida && estreitavel) ? 'loop-player-symbol.png' : 'loop-player-logo.png';

    /*
     * SEM MENU, A BARRA NÃO INVENTA NADA. Desenha a moldura e espera.
     *
     * O contrário — cair para uma lista escrita aqui — é literalmente o defeito que este
     * arquivo veio encerrar: uma segunda lista, que concorda hoje e diverge depois.
     */
    const secoes = (m && Array.isArray(m.secoes)) ? m.secoes : [];
    const transversais = (m && Array.isArray(m.transversais)) ? m.transversais : [];
    const rodape = (m && Array.isArray(m.rodape)) ? m.rodape : [];
    const lugar = m && m.lugar;
    const atencao = (m && Number(m.atencao_telas)) || 0;
    const papel = (m && m.usuario && m.usuario.papel_rotulo) || '';
    const inicio = (m && m.inicio) || '#/';

    const nome = this.getAttribute('nome') || '';
    const avatar = this.getAttribute('avatar') || '';
    const configHref = this.getAttribute('config-href') || '';

    const corpo = secoes.map((s) => {
      const titulo = s.titulo ? `<div class="secao">${esc(s.titulo)}</div>` : '';
      return titulo + (s.itens || []).map((i) => this._item(i)).join('');
    }).join('');

    // A linha antes dos transversais (Relatórios, e Administração para a plataforma). Eles não
    // pertencem a módulo nenhum, e a linha diz isso sem precisar de rótulo.
    const trans = transversais.length
      ? '<div class="risco"></div>' + transversais.map((i) => this._item(i)).join('')
      : '';

    const config = configHref
      ? this._item({ id: 'configuracoes', rotulo: 'Configurações', href: configHref, icone: ICONE_CONFIG })
      : '';

    this.shadowRoot.innerHTML = `
      <style>${ESTILO}</style>
      <nav aria-label="Navegação principal">
        <div class="topo">
          <a class="logo" href="${esc(inicio)}" data-id="inicio" aria-label="Loop Player">
            <img src="${esc(assets)}/${logo}" alt="Loop Player">
          </a>
          ${lugar && lugar.nome ? `
            <div class="lugar" data-suporte="${lugar.suporte ? '1' : '0'}">
              <div class="rotulo">${lugar.suporte ? 'Suporte a' : 'Cliente'}</div>
              <div class="nome" title="${esc(lugar.nome)}">${esc(lugar.nome)}</div>
            </div>` : ''}
        </div>

        ${atencao > 0 ? `
          <a class="atencao" href="${esc(this._hrefAtencao())}" data-id="atencao">
            <span class="ponto"></span>
            <span class="texto">${atencao} tela${atencao > 1 ? 's' : ''} precisa${atencao > 1 ? 'm' : ''} de atenção</span>
          </a>` : ''}

        <div class="lista">${corpo}${trans}</div>

        <div class="rodape">
          ${config}
          ${rodape.map((i) => this._item(i)).join('')}
          <button class="recolher" type="button"
                  aria-label="${recolhida ? 'Expandir a barra lateral' : 'Recolher a barra lateral'}"
                  aria-expanded="${recolhida ? 'false' : 'true'}">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
          ${nome ? `
            <div class="pessoa">
              ${avatar
                ? `<img class="avatar" src="${esc(avatar)}" alt="">`
                : `<div class="avatar" aria-hidden="true">${esc(nome.trim().charAt(0).toUpperCase())}</div>`}
              <div class="quem">
                <div class="nome" title="${esc(nome)}">${esc(nome)}</div>
                <div class="papel">${esc(papel)}</div>
              </div>
              <button class="sair" type="button" title="Sair" aria-label="Sair">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${ICONE_SAIR}</svg>
              </button>
            </div>` : ''}
        </div>
      </nav>
    `;

    this.shadowRoot.querySelector('.recolher').addEventListener('click', () => this._recolher());
    const sair = this.shadowRoot.querySelector('.sair');
    if (sair) sair.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('sair', { bubbles: true, composed: true }));
    });

    /*
     * NAVEGAÇÃO: âncora de verdade, e o hospedeiro decide se assume.
     *
     * Os itens são <a href> reais — não <div> com onclick — para que clique do meio, "abrir em
     * nova aba" e teclado funcionem sem que este componente precise reimplementar cada um.
     *
     * O evento `navegar` é cancelável: se o hospedeiro chamar preventDefault (a Gestão, para
     * usar router.push), seguramos o clique; se ninguém assumir, o navegador segue o href —
     * que é o certo para os itens do OUTRO módulo, onde atravessar é o comportamento correto.
     *
     * Modificadores de teclado passam direto: quem segurou Ctrl quer uma aba nova, não uma
     * rota do lado do cliente.
     */
    this.shadowRoot.querySelectorAll('a[href]').forEach((a) => {
      a.addEventListener('click', (ev) => {
        if (ev.defaultPrevented) return;
        if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0) return;
        const detalhe = {
          id: a.dataset.id || null,
          href: a.getAttribute('href'),
          modulo: a.dataset.modulo || null,
        };
        const e = new CustomEvent('navegar', {
          detail: detalhe, bubbles: true, composed: true, cancelable: true,
        });
        const seguiu = this.dispatchEvent(e);
        if (!seguiu) ev.preventDefault();
      });
    });
  }

  /*
   * Para onde a pílula leva. Sai do próprio menu — o item "telas" já traz o endereço da lista,
   * e o recorte é um parâmetro dele. Montar '/app#/devices?f=atencao' aqui faria este arquivo
   * conhecer a estrutura de rotas da Operação, que é justamente o que o menu servido existe
   * para não obrigar ninguém a conhecer.
   */
  _hrefAtencao() {
    const secoes = (this._menu && this._menu.secoes) || [];
    for (const s of secoes) {
      for (const i of (s.itens || [])) {
        if (i.id === 'telas' && i.href) return i.href + (i.href.includes('?') ? '&' : '?') + 'f=atencao';
      }
    }
    return '#/';
  }
}

if (!customElements.get('loop-sidebar')) {
  customElements.define('loop-sidebar', LoopSidebar);
}
