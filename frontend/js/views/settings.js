import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc } from '../utils.js';
// Estas abas delegam para as views que ja sao donas destas telas. A fileira em si vem do
// servidor e e desenhada por <loop-settings-tabs> -- ver a nota sobre o TABS removido, abaixo.
import * as billing from './billing.js';
import * as workspaceMembers from './workspace-members.js';
// The activity log lives here now rather than on a nav item of its own; the view owns the
// rendering and this page owns where it sits and who is shown it.
import { mountActivityLog } from './activity.js';

/*
 * Settings is a TAB SHELL.
 *
 * Subscription and Members used to be their own sidebar entries. Loop Player sells three things a
 * subscriber operates daily — Displays, Content, Playlists — and everything account-shaped now
 * lives behind one door instead of scattering more items down the nav.
 *
 * Each tab delegates to the view that already owns it (billing.js, workspace-members.js) rather
 * than reimplementing it here: they keep their own routes (#/billing and #/members still resolve,
 * so old links work), and there is one implementation of each screen, not two.
 *
 * WHO THIS PAGE BELONGS TO: the subscriber. The shopkeeper who pays for Loop Player and invites
 * their own staff — hence Account, Subscription, Members and Language, and nothing else. Running
 * the installation (users across every tenant, plans, branding, tokens, SSO, the server itself)
 * is a different job with a different owner, and it has its own page at #/admin. It was a tab
 * here, and a tab is how it leaked: with the page already open, the next control always looked
 * like it belonged one section further down.
 */
/*
 * O TABS LOCAL SAIU. Ele listava as abas desta tela com os rotulos e a regra do dono.
 *
 * Era a segunda lista: o servidor ja dizia quais abas existem, e esta repetia a resposta em
 * outra ordem e com outros nomes. Enquanto as duas existiram, a fileira da Operacao comecava
 * pelas dela e a da Gestao pelas dela -- a mesma lista em duas ordens.
 *
 * O que sobrou dela e ABA_LOCAL, logo abaixo, que nao e uma lista de abas: e a traducao entre
 * o id que o servidor usa e o nome que esta tela da ao mesmo painel.
 */

let activeTab = 'account';

/*
 * A ABA MORA NO ENDERECO.
 *
 * O `?aba=` ja vinha no href servido e ninguem o lia -- nem esta tela, nem a da Gestao. Entao
 * atravessar de um modulo para o outro caia sempre na primeira aba, e o parametro escrito
 * fazia o codigo parecer resolvido em toda leitura.
 *
 * O que vem no endereco e o id SERVIDO (`conta`, `assinatura`), nao o nome local (`account`).
 * O id e o que os dois lados falam; o nome local e assunto interno de cada tela.
 */
function abaDoEndereco() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  return ABA_LOCAL[q.get('aba')] || null;
}

/*
 * Escreve sem empilhar historico: trocar de aba nao e navegar, e `pushState` faria o botao
 * Voltar desfazer clique a clique em vez de sair de configuracoes.
 */
function gravarAbaNoEndereco(idServido) {
  const base = location.hash.split('?')[0] || '#/settings';
  const alvo = `${base}?aba=${encodeURIComponent(idServido)}`;
  if (location.hash === alvo) return;
  history.replaceState(null, '', location.pathname + location.search + alvo);
}
let activeChild = null;   // the delegated view, so its cleanup() runs on switch

function childCleanup() {
  try { activeChild?.cleanup?.(); } catch { /* a failing cleanup must not block the switch */ }
  activeChild = null;
}

/*
 * O id que o servidor manda, traduzido para a aba que esta tela desenha.
 *
 * O endpoint fala em ids estáveis e compartilhados com a Gestão (`assinatura-plano`), e esta
 * tela em ids próprios (`billing`), que são também a chave do `activeTab`. Um id que não
 * estiver aqui é ignorado — assim a Gestão pode acrescentar abas dela sem quebrar esta tela.
 */
const ABA_LOCAL = {
  conta: 'account',
  /*
   * A aba do DONO passou a vir na lista servida. Ela era decidida aqui, por uma pergunta
   * propria ao servidor (isActivityAvailable) -- e por isso existia na Operacao e NAO na
   * Gestao, que nao tinha a quem perguntar. A fileira ficava diferente conforme o lado.
   *
   * Agora o servidor decide, com o mesmo criterio de routes/activity.js, e as duas portas
   * respondem igual. Ver a nota em server/routes/configuracoes.js.
   */
  atividade: 'activity',
  // `assinatura` e `pessoas` existiam com dois nomes — "Plano e consumo"/"Minha assinatura" e
  // "Membros"/"Usuários". Viraram uma aba cada, e quem a desenha depende do plano: com Gestão
  // é a tela de lá; sem Gestão, estas daqui.
  assinatura: 'billing',
  pessoas: 'members',
};

