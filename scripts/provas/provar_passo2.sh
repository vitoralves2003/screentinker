#!/bin/sh
# Passo 2: a Gestao pergunta a Operacao, servidor com servidor.
#
# O caso que mais importa e o ultimo: com a Operacao FORA DO AR, o painel financeiro tem
# de continuar carregando. Um painel que morre inteiro porque um cartao nao respondeu e
# pior que um cartao vazio.

GE=http://127.0.0.1:3121
EMAIL=cliente@exemplo.invalid
SENHA='SenhaCliente#2026'

. /tmp/mfa_lib.sh

falhas=0
ok()  { echo "  OK     $1"; }
nok() { echo "  FALHOU $1"; falhas=$((falhas+1)); }

# entra na Operacao e troca por uma sessao da Gestao
S=$(entrar "$EMAIL" "$SENHA")
T=$(curl -s -X POST http://127.0.0.1:3110/api/auth/federation/gestao -H "Authorization: Bearer $S" \
  | sed -E 's/.*"token":"([^"]+)".*/\1/')
G=$(curl -s -X POST $GE/auth/federated -H 'Content-Type: application/json' -d "{\"token\":\"$T\"}" \
  | sed -E 's/.*"accessToken":"([^"]+)".*/\1/')

echo "=== 1. a Gestao devolve o resumo de telas ==="
R=$(curl -s $GE/dashboard/telas -H "Authorization: Bearer $G")
echo "$R" | grep -q '"disponivel":true' && ok "disponivel" || nok "indisponivel: $(echo "$R" | head -c 200)"
echo "  $R"

echo "=== 2. os numeros sao os mesmos que a Operacao respondeu ==="
SEG=$(grep '^FEDERATION_SECRET=' /opt/novo-operacao/.env | cut -d= -f2)
ORG=$(echo "$G" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null | sed -E 's/.*"organizationId":"([^"]+)".*/\1/')
TF=$(docker exec novo-gestao-api node -e "
const {sign}=require('jsonwebtoken');
console.log(sign({organizationId:'$ORG'},'$SEG',{expiresIn:'60s',audience:'operacao',issuer:'gestao'}));
" 2>/dev/null | tr -d '\r')
DIRETO=$(curl -s http://127.0.0.1:3110/api/federation/telas -H "Authorization: Bearer $TF")
A=$(echo "$R" | sed -E 's/.*"total":([0-9]+).*/\1/')
B=$(echo "$DIRETO" | sed -E 's/.*"total":([0-9]+).*/\1/')
[ "$A" = "$B" ] && ok "as duas dizem $A telas" || nok "Gestao diz $A, Operacao diz $B"

echo "=== 3. quem nao esta autenticado nao alcanca ==="
COD=$(curl -s -o /dev/null -w '%{http_code}' $GE/dashboard/telas)
[ "$COD" = "401" ] && ok "recusado (401)" || nok "respondeu $COD"

echo
echo "=== 4. COM A OPERACAO FORA DO AR ==="
docker stop novo-operacao >/dev/null 2>&1
sleep 2

INI=$(date +%s)
R2=$(curl -s $GE/dashboard/telas -H "Authorization: Bearer $G")
DUR=$(( $(date +%s) - INI ))

echo "$R2" | grep -q '"disponivel":false' && ok "o cartao se declara indisponivel" || nok "resposta inesperada: $(echo "$R2" | head -c 200)"
echo "$R2" | grep -q 'Operação' && ok "e diz o motivo em portugues" || nok "sem motivo legivel"
[ "$DUR" -le 5 ] && ok "respondeu em ${DUR}s (nao ficou pendurado)" || nok "demorou ${DUR}s"

echo "--- e o painel financeiro, continua de pe? ---"
COD=$(curl -s -o /dev/null -w '%{http_code}' "$GE/dashboard/overview" -H "Authorization: Bearer $G")
[ "$COD" = "200" ] && ok "o resto do painel carrega (200)" || nok "o painel caiu junto: $COD"

docker start novo-operacao >/dev/null 2>&1
echo "  (Operacao religada)"

echo
[ "$falhas" = "0" ] && echo "PASSO 2 FECHADO" || echo "$falhas CASO(S) FALHARAM"
exit $falhas
