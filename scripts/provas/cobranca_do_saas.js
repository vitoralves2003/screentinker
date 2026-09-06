/*
 * A COBRANÇA DO SAAS, DE PONTA A PONTA — contra o Asaas de SANDBOX, de dentro do container.
 *
 *   1. Um assinante de prova nasce pelo cadastro, entra e vai para o plano Pro com CPF.
 *   2. O mês passado fecha: a fatura nasce, a cobrança é aberta no Asaas e tem link de pagamento.
 *   3. O webhook de pagamento confirmado marca a fatura como paga.
 *   4. Uma fatura vencida há mais dias que o prazo SUSPENDE o painel: escrever recebe 403,
 *      as telas seguem (o gate só bloqueia escrita). O pagamento devolve o acesso na varredura.
 *   5. Tudo o que a prova plantou é desfeito, inclusive as cobranças no sandbox.
 *
 * Roda com: docker cp cobranca_do_saas.js novo-operacao:/app/server/prova-cobranca.js &&
 *           docker exec novo-operacao node /app/server/prova-cobranca.js
 * (ver provar_cobranca_do_saas.sh). Precisa de ASAAS_API_KEY de SANDBOX no container.
 */
process.chdir('/app/server');
const { db } = require('./db/database');
const invoicing = require('./services/tenant-invoicing');
const asaas = require('./services/asaas');
const billing = require('./lib/tenant-billing');
const config = require('./config');
const integ = require('./lib/integration-settings');

const PORTA = process.env.PORT || config.port || 3000;
const BASE = `http://127.0.0.1:${PORTA}`;
let falhas = 0;
const ok = (m, x) => console.log(`  ok    ${m}${x !== undefined ? `   ${x}` : ''}`);
const falha = (m, x) => { falhas++; console.log(`  FALHA ${m}${x !== undefined ? `   ${x}` : ''}`); };
const afirmar = (c, m, x) => (c ? ok(m, x) : falha(m, x));

/* CPF válido, gerado (o Asaas confere os dígitos). */
function cpfDeProva() {
  const n = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  const dv = (base) => { const s = base.reduce((a, d, i) => a + d * (base.length + 1 - i), 0); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  const d1 = dv(n); const d2 = dv([...n, d1]);
  return [...n, d1, d2].join('');
}
const mesAtras = (k) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - k); return d.toISOString().slice(0, 7); };
const diasDoMes = (mes) => new Date(Date.UTC(+mes.slice(0, 4), +mes.slice(5, 7), 0)).getUTCDate();
const diaAtras = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