/*
 * AS ABAS QUE ESTA PESSOA PODE VER, e as do outro módulo.
 *
 * Segue o mesmo padrão que a aba do dono já usava neste arquivo: a tela desenha tudo e
 * DEPOIS tira o que não cabe. É de propósito — esperar a resposta antes de desenhar deixaria
 * a página em branco enquanto o servidor pensa, e configurações é onde alguém vai quando
 * algo já está errado.
 *
 * Falhar não muda nada: sem resposta, ficam as abas de sempre. Uma tela de configurações que
 * some porque um servidor caiu é pior do que uma que mostra uma aba a mais — e o servidor
 * recusa as ações de qualquer jeito, rota por rota.
 */
function aplicarAbasServidas(container) {
  const fileira = container.querySelector('#settingsTabs');
  if (!fileira) return;

  fetch('/api/configuracoes', {
    headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d || !Array.isArray(d.abas)) return;

      /*
       * A FILEIRA INTEIRA, na ordem em que o servidor mandou.
       *
       * Antes esta funcao ESCONDIA as abas locais que a lista nao trouxe e ACRESCENTAVA as da
       * Gestao no fim, como links soltos depois das nossas. O outro lado fazia o espelho
       * disso. Resultado: a mesma fileira em duas ordens, conforme de onde se olhava.
       *
       * Agora ela so entrega a lista ao componente, que desenha tudo -- nossas e as de la --
       * na ordem servida. Ver frontend/components/loop-settings-tabs.js.
       */
      fileira.abas = d.abas;
      fileira.setAttribute('ativa', servidaDaLocal(activeTab) || '');

      /*
       * A aba aberta e lembrada entre visitas. Se a pessoa foi rebaixada desde a ultima, a
       * lembrada pode ser uma que ela nao ve mais -- e a tela ficaria sem aba marcada
       * mostrando, embaixo, justamente o conteudo que o servidor vai recusar.
       *
       * Cai na primeira aba DESTE modulo. Cair numa da Gestao mandaria a pessoa para outro
       * sistema por ter aberto configuracoes, que e uma surpresa em vez de um conserto.
       */
      const minhas = d.abas.filter((a) => a.modulo === 'operacao').map((a) => ABA_LOCAL[a.id]).filter(Boolean);

      /*
       * O ENDERECO GANHA DA LEMBRANCA. Quem chegou por um link pediu uma aba; abrir outra porque
       * ela foi a ultima visitada e ignorar o pedido.
       *
       * Mas so se a pessoa PUDER ve-la: um link antigo para uma aba que ela perdeu tem de cair na
       * regra abaixo, e nao abrir um painel que o servidor vai recusar.
       */
      const pedida = abaDoEndereco();
      if (pedida && minhas.includes(pedida) && pedida !== activeTab) {
        activeTab = pedida;
        fileira.setAttribute('ativa', servidaDaLocal(activeTab) || '');
        childCleanup();
        const corpo = container.querySelector('#settingsTabBody');
        if (corpo) renderTab(corpo);
      }

      if (minhas.length && !minhas.includes(activeTab)) {
        activeTab = minhas[0];
        fileira.setAttribute('ativa', servidaDaLocal(activeTab) || '');
        // Senao o endereco seguiria prometendo uma aba que a pessoa nao ve mais, e recarregar
        // a pagina repetiria a mesma correcao toda vez.
        gravarAbaNoEndereco(servidaDaLocal(activeTab) || '');
        childCleanup();
        const body = container.querySelector('#settingsTabBody');
        if (body) renderTab(body);
      }
    })
    .catch(() => {
      /*
       * Sem resposta, a fileira fica VAZIA -- e isso e deliberado.
       *
       * A versao anterior caia nas "abas de sempre", escritas no HTML. Uma lista de reserva e
       * uma SEGUNDA lista: ela concorda hoje e diverge no dia em que alguem mexer so na do
       * servidor, e some justamente onde ninguem olha. O painel embaixo continua desenhado,
       * entao quem estava no meio de algo nao perde a tela.
       */
    });
}

