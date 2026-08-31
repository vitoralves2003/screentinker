'use strict';

// SINGLE SOURCE OF TRUTH for the API router partition.
//
// server.js mounts from these two lists; test/api.test.js (the partition firewall
// test) asserts against the SAME lists. Because both read this one file, the mount
// list and the test cannot drift: add a router to PUBLIC_ROUTERS and it gets the
// token front door AND the firewall test covers it; the day a JWT-only router stops
// returning 401 to a `Bearer st_` token (e.g. someone gives it the token door), CI
// fails. This is the firewall-rule-as-code.
//
//   PUBLIC_ROUTERS   - token-reachable. Mounted with the bearerAuth front door +
//                      resolveTenancy + tokenScopeGate. A scoped API token AND a JWT
//                      session both reach these.
//   JWT_ONLY_ROUTERS - requireAuth only (no token front door). A `Bearer st_` token
//                      fails jwt.verify -> 401, so these are unreachable by any token
//                      (secure by exclusion). Privileged surfaces live here.
//
// Per-entry flags:
//   renderBypass: also exposes a public GET /:id/render (device render) that skips auth.
//   tenancy:      JWT-only router also runs resolveTenancy (acts on the caller's active
//                 workspace). Routers without it target a workspace by URL/body param
//                 and are gated per-handler (e.g. canAdminWorkspace).

const PUBLIC_ROUTERS = [
  { path: '/api/devices',     mod: './routes/devices' },
  { path: '/api/content',     mod: './routes/content' },
  { path: '/api/folders',     mod: './routes/folders' },
  { path: '/api/assignments', mod: './routes/assignments' },
  { path: '/api/layouts',     mod: './routes/layouts' },
  { path: '/api/widgets',     mod: './routes/widgets', renderBypass: true },
  { path: '/api/schedules',   mod: './routes/schedules' },
  { path: '/api/walls',       mod: './routes/video-walls' },
  { path: '/api/reports',     mod: './routes/reports' },
  { path: '/api/groups',      mod: './routes/device-groups' },
  { path: '/api/playlists',   mod: './routes/playlists' },
  { path: '/api/activity',    mod: './routes/activity' },
  { path: '/api/kiosk',       mod: './routes/kiosk', renderBypass: true },
  { path: '/api/pip',         mod: './routes/pip' },
];

const JWT_ONLY_ROUTERS = [
  { path: '/api/ai',          mod: './routes/ai',           tenancy: true },
  { path: '/api/provision',   mod: './routes/provisioning', tenancy: true },
  { path: '/api/teams',       mod: './routes/teams',        tenancy: true },
  { path: '/api/workspaces',  mod: './routes/workspaces' },
  { path: '/api/admin',       mod: './routes/admin' },
  { path: '/api/tokens',      mod: './routes/tokens',       tenancy: true },
  // O menu do sistema. `tenancy: true` porque quem responde "o que este cliente vê" precisa
  // do workspace resolvido para saber o plano. O dunningGate que vem junto deixa GET passar,
  // então um tenant suspenso continua enxergando a navegação — perder o menu junto com o
  // acesso transformaria uma cobrança em atraso numa tela em branco sem explicação.
  { path: '/api/menu',        mod: './routes/menu',         tenancy: true },
  // Mesmas condições do menu, e pelo mesmo motivo: precisa do workspace resolvido para saber
  // o plano e o papel, e um tenant suspenso continua tendo direito de VER as configurações —
  // é justamente onde ele regulariza a assinatura.
  { path: '/api/configuracoes', mod: './routes/configuracoes', tenancy: true },
  // Os resumos que a Gestão mostra no painel: telas, assinatura e pessoas. Viviam em
  // /api/federation, atrás de um token entre servidores; agora o navegador dela pergunta
  // direto, porque os dois módulos vivem na mesma origem desde a Fase B.
  //
  // `tenancy: true` pelo mesmo motivo do menu: quem responde "quantas telas este cliente tem"
  // precisa do workspace resolvido. E, como o menu, o dunningGate deixa GET passar — um tenant
  // suspenso continua vendo o painel, que é onde ele descobre por que foi suspenso.
  { path: '/api/resumo',      mod: './routes/resumo',       tenancy: true },
  /*
   * Etapa 6: a marca de contrato suspenso. `tenancy: true` porque a suspensao e por cliente --
   * o id do contrato vem da Gestao e so significa alguma coisa dentro do workspace que o emitiu,
   * e sem o workspace resolvido um id de um cliente poderia parar a midia de outro.
   */
  { path: '/api/contratos',   mod: './routes/contratos',    tenancy: true },
];

// #73: AGENCY_ROUTERS - capability-restricted ('agency' scope) surface. Mounted with
// bearerAuth + resolveTenancy + agencyGate (NOT tokenScopeGate). An 'agency' token is
// OFF the read/write/full ladder, so tokenScopeGate rejects it on every PUBLIC_ROUTER -
// it can reach ONLY this router, and only its allowlisted playlists in its bound
// workspace (agencyGate enforces both). read/write/full tokens and JWTs are rejected here.
const AGENCY_ROUTERS = [
  { path: '/api/agency', mod: './routes/agency' },
];

/*
 * FEDERATION_ROUTERS NAO EXISTE MAIS.
 *
 * Era a superficie que a GESTAO alcancava e nada mais: montada so com federationGate, sem
 * requireAuth e sem resolveTenancy, porque quem chegava ali era outro servidor nosso provado
 * por um segredo compartilhado.
 *
 * As cinco rotas dela viraram duas coisas: /api/menu e /api/configuracoes, que ja existiam
 * para o navegador da Operacao, e /api/resumo/{telas,assinatura,pessoas}, que sao as mesmas
 * respostas com uma linha trocada (req.federationOrgId -> req.organizationId).
 *
 * O que sumiu junto foi a categoria: nao ha mais "superficie de servidor para servidor" neste
 * produto. Toda rota e alcancada por um navegador com sessao de usuario, e isso e uma coisa a
 * menos que precisa ser explicada para quem chega.
 */

module.exports = { PUBLIC_ROUTERS, JWT_ONLY_ROUTERS, AGENCY_ROUTERS };