async function http(caminho, { metodo = 'GET', corpo, token, headers = {} } = {}) {
  const r = await fetch(BASE + caminho, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const d = await r.json().catch(() => ({}));
  return { status: r.status, d };
}

const plantado = { user: null, ws: null, org: null, faturas: [], cobrancas: [], playlist: null };
/* Apaga o que a prova plantou seguindo as chaves estrangeiras do esquema: uma lista escrita à mão
   errou duas vezes (tabela que não existe, chave que ninguém lembrava). */
function apagarConta(userId) {
  const tabelas = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  const fksPara = (alvo) => { const out = []; for (const t of tabelas) for (const fk of db.prepare(`PRAGMA foreign_key_list(${t})`).all()) if (fk.table === alvo) out.push({ tabela: t, coluna: fk.from }); return out; };
  const apagarPor = (lista, valor) => { for (const { tabela, coluna } of lista) { try { db.prepare(`DELETE FROM ${tabela} WHERE ${coluna} = ?`).run(valor); } catch (e) { console.log(`  (${tabela}.${coluna}: ${e.message})`); } } };
  const paraUsers = fksPara('users'), paraWs = fksPara('workspaces'), paraOrg = fksPara('organizations');
  db.transaction(() => {
    const wss = db.prepare('SELECT DISTINCT w.id, w.organization_id FROM workspaces w LEFT JOIN workspace_members wm ON wm.workspace_id = w.id WHERE wm.user_id = ? OR w.created_by = ?').all(userId, userId);
    for (const ws of wss) {
      apagarPor(paraWs, ws.id);
      db.prepare('DELETE FROM workspaces WHERE id = ?').run(ws.id);
      if (ws.organization_id && !db.prepare('SELECT 1 FROM workspaces WHERE organization_id = ?').get(ws.organization_id)) {
        apagarPor(paraOrg, ws.organization_id);
        db.prepare('DELETE FROM organizations WHERE id = ?').run(ws.organization_id);
      }
    }
    apagarPor(paraUsers, userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  })();
}


async function limpar() {
  console.log('5. desfazendo');
  for (const id of plantado.cobrancas) { try { await asaas.cancelCharge(id); ok('cobrança cancelada no sandbox', id); } catch (e) { console.log('  (cobrança ' + id + ' não cancelada: ' + e.message + ')'); } }
  if (plantado.playlist) { try { db.prepare('DELETE FROM playlists WHERE id = ?').run(plantado.playlist); } catch (e) { console.log('  (playlist: ' + e.message + ')'); } }
  if (plantado.user) { try { apagarConta(plantado.user); } catch (e) { console.log('  (apagar: ' + e.message + ')'); } }
  const sobrou = plantado.user ? db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(plantado.user).n : 0;
  afirmar(sobrou === 0, 'o assinante de prova não existe mais');
}

(async () => {
  if (!asaas.configured()) { console.log('SEM ASAAS: ASAAS_API_KEY não está no container'); process.exit(1); }
  const base = String(integ.asaas().baseUrl || config.asaas.baseUrl || '');
  if (!/sandbox/.test(base)) { console.log('RECUSADO: o Asaas configurado NÃO é sandbox (' + base + '). Esta prova cria e cancela cobranças.'); process.exit(1); }
  const webhookToken = integ.asaas().webhookToken;
  if (!webhookToken) { console.log('SEM ASAAS_WEBHOOK_TOKEN: o webhook recusaria tudo'); process.exit(1); }

  const ts = Date.now();
  const email = `prova-cobranca-${ts}@exemplo.invalid`;
  const senha = 'Prova-de-cobranca-' + ts;

  console.log('1. o assinante de prova');
  const reg = await http('/api/auth/register', { metodo: 'POST', corpo: { email, password: senha, name: 'Prova de cobrança', aceite_termos: '2026-09-06' } });
  afirmar(reg.status === 201 || reg.status === 200, 'cadastro aceito', reg.status + ' ' + JSON.stringify(reg.d).slice(0, 100));
  const u = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!u) { falha('usuário não nasceu'); process.exit(1); }
  plantado.user = u.id;
  db.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").run(u.id);
  const login = await http('/api/auth/login', { metodo: 'POST', corpo: { email, password: senha } });
  afirmar(login.status === 200 && login.d.token, 'entra (e-mail confirmado pela prova)', login.status);
  const token = login.d.token;
  const wsRow = db.prepare('SELECT w.id, w.organization_id FROM workspaces w JOIN workspace_members wm ON wm.workspace_id = w.id WHERE wm.user_id = ? LIMIT 1').get(u.id);
  if (!wsRow) { falha('workspace não nasceu'); await limpar(); process.exit(1); }
  plantado.ws = wsRow.id; plantado.org = wsRow.organization_id;
  const cpf = cpfDeProva();
  const plano = await http('/api/subscription/plan', { metodo: 'POST', token, corpo: { plan_id: 'pro', tax_id: cpf, billing_email: email } });
  afirmar(plano.status === 200 && plano.d.plan_id === 'pro', 'vai para o plano Pro com CPF', plano.status + ' ' + JSON.stringify(plano.d).slice(0, 120));
  const wsDepois = db.prepare('SELECT plan_id, billing_tax_id, asaas_customer_id, subscription_status FROM workspaces WHERE id = ?').get(wsRow.id);
  afirmar(wsDepois.plan_id === 'pro' && wsDepois.billing_tax_id === cpf, 'o workspace guarda plano e CPF');
  afirmar(!!wsDepois.asaas_customer_id, 'o cliente foi aberto no Asaas na hora', wsDepois.asaas_customer_id);

  console.log('2. o mês fecha e a cobrança nasce');
  const mes1 = mesAtras(1), mes2 = mesAtras(2);
  const ins = db.prepare('INSERT OR REPLACE INTO workspace_license_daily (workspace_id, day, peak_devices) VALUES (?, ?, ?)');
  for (const mes of [mes1, mes2]) for (let d = 1; d <= diasDoMes(mes); d++) ins.run(wsRow.id, `${mes}-${String(d).padStart(2, '0')}`, 2);
  const calc = billing.computeInvoice(wsRow.id, mes1);
  afirmar(calc && calc.amount_cents > 0, 'o cálculo do mês dá um valor', calc && (calc.amount_cents / 100).toFixed(2) + ' ' + calc.currency);
  const f1 = await invoicing.closeMonthFor(wsRow.id, mes1);
  afirmar(!!f1 && f1.amount_cents === calc.amount_cents, 'a fatura do mês passado nasce com o valor calculado', f1 && f1.amount_cents);
  afirmar(!!(f1 && f1.asaas_charge_id), 'a cobrança foi aberta no Asaas', f1 && f1.asaas_charge_id);
  afirmar(!!(f1 && f1.invoice_url), 'e tem link de pagamento', f1 && f1.invoice_url);
  if (f1 && f1.asaas_charge_id) plantado.cobrancas.push(f1.asaas_charge_id);
  const f1b = await invoicing.closeMonthFor(wsRow.id, mes1);
  afirmar(f1b && f1b.id === f1.id && f1b.asaas_charge_id === f1.asaas_charge_id, 'fechar de novo não cobra duas vezes');

  console.log('3. o pagamento chega pelo webhook');
  const cliente = db.prepare('SELECT asaas_customer_id FROM workspaces WHERE id = ?').get(wsRow.id).asaas_customer_id;
  const evento = (id, cobranca, tipo) => http('/api/asaas/webhook', { metodo: 'POST', headers: { 'asaas-access-token': webhookToken }, corpo: { id, event: tipo, payment: { id: cobranca, customer: cliente, value: f1.amount_cents / 100, dueDate: f1.due_date } } });
  const semToken = await http('/api/asaas/webhook', { metodo: 'POST', corpo: { id: 'evt_prova_sem_token_' + ts, event: 'PAYMENT_CONFIRMED', payment: { id: f1.asaas_charge_id } } });
  afirmar(semToken.status === 401, 'sem o token, o webhook recusa', semToken.status);
  const pago = await evento('evt_prova_' + ts + '_1', f1.asaas_charge_id, 'PAYMENT_CONFIRMED');
  afirmar(pago.status === 200, 'com o token, aceita', pago.status);
  const f1Pago = db.prepare('SELECT status, paid_at FROM workspace_invoices WHERE id = ?').get(f1.id);
  afirmar(f1Pago.status === 'paid' && f1Pago.paid_at, 'a fatura está paga');
  const repetido = await evento('evt_prova_' + ts + '_1', f1.asaas_charge_id, 'PAYMENT_CONFIRMED');
  afirmar(repetido.status === 200, 'o mesmo evento de novo é aceito sem efeito (dedupe)', repetido.status);

  console.log('4. a fatura vencida suspende o painel, e o pagamento devolve');
  const f2 = await invoicing.closeMonthFor(wsRow.id, mes2);
  afirmar(!!(f2 && f2.asaas_charge_id), 'a segunda fatura nasce com cobrança', f2 && f2.asaas_charge_id);
  if (f2 && f2.asaas_charge_id) plantado.cobrancas.push(f2.asaas_charge_id);
  db.prepare("UPDATE workspace_invoices SET due_date = ? WHERE id = ?").run(diaAtras(config.billing.suspendAfterDays + 2), f2.id);
  const varrida = invoicing.enforceSuspensions();
  const estado1 = db.prepare('SELECT subscription_status FROM workspaces WHERE id = ?').get(wsRow.id).subscription_status;
  afirmar(estado1 === 'suspended', `vencida há ${config.billing.suspendAfterDays + 2} dias -> suspenso`, estado1 + ' ' + JSON.stringify(varrida));
  const escrita = await http('/api/playlists', { metodo: 'POST', token, corpo: { name: 'Prova de cobrança' } });
  afirmar(escrita.status === 403 && escrita.d.code === 'SUBSCRIPTION_SUSPENDED', 'escrever no painel recebe 403 com o motivo', escrita.status + ' ' + (escrita.d.code || escrita.d.error));
  const leitura = await http('/api/playlists', { token });
  afirmar(leitura.status === 200, 'ler continua permitido (as telas seguem)', leitura.status);
  const pago2 = await evento('evt_prova_' + ts + '_2', f2.asaas_charge_id, 'PAYMENT_CONFIRMED');
  afirmar(pago2.status === 200, 'o pagamento da vencida chega', pago2.status);
  invoicing.enforceSuspensions();
  const estado2 = db.prepare('SELECT subscription_status FROM workspaces WHERE id = ?').get(wsRow.id).subscription_status;
  afirmar(estado2 === 'active', 'a varredura devolve o acesso', estado2);
  const escrita2 = await http('/api/playlists', { metodo: 'POST', token, corpo: { name: 'Prova de cobrança' } });
  afirmar(escrita2.status === 201 || escrita2.status === 200, 'e escrever volta a funcionar', escrita2.status);
  if (escrita2.d && escrita2.d.id) plantado.playlist = escrita2.d.id;

  await limpar();
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nCOBRANÇA DO SAAS: TUDO CERTO');
  process.exit(falhas ? 1 : 0);
})().catch(async (e) => { console.log('ERRO: ' + (e.stack || e.message)); try { await limpar(); } catch { /* já reportado */ } process.exit(1); });
