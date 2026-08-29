#!/bin/sh
# Prova do portao de segunda etapa: ele recusa, e ele ABRE.
#
# Um portao so testado do lado que recusa nao esta testado: um "return 403" incondicional
# passaria em todos os casos negativos e reprovaria em nenhum.

OP=http://127.0.0.1:3110
GE=http://127.0.0.1:3121
EMAIL=teste-ambiente-novo@exemplo.invalid
SENHA='SenhaDeTeste#2026'

. /tmp/mfa_lib.sh

# Esta prova ATIVA a segunda etapa -- entao ela precisa comecar sem. Sem esta linha, a
# primeira rodada passa e todas as seguintes reprovam num produto intacto.
zerar_mfa "$EMAIL"

falhas=0
ok()  { echo "  OK     $1"; }
nok() { echo "  FALHOU $1"; falhas=$((falhas+1)); }
ejwt() { echo "$1" | grep -qE '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'; }

S=$(curl -s -X POST $OP/api/auth/login -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$SENHA\"}" | sed -E 's/.*"token":"([^"]+)".*/\1/')

echo "=== 1. antes de ativar: a Gestao recusa ==="
COD=$(curl -s -o /tmp/mfa1.json -w '%{http_code}' -X POST $OP/api/auth/federation/gestao -H "Authorization: Bearer $S")
if [ "$COD" = "403" ] && grep -q MFA_REQUIRED /tmp/mfa1.json; then ok "403 MFA_REQUIRED"; else nok "esperava 403 MFA_REQUIRED, veio $COD"; fi

echo "=== 2. e as telas seguem acessiveis ==="
COD=$(curl -s -o /dev/null -w '%{http_code}' $OP/api/devices/overview -H "Authorization: Bearer $S")
[ "$COD" = "200" ] && ok "a Operacao nao foi interrompida" || nok "as telas tambem foram bloqueadas: $COD"

echo "=== 3. o titular ativa a segunda etapa ==="
SEGREDO=$(curl -s -X POST $OP/api/auth/totp/setup -H "Authorization: Bearer $S" | sed -E 's/.*"secret":"([^"]+)".*/\1/')
if [ -n "$SEGREDO" ]; then ok "segredo emitido"; else nok "nao veio segredo"; fi

CODIGO=$(docker exec novo-operacao node -e "
const {authenticator}=require('/app/server/node_modules/otplib');
console.log(authenticator.generate('$SEGREDO'));
" 2>/dev/null | tr -d '\r')
echo "$CODIGO" | grep -qE '^[0-9]{6}$' && ok "codigo de 6 digitos gerado" || nok "codigo invalido: $CODIGO"

RESP=$(curl -s -X POST $OP/api/auth/totp/enable -H "Authorization: Bearer $S" \
  -H 'Content-Type: application/json' -d "{\"code\":\"$CODIGO\"}")
echo "$RESP" | grep -qE '"recovery|success|enabled' && ok "segunda etapa ativada" || nok "nao ativou: $(echo "$RESP" | head -c 160)"

echo "=== 4. AGORA a Gestao abre ==="
T=$(curl -s -X POST $OP/api/auth/federation/gestao -H "Authorization: Bearer $S" | sed -E 's/.*"token":"([^"]+)".*/\1/')
ejwt "$T" && ok "token de troca emitido" || nok "ainda recusa: $T"

R=$(curl -s -X POST $GE/auth/federated -H 'Content-Type: application/json' -d "{\"token\":\"$T\"}")
G=$(echo "$R" | sed -E 's/.*"accessToken":"([^"]+)".*/\1/')
ejwt "$G" && ok "sessao da Gestao emitida" || nok "a Gestao recusou: $(echo "$R" | head -c 160)"

COD=$(curl -s -o /dev/null -w '%{http_code}' $GE/clients -H "Authorization: Bearer $G")
[ "$COD" = "200" ] && ok "financeiro do cliente alcancado" || nok "respondeu $COD"

echo "=== 5. e o registro diz que a conta agora tem segunda etapa ==="
TEM=$(docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
console.log(db.prepare('SELECT totp_enabled FROM users WHERE email = ?').get('$EMAIL').totp_enabled);
" 2>/dev/null | tr -d ' \r')
[ "$TEM" = "1" ] && ok "gravado no cadastro" || nok "cadastro diz $TEM"

echo
[ "$falhas" = "0" ] && echo "O PORTAO RECUSA E ABRE, COMO DEVE" || echo "$falhas CASO(S) FALHARAM"
exit $falhas
