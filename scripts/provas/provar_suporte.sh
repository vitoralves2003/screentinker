#!/bin/sh
. /tmp/mfa_lib.sh
# Prova do acesso de suporte: o dono da plataforma entra na conta de um cliente.
#
# Cada verificacao confere a FORMA do que recebeu, nao apenas se veio algo. A primeira versao
# deste teste imprimiu "OK" segurando uma mensagem de erro, porque so olhava se a variavel
# estava vazia.
#
# ── O CAMINHO ENCOLHEU ───────────────────────────────────────────────────────────────────
# Eram tres passos: entrar, alcancar o workspace do cliente, e pedir um token de troca de 60
# segundos que a Gestao convertia numa sessao dela. Agora sao dois: entrar e alcancar o
# workspace. A sessao que sai dali JA e a sessao dos dois modulos.
#
# Os casos que mais importam nao mudaram, e sao os do meio do arquivo: nenhum usuario novo,
# o suporte nao aparece entre as pessoas do cliente, o papel do titular fica intacto. Eles
# provam que o provisionamento sabe recuar -- e essa regra teve de ser reescrita nesta etapa,
# porque vivia dentro da rota que sumiu.

OP=http://127.0.0.1:3110
GE=http://127.0.0.1:3121
SUP_EMAIL=suporte@loop.invalid
SUP_SENHA='SenhaSuporte#2026'
CLIENTE_EMAIL=teste-ambiente-novo@exemplo.invalid

falhas=0
ok()  { echo "  OK     $1"; }
nok() { echo "  FALHOU $1"; falhas=$((falhas+1)); }
ejwt() { echo "$1" | grep -qE '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'; }
claims() { echo "$1" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null; }
gedb() { docker exec novo-gestao-postgres psql -U novo -d novo_gestao -tAc "$1" | tr -d ' \r'; }
opdb() { docker exec novo-operacao node -e "$1" 2>/dev/null | tr -d '\r'; }

WS=$(opdb "
const {db}=require('/app/server/db/database');
const r=db.prepare('SELECT w.id FROM workspaces w JOIN users u ON u.id=w.created_by WHERE u.email LIKE ?').get('teste-ambiente-novo%');
console.log(r ? r.id : '');
")

ANTES=$(gedb 'select count(*) from "User";')
REG_ANTES=$(opdb "
const {db}=require('/app/server/db/database');
console.log(db.prepare(\"SELECT COUNT(*) c FROM activity_log WHERE action = 'suporte:entrou_na_conta'\").get().c);
")

echo "=== 1. o suporte entra na Operacao ==="
S=$(entrar "$SUP_EMAIL" "$SUP_SENHA")
ejwt "$S" && ok "sessao de plataforma" || nok "nao entrou: $(echo "$S" | head -c 120)"

echo "=== 2. alcanca o workspace do cliente (sem ser membro dele) ==="
S2=$(curl -s -X POST $OP/api/auth/switch-workspace -H "Authorization: Bearer $S" \
  -H 'Content-Type: application/json' -d "{\"workspace_id\":\"$WS\"}" | sed -E 's/.*"token":"([^"]+)".*/\1/')
ejwt "$S2" && ok "entrou no workspace do cliente" || nok "nao alcancou: $S2"

echo "=== 3. a sessao vem MARCADA como acesso de suporte ==="
# Isto viajava no token de troca. Agora viaja na propria sessao, que e o unico token que
# existe -- e por isso vale tambem do lado da Operacao, nao so no da Gestao.
C=$(claims "$S2")
echo "$C" | grep -q '"acting_as":true' && ok "acting_as verdadeiro" || nok "veio sem a marca: $(echo "$C" | head -c 200)"
echo "$C" | grep -q '"papel":"TITULAR"' && ok "papel TITULAR (suporte administra)" || nok "papel inesperado"
echo "$C" | grep -q '"gestao_enabled":true' && ok "alcanca a Gestao independente do plano do cliente" || nok "o plano do cliente barrou o suporte"

echo "=== 4. dura 30 minutos, nao os sete dias de uma sessao comum ==="
# Um acesso a contratos, cobrancas e extrato bancario de outra empresa nao deveria continuar
# aberto depois que a pessoa parou de olhar. A regra vinha da rota de travessia e teria sumido
# com ela -- a sessao de suporte passaria a durar config.jwtExpiry, que sao sete dias.
DUR=$(echo "$C" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['exp']-d['iat'])" 2>/dev/null)
if [ "$DUR" = "1800" ]; then
  ok "1800 segundos"
else
  nok "duracao inesperada: $DUR segundos (esperava 1800)"
fi

echo "=== 5. a MESMA sessao abre o financeiro do cliente, sem troca ==="
COD=$(curl -s -o /dev/null -w '%{http_code}' $GE/clients -H "Authorization: Bearer $S2")
[ "$COD" = "200" ] && ok "alcancou os dados do cliente" || nok "respondeu $COD"

echo
echo "=== O QUE NAO PODE TER ACONTECIDO ==="
# Estas tres sao o coracao da suite. A regra que as sustenta vivia dentro do federated() e foi
# reescrita nesta etapa, no EntradaService -- e uma regra reescrita e exatamente o tipo de
# coisa que se perde sem ninguem ver.

echo "--- 6. nenhum usuario novo foi criado ---"
DEPOIS=$(gedb 'select count(*) from "User";')
[ "$ANTES" = "$DEPOIS" ] && ok "continuam $DEPOIS usuario(s)" || nok "criou usuario: $ANTES -> $DEPOIS"

echo "--- 7. o suporte NAO aparece entre as pessoas do cliente ---"
TEM=$(gedb "select count(*) from \"User\" where email = '$SUP_EMAIL';")
[ "$TEM" = "0" ] && ok "nao existe como usuario da empresa" || nok "virou usuario do cliente"

echo "--- 8. o titular do cliente continua titular ---"
P=$(gedb "select role::text from \"User\" where email = '$CLIENTE_EMAIL';")
[ "$P" = "TITULAR" ] && ok "intacto" || nok "papel do cliente virou $P"

echo
echo "=== O REGISTRO ==="
# Mudou de banco: era AdminAuditLog na Gestao, escrito pela rota de troca. Agora e o
# activity_log da Operacao, escrito em POST /api/auth/switch-workspace -- que registra a
# ENTRADA na conta e nao so a travessia para a Gestao.
REG_DEPOIS=$(opdb "
const {db}=require('/app/server/db/database');
console.log(db.prepare(\"SELECT COUNT(*) c FROM activity_log WHERE action = 'suporte:entrou_na_conta'\").get().c);
")
if [ -n "$REG_ANTES" ] && [ "$REG_DEPOIS" -gt "$REG_ANTES" ] 2>/dev/null; then
  ok "acesso registrado ($REG_ANTES -> $REG_DEPOIS)"
else
  nok "nada foi registrado ($REG_ANTES -> $REG_DEPOIS)"
fi

opdb "
const {db}=require('/app/server/db/database');
const r=db.prepare(\"SELECT u.email, a.details, a.workspace_id FROM activity_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.action = 'suporte:entrou_na_conta' ORDER BY a.created_at DESC LIMIT 1\").get();
console.log(r ? ('  ' + r.email + ' -> ' + r.details) : '  (sem linha)');
"

echo
[ "$falhas" = "0" ] && echo "TODOS OS CASOS DO ACESSO DE SUPORTE FECHARAM" || echo "$falhas CASO(S) FALHARAM"
exit $falhas
