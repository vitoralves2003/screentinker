#!/bin/sh
# Prova do portao do plano: a Gestao e um direito comprado, nao um efeito de ter conta.
#
# Percorre os quatro planos com o MESMO usuario, trocando so o plano do workspace. Se o
# portao dependesse de qualquer outra coisa -- papel, organizacao, sorte -- os quatro
# responderiam igual.

OP=http://127.0.0.1:3110
EMAIL=cliente@exemplo.invalid
SENHA='SenhaCliente#2026'

. /tmp/mfa_lib.sh

falhas=0
ok()  { echo "  OK     $1"; }
nok() { echo "  FALHOU $1"; falhas=$((falhas+1)); }

WS=$(docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
const r=db.prepare('SELECT w.id FROM workspaces w JOIN users u ON u.id=w.created_by WHERE u.email = ?').get('cliente@exemplo.invalid');
console.log(r ? r.id : '');
" 2>/dev/null | tr -d '\r')

ORIGINAL=$(docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
console.log(db.prepare('SELECT plan_id FROM workspaces WHERE id = ?').get('$WS').plan_id);
" 2>/dev/null | tr -d '\r')

S=$(entrar "$EMAIL" "$SENHA")

por_plano() {
  docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
db.prepare('UPDATE workspaces SET plan_id = ? WHERE id = ?').run('$1','$WS');
" >/dev/null 2>&1
  curl -s -o /tmp/plano.json -w '%{http_code}' -X POST $OP/api/auth/federation/gestao -H "Authorization: Bearer $S"
}

echo "=== os quatro planos, mesmo usuario ==="

COD=$(por_plano free)
if [ "$COD" = "403" ] && grep -q GESTAO_NOT_IN_PLAN /tmp/plano.json; then ok "free  -> recusado, e a mensagem diz o motivo"; else nok "free respondeu $COD"; fi

COD=$(por_plano pro)
if [ "$COD" = "403" ] && grep -q GESTAO_NOT_IN_PLAN /tmp/plano.json; then ok "pro   -> recusado"; else nok "pro respondeu $COD"; fi

COD=$(por_plano master)
[ "$COD" = "200" ] && ok "master-> liberado" || nok "master respondeu $COD (esperava 200)"

COD=$(por_plano gestao)
[ "$COD" = "200" ] && ok "gestao-> liberado" || nok "gestao respondeu $COD (esperava 200)"

echo
echo "=== a recusa e do SERVIDOR, nao da tela ==="
por_plano pro >/dev/null
COD=$(curl -s -o /dev/null -w '%{http_code}' -X POST $OP/api/auth/federation/gestao -H "Authorization: Bearer $S")
[ "$COD" = "403" ] && ok "chamar a rota direto tambem e barrado" || nok "a rota direta passou: $COD"

echo "=== a mensagem nomeia o plano do cliente ==="
curl -s -X POST $OP/api/auth/federation/gestao -H "Authorization: Bearer $S" | sed 's/^/  /'

# devolve o plano que o workspace tinha
docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
db.prepare('UPDATE workspaces SET plan_id = ? WHERE id = ?').run('$ORIGINAL','$WS');
" >/dev/null 2>&1
echo
echo "  (plano do workspace devolvido para: $ORIGINAL)"

echo
[ "$falhas" = "0" ] && echo "O PORTAO DO PLANO FECHA E ABRE NOS QUATRO" || echo "$falhas CASO(S) FALHARAM"
exit $falhas
