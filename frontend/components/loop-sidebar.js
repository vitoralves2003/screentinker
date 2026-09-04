'use strict';

/*
 * TUDO DENTRO DE UMA FUNCAO, e isto nao e estilo: e o que faz os dois componentes poderem
 * coexistir na mesma pagina.
 *
 * Eles sao carregados como <script> CLASSICO -- nao como modulo -- para que o elemento esteja
 * definido antes de qualquer view escrever a tag. Script classico compartilha o escopo global,
 * e os dois arquivos declaravam `const ESTILO` e `function esc` no topo.
 *
 * O segundo a carregar morria com "Identifier 'ESTILO' has already been declared", o elemento
 * dele nunca era definido, e a fileira de abas ficava vazia para sempre -- sem nada no
 * servidor para acusar.
 *
 * Envolver em funcao resolve de vez: o unico nome que sai daqui e o do custom element, que e
 * registrado pelo customElements e nao pelo escopo.
 */
(function () {

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

    /*
     * A BARRA SEGUE A IDENTIDADE (css/identidade.css), com queda para valores literais.
     *
     * O Shadow DOM nao deixa o CSS de FORA entrar, mas variaveis CSS ATRAVESSAM a fronteira
     * por herança -- e e so por isso que isto funciona. Se o hospedeiro nao carregar a
     * identidade (uma pagina antiga, um teste isolado), a queda depois da virgula mantem a
     * barra desenhada em vez de deixa-la sem cor.
     *
     * O verde-escuro do fundo (#0C1A15, e nao um preto neutro) e o que liga a barra ao resto:
     * ela e a unica peca que aparece nas telas dos DOIS modulos.
     */
    --bg: var(--lp-barra-fundo, #0C1A15);
    --texto: var(--lp-barra-texto, #9BAAA4);
    --texto-forte: var(--lp-barra-texto-forte, #FFFFFF);
    --texto-fraco: #748499;
    --marca: var(--lp-marca, #20DF91);
    --ativo-bg: var(--lp-barra-ativo, rgba(32, 223, 145, 0.12));
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
  /*
   * O contador do teste. Discreto de propósito: não é alerta, é informação de estado — e um
   * aviso gritado todo dia vira parte do móvel antes do dia em que ele importa.
   */
  .teste {
    padding: 6px 10px; margin: 0 2px 4px;
    font-size: 11px; line-height: 1.35; color: var(--texto-fraco);
    border: 1px solid var(--borda); border-radius: 6px;
  }
  .teste b { color: inherit; font-weight: 600; }
  /* Recolhida, a barra não tem largura para uma frase: some, e o título do <div> a guarda. */
  :host([recolhida]) .teste { display: none; }

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
   * ── A COSTURA SE FECHOU: a barra passou a trazer a própria porta (03/09) ─────────────────
   * Aqui havia um atributo 'movel', com dois modos, porque a diferença era de CHROME: a
   * Operação tinha um hambúrguer no celular (#mobileMenuBtn) e por isso a barra podia virar
   * gaveta; a Gestão não tinha nenhum, então fechá-la lá a deixaria SEM PORTA — nada na tela a
   * traria de volta. O modo 'trilho' existia só para evitar isso.
   *
   * O preço apareceu no celular do Vitor: em modo trilho a barra fica com 232px FIXOS, e num
   * aparelho de 390px isso é 60% da tela. O conteúdo ficava numa coluna de 158px, com o texto
   * quebrando de duas em duas palavras e a tabela cortada pela metade.
   *
   * A saída já estava nomeada aqui — "dar à Gestão a mesma barra superior com hambúrguer" —, e
   * o que mudou foi de quem é a peça: em vez de cada módulo trazer a sua, A BARRA TRAZ A
   * PRÓPRIA. Ela é quem sabe se está fechada, então é ela quem deve oferecer o jeito de abrir.
   * Assim os dois módulos ganham a gaveta sem que nenhum precise de tela nova, e o atributo
   * 'movel' deixa de ter razão de existir (é aceito e ignorado, para nada quebrar).
   *
   * O hambúrguer da Operação continua funcionando: ele mexe no atributo [aberta], e o botão
   * daqui mexe no mesmo. Dois controles, um estado.
   *
   * RECOLHER DEIXA DE EXISTIR na gaveta: numa barra que se abre por cima do conteúdo,
   * "estreita" não quer dizer nada — ela é a tela inteira ou nenhuma. O estado guardado
   * permanece (a pessoa volta ao computador e encontra como deixou), só não se aplica.
   *
   * Por isso o bloco repete os seletores de [recolhida] desfazendo-os, em vez de mexer nos de
   * cima: têm a mesma especificidade e este vem depois, então ganha — e quem ler os de cima
   * continua vendo a regra do computador inteira, num lugar só.
   */
  /*
   * O BOTÃO E O VÉU só existem no celular. No computador ficam fora da árvore de pintura
   * (display:none), então não custam nada nem podem ser tocados por engano.
   */
  /*
   * O BOTÃO, O VÉU E A BARRA DE BAIXO só existem no celular. No computador ficam fora da árvore
   * de pintura, então não custam nada nem podem ser tocados por engano.
   *
   * A BARRA INFERIOR ENTROU AQUI DEPOIS, e a falta dela custou caro: ela ganhava display dentro
   * do @media abaixo e nada a desligava fora dele, então no desktop o div continuava sendo um
   * bloco comum -- aparecia no TOPO da lateral, com 191px de altura quando recolhida, empurrando
   * o menu para baixo e levando o botão de expandir para y=1001 numa tela de 900.
   *
   * E ELA PRECISA FICAR ANTES DO @media, não depois. Regra fora de media e regra dentro dele têm
   * a mesma especificidade: quem vem por último vence. Na primeira tentativa eu a escrevi DEPOIS
   * e ela passou a esconder a barra no celular também -- 12 casos da prova do celular caíram de
   * uma vez. É a mesma armadilha que este comentário existe para descrever, cometida ao
   * descrevê-la.
   */
  .abrir, .veu, .inferior { display: none; }

  @media (max-width: 768px) {
    /*
     * QUEM DESLIZA É O <nav>, E NÃO O :host. A diferença não é de estilo — é o defeito.
     *
     * A primeira versão punha transform: translateX(-100%) no próprio host, com o botão de
     * abrir dentro do Shadow DOM. Um ancestral com 'transform' cria um bloco de contenção, e
     * então position: fixed passa a se ancorar NELE em vez da viewport: o botão saía junto com
     * a gaveta, medindo x = -220px. Estava visível, tinha 44px, e ficava fora da tela — o
     * Vitor abriu o celular e não achou como voltar ao menu.
     *
     * Agora o host não transforma nada: ele cobre a viewport sem ocupar espaço e sem receber
     * toque, e cada peça de dentro se ancora sozinha. O que desliza é só o painel.
     */
    :host, :host([recolhida]) {
      position: fixed; left: 0; right: 0; top: 0; z-index: 150;
      width: auto;
      /*
       * A ALTURA E DINAMICA, e nao "a tela inteira".
       *
       * Com inset: 0 o host media o LAYOUT viewport, que no Safari do iPhone NAO encolhe quando
       * as barras do navegador aparecem. A barra inferior, ancorada nele, ficava flutuando no
       * meio da pagina ao rolar ate o fim, com area em branco embaixo -- o Vitor fotografou.
       *
       * dvh acompanha a viewport VISUAL: encolhe e cresce junto com as barras do Safari. O vh
       * vem antes como reserva para quem nao conhece a unidade.
       */
      height: 100vh;
      height: 100dvh;
      transform: none;
      pointer-events: none;   /* o host é só um palco; quem recebe toque diz abaixo */
    }

    nav {
      position: fixed; left: 0; top: 0;
      width: ${LARGURA_ABERTA}; height: 100dvh;
      transform: translateX(-100%);
      transition: transform .3s ease;
      pointer-events: auto;
      z-index: 151;
    }
    :host([aberta]) nav { transform: translateX(0); }

    /* Recolher não quer dizer nada numa gaveta: ela é a tela inteira ou nenhuma. O estado
       guardado permanece (a pessoa volta ao computador e encontra como deixou), só não se
       aplica aqui -- por isso os seletores de [recolhida] são desfeitos, e não apagados. */
    .recolher { display: none; }
    :host([recolhida]) .logo { height: 96px; }
    :host([recolhida]) .logo img { width: 58%; max-width: 140px; }
    :host([recolhida]) .lugar {
      max-width: none; opacity: 1; overflow: visible;
      padding: 10px 12px; border-width: 1px;
    }
    :host([recolhida]) .atencao { margin: 14px 18px 0; justify-content: flex-start; padding: 8px 10px; }
    :host([recolhida]) .atencao .texto { display: inline; }
    :host([recolhida]) .secao { visibility: visible; height: auto; padding: 16px 12px 5px; }
    :host([recolhida]) a.item { justify-content: flex-start; gap: 16px; }
    :host([recolhida]) a.item .texto { max-width: 160px; opacity: 1; }
    :host([recolhida]) .pessoa { justify-content: flex-start; }
    :host([recolhida]) .pessoa .quem { max-width: 140px; opacity: 1; overflow: hidden; }

    /*
     * A PORTA. Fica FORA do :host quando a barra está fechada -- o host tem
     * transform: translateX(-100%), e um filho não escapa do transform do pai. Por isso o
     * botão é position: fixed E vive fora do <nav>, ancorado na viewport.
     *
     * 44px é o mínimo que um dedo acerta sem mirar (o alvo de toque das diretrizes de
     * acessibilidade), e o canto superior esquerdo é onde o polegar chega em qualquer mão.
     */
    /*
     * A BARRA INFERIOR — o padrão que todo aplicativo de celular usa, e pelo motivo certo:
     * os destinos principais ficam SEMPRE à vista, no arco onde o polegar chega sem que a mão
     * mude de posição. Um botão de menu, sozinho, esconde a navegação inteira atrás de um
     * toque e de uma suposição ("deve ter um menu em algum lugar").
     *
     * Ela mostra os QUATRO primeiros itens que o servidor mandou, mais "Menu". Quatro porque é
     * o que cabe legível em 390px; os primeiros porque a ordem do menu já é a decisão do
     * produto sobre o que importa — repeti-la aqui seria uma segunda opinião livre para
     * divergir. Quem tem só a Operação vê os itens dela; quem tem os dois vê os primeiros, e o
     * resto continua a um toque em "Menu".
     */
    .inferior {
      /*
       * O display flex AQUI só vale no celular, porque esta regra vive dentro do
       * @media (max-width: 768px). No desktop quem manda é a regra base, lá embaixo, que a
       * esconde — e ela faltava.
       *
       * (Sem crases neste comentário: ele vive dentro do template literal do CSS.)
       *
       * Sem a base, o <div> continuava sendo um bloco comum no desktop: aparecia no TOPO da
       * barra, com 191px de altura quando recolhida, empurrando o menu para baixo e jogando o
       * botão de expandir para y=1001 numa tela de 900. Era por isso que ele "sumia" — ele
       * estava desenhado, fora da tela.
       */
      display: flex; align-items: stretch;
      /* absolute, e nao fixed: assim ela cola no fundo do HOST, que segue o dvh -- e nao no
         fundo de uma tela imaginaria que o Safari nao usa. */
      position: absolute; left: 0; right: 0; bottom: 0; z-index: 160;
      background: var(--bg);
      border-top: 1px solid var(--borda);
      /* A faixa do gesto do iPhone come a última linha se ninguém a reservar. */
      padding-bottom: env(safe-area-inset-bottom, 0px);
      pointer-events: auto;
      box-shadow: 0 -2px 14px rgba(3, 21, 37, .22);
    }
    .inferior a, .inferior button {
      flex: 1 1 0; min-width: 0;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 3px; padding: 8px 2px 7px;
      min-height: 56px;               /* 44 de alvo + a folga do rótulo */
      background: none; border: 0; cursor: pointer;
      color: var(--texto); text-decoration: none;
      font-family: inherit; font-size: 10px; line-height: 1.1;
      -webkit-tap-highlight-color: transparent;
    }
    .inferior .rot {
      max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .inferior a[aria-current='page'] { color: var(--marca); }
    .inferior a[aria-current='page'] svg { stroke: var(--marca); }

    /* A gaveta aberta cobre a barra inferior: com o menu inteiro na tela, ela vira ruído. */
    :host([aberta]) .inferior { opacity: 0; pointer-events: none; }

    /*
     * O botão flutuante de abrir SAI DE CENA no celular: quem abre o menu agora é o item
     * "Menu" da barra inferior, que está sempre à vista e não depende de ninguém adivinhar.
     * A regra fica escrita em vez de o elemento ser removido, porque ele continua servindo em
     * qualquer hospedeiro que não desenhe a barra inferior.
     */
    .abrir { display: none; }

    /* O VÉU escurece o conteúdo e recebe o toque de fora -- fechar arrastando ou tocando ao
       lado é o gesto que todo mundo já tem no dedo. */
    .veu {
      display: block; position: fixed; inset: 0; z-index: 149;
      background: rgba(3, 21, 37, .45);
      opacity: 0; pointer-events: none;
      transition: opacity .3s ease;
    }
    :host([aberta]) .veu { opacity: 1; pointer-events: auto; }

    a.item { min-height: 44px; }

    /* Os que a barra de baixo ja mostra saem da gaveta -- e com eles a rolagem. */
    .lista a.item[data-atalho], .lista .secao[data-atalho] { display: none; }

    /*
     * O TOPO ENCOLHE, porque a altura util de um celular NAO e a altura da tela.
     *
     * Medido em 03/09: com 844px de viewport a lista cabia com folga, e mesmo assim o Vitor
     * fotografou "Mensagens" cortado. A diferenca e o navegador -- o Safari do iPhone come
     * ~130px com as proprias barras, entao a altura util fica perto de 700px. Ali o topo
     * (229px) mais o rodape (167px) somam 396px de moldura, e sobram 304 para uma lista que
     * precisa de 308.
     *
     * A logo era 96px de altura: num painel de 232px de largura ela ja se le a 44, e os 52px
     * que ela devolve sao a folga que faltava. O simbolo continua identificando o produto --
     * o que some e o espaco vazio em volta dele.
     */
    .logo { height: 52px; }
    .logo img { width: 46%; max-width: 108px; }
    .topo { padding-bottom: 8px; }
    :host([recolhida]) .logo { height: 52px; }
    :host([recolhida]) .logo img { width: 46%; max-width: 108px; }
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
    return ['nome', 'avatar', 'ativo', 'config-href', 'assets', 'modulo'];
  }

  constructor() {
    super();
    this._menu = null;
    this._rotulos = null;
    this._atencao = 0;
    this.attachShadow({ mode: 'open' });
  }

  /*
   * O MENU vem do hospedeiro, como propriedade e não como atributo: é um objeto, e serializar
   * o payload inteiro para dentro de um atributo HTML seria trocar uma referência por uma
   * string de alguns kilobytes a cada render.
   */
  set menu(v) { this._menu = v || null; this._desenhar(); this._buscarAtencao(); }
  get menu() { return this._menu; }

  /*
   * QUANTAS TELAS PRECISAM DE ATENÇÃO — perguntado a quem tem as telas.
   *
   * Este número vinha no /api/menu, contado por fleet-attention.js sobre o SQLite da Operação.
   * As telas mudaram de casa no corte de 03/09 (/api/devices é servido pelo Postgres da Gestão),
   * e o que sobrou naquele banco foram duas linhas de semente. A pílula dizia "2 telas precisam
   * de atenção" e a lista, servida pela outra casa, respondia "Nenhuma tela neste filtro".
   *
   * Um alerta que leva a uma página vazia ensina o leitor que ele mente — justamente antes da
   * noite em que uma tela morre de verdade.
   *
   * Pelo NAVEGADOR, mesma origem, com a sessão que a barra já tem: nenhuma ponte nova entre
   * servidores. Falhar é ficar sem a pílula, e não mostrar um número que pode estar errado —
   * este aviso só vale enquanto for verdade.
   */
  async _buscarAtencao() {
    const m = this._menu;
    if (!m) return;
    const temOperacao = (m.secoes || []).some((s) => (s.itens || []).some((i) => i.modulo === 'operacao'));
    if (!temOperacao) { this._atencao = 0; return; }
    let token = null;
    try { token = localStorage.getItem('token'); } catch (e) { token = null; }
    if (!token) return;
    try {
      const r = await fetch('/api/resumo/telas', { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) return;
      const d = await r.json();
      const n = Number(d && d.attention_total) || 0;
      if (n === this._atencao) return;
      this._atencao = n;
      this._desenhar();
    } catch (e) { /* sem resposta: a pílula fica como está */ }
  }

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

  /*
   * Abre e fecha a gaveta. `estado` explícito em vez de alternar: quem chama sempre sabe o que
   * quer (o botão abre, o véu fecha, tocar num item fecha), e um toggle cego erraria no dia em
   * que dois controles disparassem juntos.
   */
  _alternarGaveta(estado) {
    this.toggleAttribute('aberta', estado);
    const b = this.shadowRoot && this.shadowRoot.querySelector('.abrir');
    if (b) b.setAttribute('aria-expanded', String(!!estado));

    /*
     * COM A GAVETA ABERTA, A PÁGINA ATRÁS NÃO ROLA.
     *
     * Nunca houve esta trava, e nunca tinha aparecido — as telas eram curtas o bastante para a
     * página não ter rolagem nenhuma. Quando as tabelas passaram a empilhar em cartões no
     * celular, elas ficaram altas, e aí o gesto de rolar sobre a gaveta arrastava o conteúdo
     * atrás dela: a lista de destinos ficava parada enquanto a tela se mexia por baixo.
     *
     * O defeito era anterior; a mudança só o tornou alcançável. Isso é o padrão desta semana
     * inteira — a prova estava certa e o que mudou foi o estado em que ela conseguiu medir.
     *
     * `overflow: hidden` no body NÃO BASTA, e a primeira versão desta trava usava só isso. Ele
     * some com a barra de rolagem, mas no Safari do iOS o gesto de arrastar continua movendo a
     * página por baixo — é o defeito conhecido de "scroll chaining", e o celular é justamente
     * onde a gaveta existe.
     *
     * `position: fixed` trava de verdade. O preço é que ele zera a posição da rolagem, e quem
     * fechasse a gaveta voltaria ao topo da lista que estava lendo — então a posição é guardada
     * e devolvida na hora de fechar. `overflow: hidden` fica junto, para o caso de o fixed não
     * pegar antes da pintura.
     */
    try {
      const corpo = document.body;
      if (estado) {
        this._rolagemDeAntes = window.scrollY || document.documentElement.scrollTop || 0;
        corpo.style.position = 'fixed';
        corpo.style.top = '-' + this._rolagemDeAntes + 'px';
        corpo.style.left = '0';
        corpo.style.right = '0';
        corpo.style.width = '100%';
        corpo.style.overflow = 'hidden';
      } else {
        const voltarPara = this._rolagemDeAntes || 0;
        corpo.style.position = '';
        corpo.style.top = '';
        corpo.style.left = '';
        corpo.style.right = '';
        corpo.style.width = '';
        corpo.style.overflow = '';
        /* Devolve a pessoa exatamente onde ela estava lendo. */
        window.scrollTo(0, voltarPara);
        this._rolagemDeAntes = 0;
      }
    } catch (e) { /* sem document não há gaveta; segue */ }
  }

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

  _item(it, ehAtalho) {
    const icone = it.icone
      ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${it.icone}</svg>`
      : '<svg width="18" height="18" aria-hidden="true"></svg>';
    const atual = this._estaAtivo(it) ? ' aria-current="page"' : '';
    const rotulo = (this._rotulos && this._rotulos[it.id]) || it.rotulo;
    const marca = ehAtalho ? ' data-atalho="1"' : '';
    return `<a class="item" href="${esc(it.href)}" data-id="${esc(it.id)}" data-modulo="${esc(it.modulo || '')}"${marca}${atual}>`
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
    /* O número vem de /api/resumo/telas (_buscarAtencao), que conta sobre as telas que
       existem; `atencao_telas` do menu ficou zero de propósito — ver o comentário lá. */
    const atencao = Number(this._atencao) || 0;
    /*
     * NULO quando não há teste — a barra decide desenhar pela presença, e é por isso que o
     * servidor manda null em vez de um objeto com zeros. Um número só chega aqui quando há
     * de fato um prazo correndo.
     */
    const teste = (m && m.teste && Number(m.teste.dias_restantes) > 0) ? m.teste : null;
    const papel = (m && m.usuario && m.usuario.papel_rotulo) || '';
    const inicio = (m && m.inicio) || '#/';

    const nome = this.getAttribute('nome') || '';
    const avatar = this.getAttribute('avatar') || '';
    const configHref = this.getAttribute('config-href') || '';

    /*
     * QUEM JA ESTA NA BARRA DE BAIXO NAO SE REPETE NA GAVETA (celular).
     *
     * A gaveta precisava de 543px e tinha 448px, entao rolava -- e os 95px que faltavam eram
     * quase exatamente os quatro itens que a barra inferior JA mostra o tempo todo. Repeti-los
     * custava a rolagem inteira e nao dava destino nenhum a mais.
     *
     * A marca e por ITEM (data-atalho) e o esconder e no CSS do @media, e nao aqui: no
     * computador nao existe barra inferior, entao a lista continua completa. Uma so montagem
     * serve aos dois, e nao ha um segundo caminho de render para divergir.
     */
    const planosParaAtalho = [];
    for (const sec of secoes) for (const it of (sec.itens || [])) planosParaAtalho.push(it);
    const atalhos = planosParaAtalho.slice(0, 4);
    const idsAtalho = new Set(atalhos.map((it) => it.id));

    const corpo = secoes.map((s) => {
      const itens = s.itens || [];
      /* Uma secao cujos itens foram TODOS para a barra some junto com eles no celular --
         senao sobraria um titulo (OPERACAO) sem nada embaixo. */
      const todaEmAtalhos = itens.length > 0 && itens.every((i) => idsAtalho.has(i.id));
      const titulo = s.titulo
        ? `<div class="secao"${todaEmAtalhos ? ' data-atalho="1"' : ''}>${esc(s.titulo)}</div>`
        : '';
      return titulo + itens.map((i) => this._item(i, idsAtalho.has(i.id))).join('');
    }).join('');

    // A linha antes dos transversais (Relatórios, e Administração para a plataforma). Eles não
    // pertencem a módulo nenhum, e a linha diz isso sem precisar de rótulo.
    const trans = transversais.length
      ? '<div class="risco"></div>' + transversais.map((i) => this._item(i)).join('')
      : '';

    /*
     * CONFIGURAÇÕES CARREGA O MÓDULO DO HOSPEDEIRO, e a falta disso quebrou a Gestão.
     *
     * Este item nascia sem `modulo`, e o efeito só aparecia de um lado. Na Operação o
     * config-href é `#/settings` — só fragmento, então o navegador troca o hash e o app
     * continua onde estava, por acidente.
     *
     * Na Gestão o href é um CAMINHO (`/configuracoes`), e uma âncora crua dentro do Shadow
     * DOM não passa pelo Next: `basePath` só reescreve <Link> e router.push. Sem módulo, o
     * ouvinte de `navegar` de lá não reconhecia o item como dele e deixava o navegador
     * seguir — para `/configuracoes` sem o `/gestao`, que o proxy entrega à Operação. Tela
     * em branco.
     *
     * Com o módulo, ele é um item como os outros: o hospedeiro o reconhece e navega do lado
     * do cliente, com o basePath aplicado por quem sabe aplicá-lo.
     */
    const config = configHref
      ? this._item({
          id: 'configuracoes',
          rotulo: 'Configurações',
          href: configHref,
          icone: ICONE_CONFIG,
          modulo: this.getAttribute('modulo') || '',
        })
      : '';

    /*
     * OS ATALHOS DE BAIXO. Os quatro primeiros itens que o servidor mandou, achatados na
     * ordem em que ele os mandou -- essa ordem JA E a decisao do produto sobre o que
     * importa, e reescreve-la aqui seria uma segunda opiniao livre para divergir dela.
     */
    const inferior = atalhos.map((it) => {
      const icone = it.icone
        ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${it.icone}</svg>`
        : '<svg width="20" height="20" aria-hidden="true"></svg>';
      const atual = this._estaAtivo(it) ? ' aria-current="page"' : '';
      const rotulo = (this._rotulos && this._rotulos[it.id]) || it.rotulo;
      return `<a href="${esc(it.href)}" data-id="${esc(it.id)}"${atual}>`
        + icone + `<span class="rot">${esc(rotulo)}</span></a>`;
    }).join('')
      /* E o quinto lugar e sempre a porta para o menu inteiro: com 11 destinos, quatro
         atalhos nunca vao cobrir tudo, e esconder o resto sem dizer onde esta e o defeito
         que esta barra veio consertar. */
      + `<button type="button" class="menu" aria-label="Abrir menu">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <path d="M3 6h18M3 12h18M3 18h18"/>
          </svg>
          <span class="rot">Menu</span>
        </button>`;

    this.shadowRoot.innerHTML = `
      <style>${ESTILO}</style>
      <button class="abrir" type="button" aria-label="Abrir menu" aria-expanded="false">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <path d="M3 6h18M3 12h18M3 18h18"/>
        </svg>
      </button>
      <div class="veu" part="veu"></div>
      <div class="inferior" role="navigation" aria-label="Atalhos">${inferior}</div>
      <nav aria-label="Navegação principal">
        <div class="topo">
          <a class="logo" href="${esc(inicio)}" data-id="inicio" aria-label="Loop Player">
            <img src="${esc(assets)}/${logo}" alt="Loop Player">
          </a>
          ${lugar && lugar.nome ? `
            <div class="lugar" data-suporte="${lugar.suporte ? '1' : '0'}">
              ${lugar.suporte ? '<div class="rotulo">Suporte a</div>' : ''}
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
          ${teste ? `
            <div class="teste" title="Teste da Gestão — termina em ${teste.dias_restantes} dia${teste.dias_restantes > 1 ? 's' : ''}">
              Teste da Gestão · <b>${teste.dias_restantes} dia${teste.dias_restantes > 1 ? 's' : ''}</b>
            </div>` : ''}
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

    /* A PORTA DA GAVETA. O mesmo atributo [aberta] que o hambúrguer da Operação já mexe --
       dois controles, um estado, para os dois nunca discordarem. */
    const menuBaixo = this.shadowRoot.querySelector('.inferior .menu');
    if (menuBaixo) menuBaixo.addEventListener('click', () => this._alternarGaveta(true));

    const abrir = this.shadowRoot.querySelector('.abrir');
    if (abrir) abrir.addEventListener('click', () => this._alternarGaveta(true));
    const veu = this.shadowRoot.querySelector('.veu');
    if (veu) veu.addEventListener('click', () => this._alternarGaveta(false));
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

})();