/*
 * O caminho de volta: da aba desta tela para o id que o servidor usa.
 *
 * ABA_LOCAL vai de servido -> local. Marcar a aba aberta precisa do inverso, e derivar do
 * mesmo objeto e o que impede os dois mapas de discordarem no dia em que alguem acrescentar
 * uma aba e lembrar de so um deles.
 */
function servidaDaLocal(local) {
  for (const [servida, propria] of Object.entries(ABA_LOCAL)) {
    if (propria === local) return servida;
  }
  return null;
}

export async function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Configurações</h1>
        <div class="subtitle">Sua conta, assinatura e equipe</div>
      </div>
    </div>
    <!--
      A FILEIRA nasce vazia: quem a desenha e <loop-settings-tabs>, o mesmo componente que a
      Gestao monta. Antes ela era escrita aqui a partir de um TABS local, e a Gestao escrevia a
      dela em React -- duas fileiras, cada uma pondo as proprias abas primeiro, e por isso a
      mesma lista aparecia em duas ordens.
    -->
    <loop-settings-tabs id="settingsTabs" modulo="operacao"></loop-settings-tabs>
    <div id="settingsTabBody"></div>
  `;

  /*
   * A REGRA DO DONO SAIU DAQUI.
   *
   * Havia um bloco que desenhava a aba de atividade e depois a ESCONDIA ate isActivityAvailable()
   * responder. Funcionava, e era o motivo de aquela aba existir na Operacao e nao na Gestao: a
   * pergunta era feita pela TELA, e a tela de la nao tinha a quem perguntar.
   *
   * Agora a lista servida ja chega decidida, com o mesmo criterio de routes/activity.js, e as
   * duas portas respondem igual. Uma pergunta a menos e uma divergencia a menos.
   */

  const body = container.querySelector('#settingsTabBody');

  // As abas que o servidor permite, e as do outro módulo. Ver a nota em aplicarAbasServidas.
  aplicarAbasServidas(container);

  /*
   * TROCAR DE ABA -- e a do outro modulo agora e so um link.
   *
   * O componente emite `trocar` para qualquer aba e deixa o hospedeiro decidir. Aba deste
   * modulo: seguramos o clique e trocamos o painel, sem recarregar. Aba da Gestao: NAO
   * seguramos, e o navegador segue o href.
   *
   * Ate aqui as duas eram seguradas. A da Gestao passava por uma travessia -- token de troca
   * de 60 segundos, endereco montado com ele no fragmento -- porque a Gestao tinha sessao
   * propria e o login dela estava fechado. A sessao agora e uma so, na mesma origem, e o href
   * que o servidor manda ja e o endereco certo.
   *
   * Repare que o preventDefault desceu para dentro do ramo local: chama-lo antes de saber de
   * qual aba se trata seguraria tambem a que deve seguir.
   */
  const fileira = container.querySelector('#settingsTabs');
  fileira?.addEventListener('trocar', (e) => {
    const { id, local } = e.detail;

    if (!local) return;
    e.preventDefault();

    const propria = ABA_LOCAL[id];
    if (!propria || propria === activeTab) return;
    activeTab = propria;
    fileira.setAttribute('ativa', id);
    gravarAbaNoEndereco(id);
    childCleanup();
    renderTab(body);
  });

  await renderTab(body);
}

async function renderTab(body) {
  body.innerHTML = `<div class="empty-state"><h3>Carregando...</h3></div>`;
  if (activeTab === 'billing') {
    activeChild = billing;
    return billing.render(body);
  }
  if (activeTab === 'members') {
    // The workspace id is not in the tab; resolve it the same way the #/members route does.
    const me = getCachedUser();
    const ws = me?.current_workspace_id
      || (Array.isArray(me?.accessible_workspaces) && me.accessible_workspaces[0]?.id);
    if (!ws) { body.innerHTML = `<div class="empty-state"><h3>Nenhum workspace ainda</h3></div>`; return; }
    activeChild = workspaceMembers;
    return workspaceMembers.render(body, ws);
  }
  if (activeTab === 'activity') {
    body.innerHTML = `<div class="settings-section">
      <h3>Registro de atividades</h3>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px">Quem fez o quê nesta conta. Visível apenas para o dono.</p>
      <div id="activityHost"></div>
    </div>`;
    return mountActivityLog(document.getElementById('activityHost'));
  }
  return renderAccountTab(body);
}

/*
 * isActivityAvailable() SAIU.
 *
 * Ela perguntava a /api/activity/available se esta pessoa podia ler o registro, e a tela
 * escondia a aba ate a resposta chegar. A rota continua existindo e continua guardando o
 * conteudo -- o que mudou e que a FILEIRA nao pergunta mais: a lista servida ja chega
 * decidida, com o mesmo criterio, e por isso a aba passou a existir tambem na Gestao.
 */

function getCachedUser() {
  try { return JSON.parse(localStorage.getItem('user') || '{}'); } catch { return {}; }
}

async function renderAccountTab(container) {
  // Fetch fresh user from the server — plan_id and role may have been changed
  // by an admin since login. Fall back to localStorage if the request fails.
  let user;
  try { user = await api.getMe(); localStorage.setItem('user', JSON.stringify(user)); }
  catch { user = JSON.parse(localStorage.getItem('user') || '{}'); }

  // No page-header here: the shell above already rendered the title and the tab bar, and this
  // function now paints only the tab body.
  container.innerHTML = `
    <div class="settings-section">
      <h3>Conta</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
        <div class="form-group"><label>E-mail</label><input type="email" class="input" value="${esc(user.email || '')}" disabled></div>
        <div class="form-group"><label>Nome</label><input type="text" id="acctName" class="input" value="${esc(user.name || '')}"></div>
      </div>
      <div class="form-group" style="margin-top:12px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="acctEmailAlerts" ${user.email_alerts ? 'checked' : ''}>
          <span>Avisar por e-mail quando uma tela ficar offline</span>
        </label>
      </div>
      <button class="btn btn-secondary btn-sm" id="saveAcctBtn">Salvar perfil</button>

      ${user.auth_provider === 'local' ? `
      <div style="border-top:1px solid var(--border);margin-top:20px;padding-top:16px">
        <h4 style="font-size:14px;margin-bottom:8px">Alterar senha</h4>
        <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px">Deve ter no mínimo 8 caracteres.</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px">
          <div class="form-group"><label>Senha atual</label><input type="password" id="acctCurrentPw" class="input" autocomplete="current-password"></div>
          <div class="form-group"><label>Nova senha</label><input type="password" id="acctNewPw" class="input" autocomplete="new-password"></div>
          <div class="form-group"><label>Confirmar nova senha</label><input type="password" id="acctConfirmPw" class="input" autocomplete="new-password"></div>
        </div>
        <button class="btn btn-primary btn-sm" id="changePwBtn">Alterar senha</button>
      </div>
      ` : `
      <p style="color:var(--text-muted);font-size:12px;margin-top:16px">${`Você entra via ${esc(user.auth_provider || 'SSO')}. Gerencie sua senha lá.`}</p>
      `}

      <!--
        Sign-in method (#258). An account has exactly ONE credential: a password, or one
        instance-wide provider. Linking deletes the password; unlinking requires a new one in the
        same step, so the account is never briefly left with no way in. Populated by loadSsoLink().
      -->
      <div id="ssoLinkBlock" style="border-top:1px solid var(--border);margin-top:20px;padding-top:16px">
        <h4 style="font-size:14px;margin-bottom:8px">Forma de entrar</h4>
        <p style="color:var(--text-muted);font-size:12px">…</p>
      </div>

    </div>


    <!--
      "About" is the legal pages plus the build number.

      The version used to sit in the sidebar footer, permanently, for the one conversation a
      quarter where it matters — and this comment used to argue it was not the subscriber's
      concern and belonged under Administration. Both were wrong in the same way: a tenant cannot
      open Administration, so the first thing support asks for was the one thing they could not
      find. It is here, where the rest of "about this account" already lives, and nowhere else.
    -->
    <div class="settings-section">
      <h3>Sobre</h3>
      <div style="color:var(--text-secondary);font-size:13px">
        <p id="settingsVersion" style="font-family:ui-monospace,monospace;font-size:12px;color:var(--text-muted)">—</p>
        <p style="margin-top:12px">
          <a href="/legal/terms.html" target="_blank" style="color:var(--accent-ink);font-size:12px">Termos de Serviço</a>
          &nbsp;&middot;&nbsp;
          <a href="/legal/privacy.html" target="_blank" style="color:var(--accent-ink);font-size:12px">Política de Privacidade</a>
          &nbsp;&middot;&nbsp;
          <a href="/legal/third-party.html" target="_blank" style="color:var(--accent-ink);font-size:12px">Licenças de terceiros</a>
        </p>
      </div>
    </div>
  `;

  /*
   * The build number, fetched here rather than read out of app.js.
   *
   * Importing it from app.js made a cycle — app.js imports this view, this view imported app.js
   * back — and app.js is the entry module that routes the whole application. The cycle happened to
   * resolve, because the export was a hoisted function; the next one might not be, and that
   * failure is a blank page with nothing in the console naming the cause. One request on a tab the
   * reader opened deliberately is a much cheaper thing to owe.
   */
  fetch('/api/version')
    .then((r) => r.json())
    .then((info) => {
      const el = document.getElementById('settingsVersion');
      if (!el || !info || !info.version) return;
      el.textContent = 'v' + info.version + (info.update_available ? ` · Atualização disponível` : '');
    })
    .catch(() => { /* a build number is never worth breaking a page over */ });


  // ==================== Two-factor authentication (#100) ====================
  // Drives the merged TOTP backend (/api/auth/totp/*). Re-renders #twoFactorBlock
  // for each state: SSO note / disabled+enroll / recovery-codes / enabled+manage.
  /*
   * Sign-in method: password OR one instance-wide provider, never both.
   *
   * The warning on the link button is the whole UX: the local password is DELETED, not kept as a
   * fallback, and someone who does not read that will think they gained a second way in. Unlink
   * asks for the new password up front for the same reason — the account must never sit between
   * credentials.
   *
   * Only instance-wide providers appear. An organization's provider is chosen by a customer and
   * must not be attachable to a platform account; the server refuses it too.
   */
  async function loadSsoLink() {
    const block = document.getElementById('ssoLinkBlock');
    if (!block) return;
    const head = `<h4 style="font-size:14px;margin-bottom:8px">Forma de entrar</h4>`;
    const muted = 'color:var(--text-muted);font-size:12px';
    const paint = (inner) => { block.innerHTML = head + inner; };

    let me;
    try { me = await api.getMe(); }
    catch (e) { paint(`<p style="${muted}">${esc(e.message)}</p>`); return; }

    let providers = [];
    try {
      const res = await fetch('/api/auth/providers');
      if (res.ok) providers = (await res.json()).providers || [];
    } catch { /* offline: fall through to the no-providers copy */ }

    if (me.auth_provider && me.auth_provider !== 'local') {
      const name = providers.find((p) => p.slug === me.auth_provider)?.name || me.auth_provider;
      paint(`
        <p style="${muted};margin-bottom:12px">${`Esta conta entra pelo ${esc(name)}. Ela não tem senha.`}</p>
        <div id="unlinkForm" style="display:none;margin-bottom:12px">
          <p style="${muted};margin-bottom:8px">Defina uma senha para entrar no lugar. Ela passa a valer na hora e o {provider} é desvinculado no mesmo passo.</p>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px">
            <div class="form-group"><label>Nova senha</label><input type="password" id="unlinkPw" class="input" autocomplete="new-password"></div>
            <div class="form-group"><label>Confirmar nova senha</label><input type="password" id="unlinkPw2" class="input" autocomplete="new-password"></div>
          </div>
          <button class="btn btn-primary btn-sm" id="unlinkConfirmBtn">Definir senha e desvincular</button>
        </div>
        <button class="btn btn-secondary btn-sm" id="unlinkBtn">${`Desvincular ${esc(name)}`}</button>
      `);
      document.getElementById('unlinkBtn').onclick = () => {
        document.getElementById('unlinkForm').style.display = '';
        document.getElementById('unlinkBtn').style.display = 'none';
        document.getElementById('unlinkPw').focus();
      };
      document.getElementById('unlinkConfirmBtn').onclick = async () => {
        const pw = document.getElementById('unlinkPw').value;
        const pw2 = document.getElementById('unlinkPw2').value;
        if (pw !== pw2) return showToast('As duas senhas não conferem', 'error');
        try {
          await api.ssoUnlink(pw);
          showToast('Desvinculado. Agora você entra com sua senha.', 'success');
          loadSsoLink();
        } catch (e) { showToast(e.message, 'error'); }
      };
      return;
    }

    if (!providers.length) {
      paint(`<p style="${muted}">Esta conta entra com senha. Nenhum provedor de login único está configurado neste servidor.</p>`);
      return;
    }
    paint(`
      <p style="${muted};margin-bottom:12px">Esta conta entra com senha. Você pode vinculá-la a um provedor de login único.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${providers.map((p) => `<button class="btn btn-secondary btn-sm" data-link-slug="${esc(p.slug)}">${`Vincular ${esc(p.name)}`}</button>`).join('')}
      </div>
    `);
    block.querySelectorAll('[data-link-slug]').forEach((btn) => {
      btn.onclick = async () => {
        const slug = btn.dataset.linkSlug;
        const name = providers.find((p) => p.slug === slug)?.name || slug;
        // Deliberately blunt: the password is destroyed, and that is the part people miss.
        if (!window.confirm(`Você está vinculando esta conta ao ${name}.

Sua senha local será EXCLUÍDA. A partir daí você entra somente pelo ${name}.

Para voltar a usar senha depois, desvincule o ${name} e defina uma nova.`)) return;
        /*
         * Fetch the authorize URL, then navigate to it. NOT location.href straight at the start
         * route: the session is a bearer token in localStorage, so a top-level navigation arrives
         * with no Authorization header and is refused as anonymous.
         */
        try {
          const { url } = await api.ssoLinkStart(slug);
          window.location.href = url;
        } catch (e) { showToast(e.message, 'error'); }
      };
    });
  }

  /*
   * load2FA() SAIU -- cerca de 133 linhas que desenhavam o cadastro da segunda etapa:
   * o QR, a confirmacao em dois passos, os codigos de recuperacao mostrados UMA vez, e o
   * pedido de codigo para desativar.
   *
   * A segunda etapa foi removida do produto (decisao do Vitor). Ver a nota no lugar onde as
   * rotas viviam, em server/routes/auth.js.
   */

  loadSsoLink();

  /*
   * Report the outcome of a link round trip.
   *
   * The callback returns to #/settings rather than the login page — an authenticated user bounced
   * to a login screen to be told "that did not work" reads as having been signed out. Params are
   * stripped afterwards so a refresh or a copied URL does not replay the message.
   */
  (function reportLinkOutcome() {
    const q = new URLSearchParams((location.hash.split('?')[1] || ''));
    const linked = q.get('sso_linked');
    const err = q.get('sso_error');
    if (!linked && !err) return;
    if (linked) {
      showToast(`Vinculado. Agora você entra pelo ${linked}, e sua senha foi removida.`, 'success');
    } else {
      const known = ['link_email_mismatch', 'link_already_used', 'not_linkable', 'no_email',
        'email_unverified', 'verification_failed', 'provider_unavailable', 'provider_refused',
        'unknown_provider', 'expired', 'bad_state', 'no_code', 'server_error'];
      const key = known.includes(err) ? `settings.signin_err_${err}` : 'O login único falhou. Tente de novo.';
      showToast((key), 'error');
    }
    history.replaceState(null, '', location.pathname + location.search + '#/settings');
    loadSsoLink();
  }());

  document.getElementById('saveAcctBtn')?.addEventListener('click', async () => {
    const name = document.getElementById('acctName').value.trim();
    if (!name) return showToast('O nome não pode ficar em branco', 'error');
    const email_alerts = !!document.getElementById('acctEmailAlerts')?.checked;
    const btn = document.getElementById('saveAcctBtn');
    btn.disabled = true;
    try {
      const updated = await api.updateMe({ name, email_alerts });
      const stored = JSON.parse(localStorage.getItem('user') || '{}');
      localStorage.setItem('user', JSON.stringify({ ...stored, ...updated }));
      showToast('Perfil salvo', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('changePwBtn')?.addEventListener('click', async () => {
    const current = document.getElementById('acctCurrentPw').value;
    const next = document.getElementById('acctNewPw').value;
    const confirm = document.getElementById('acctConfirmPw').value;
    if (!current) return showToast('Digite sua senha atual', 'error');
    if (next.length < 8) return showToast('A nova senha deve ter no mínimo 8 caracteres', 'error');
    if (next !== confirm) return showToast('As novas senhas não conferem', 'error');
    const btn = document.getElementById('changePwBtn');
    btn.disabled = true;
    try {
      await api.updateMe({ current_password: current, password: next });
      document.getElementById('acctCurrentPw').value = '';
      document.getElementById('acctNewPw').value = '';
      document.getElementById('acctConfirmPw').value = '';
      showToast('Senha alterada', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

export function cleanup() {
  // Tear down whichever tab is mounted. billing.js polls nothing but the members view may, and a
  // delegated view never sees the router's cleanup — the router only knows about Settings.
  childCleanup();
  // Next visit opens on Account rather than resuming a tab the user has navigated away from.
  activeTab = 'account';
}
