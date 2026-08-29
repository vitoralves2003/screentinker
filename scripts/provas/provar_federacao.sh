#!/bin/sh
# Prova da Fase 2: entrar uma vez na Operacao e alcancar a Gestao.
#
# Os seis primeiros casos sao o caminho feliz. Os oito seguintes sao as RECUSAS, e sao
# eles que importam: uma federacao que aceita o que deveria negar nao e federacao, e um
# buraco. O caso 12 em particular existe porque esse buraco chegou a existir aqui.

OP=http://127.0.0.1:3110
GE=http://127.0.0.1:3121
EMAIL=teste-ambiente-novo@exemplo.invalid
SENHA='SenhaDeTeste#2026'

# entrar() atravessa a segunda etapa, que passou a ser exigida do titular.
. /tmp/mfa_lib.sh

falhas=0
ok()  { echo "  OK     $1"; }
nok() { echo "  FALHOU $1"; falhas=$((falhas+1)); }
ejwt() { echo "$1" | grep -qE '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'; }

# Esta conta e rematriculada por outras provas, com um segredo que esta biblioteca nao
# conhece. Rematricular aqui torna o resultado independente da ordem de execucao.
preparar_mfa "$EMAIL" "$SENHA"

echo "=== 1. entrar na Operacao (senha + segunda etapa) ==="
SESSAO=$(entrar "$EMAIL" "$SENHA")
if ejwt "$SESSAO"; then ok "sessao completa obtida"; else
  nok "nao consegui entrar: $(echo "$SESSAO" | head -c 120)"
  echo
  echo "  (sem sessao nao ha o que provar -- os casos seguintes so repetiriam esta causa)"
  exit 1
fi

echo "=== 2. pedir o token de troca ==="
TROCA=$(curl -s -X POST $OP/api/auth/federation/gestao -H "Authorization: Bearer $SESSAO" \
  | sed -E 's/.*"token":"([^"]+)".*/\1/')
ejwt "$TROCA" && ok "token de troca emitido" || nok "nao veio token de troca: $(echo "$TROCA" | head -c 120)"

echo "=== 3. trocar por uma sessao da Gestao ==="
RESP=$(curl -s -X POST $GE/auth/federated -H 'Content-Type: application/json' -d "{\"token\":\"$TROCA\"}")
GTOK=$(echo "$RESP" | sed -E 's/.*"accessToken":"([^"]+)".*/\1/')
if [ -n "$GTOK" ] && [ "$GTOK" != "$RESP" ]; then ok "sessao da Gestao emitida"; else nok "troca recusada: $(echo "$RESP" | head -c 200)"; fi

echo "=== 4. usar essa sessao numa rota real da Gestao ==="
COD=$(curl -s -o /dev/null -w '%{http_code}' $GE/clients -H "Authorization: Bearer $GTOK")
[ "$COD" = "200" ] && ok "rota de clientes respondeu 200" || nok "rota de clientes respondeu $COD"

echo "=== 5. o papel atravessou como TITULAR ==="
echo "$RESP" | grep -q '"role":"TITULAR"' && ok "papel TITULAR" || nok "papel nao veio TITULAR"

echo "=== 6. a organizacao e a MESMA dos dois lados ==="
ORG_OP=$(echo "$TROCA" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null | sed -E 's/.*"organizationId":"([^"]+)".*/\1/')
if [ -z "$ORG_OP" ]; then nok "nao consegui ler a organizacao do token de troca"
elif echo "$RESP" | grep -q "$ORG_OP"; then ok "mesmo id nos dois: $ORG_OP"
else nok "ids diferentes"; fi

echo
echo "=== AS RECUSAS ==="

echo "--- 7. token de troca nao serve como sessao da Gestao ---"
COD=$(curl -s -o /dev/null -w '%{http_code}' $GE/clients -H "Authorization: Bearer $TROCA")
[ "$COD" = "401" ] && ok "recusado (401)" || nok "aceitou um token de troca como sessao: $COD"

echo "--- 8. sessao da Operacao nao serve como sessao da Gestao ---"
COD=$(curl -s -o /dev/null -w '%{http_code}' $GE/clients -H "Authorization: Bearer $SESSAO")
[ "$COD" = "401" ] && ok "recusado (401)" || nok "aceitou a sessao do outro sistema: $COD"

echo "--- 9. token adulterado e recusado ---"
ADULT=$(echo "$TROCA" | sed 's/.$/X/')
COD=$(curl -s -o /dev/null -w '%{http_code}' -X POST $GE/auth/federated -H 'Content-Type: application/json' -d "{\"token\":\"$ADULT\"}")
[ "$COD" = "401" ] && ok "recusado (401)" || nok "aceitou token adulterado: $COD"

echo "--- 10. sem token, recusa ---"
COD=$(curl -s -o /dev/null -w '%{http_code}' -X POST $GE/auth/federated -H 'Content-Type: application/json' -d '{}')
[ "$COD" = "401" ] && ok "recusado (401)" || nok "aceitou requisicao sem token: $COD"

echo "--- 11. token assinado com OUTRO segredo e recusado ---"
FORJADO=$(docker exec novo-gestao-api node -e "
const {sign}=require('jsonwebtoken');
console.log(sign({sub:'x',email:'invasor@x.com',role:'TITULAR',organizationId:'$ORG_OP'},'segredo-errado',{expiresIn:'60s',audience:'gestao',issuer:'operacao'}));
" 2>/dev/null | tr -d '\r')
COD=$(curl -s -o /dev/null -w '%{http_code}' -X POST $GE/auth/federated -H 'Content-Type: application/json' -d "{\"token\":\"$FORJADO\"}")
[ "$COD" = "401" ] && ok "recusado (401)" || nok "aceitou token forjado: $COD"

echo "--- 12. o login proprio da Gestao esta fechado ---"
COD=$(curl -s -o /tmp/fed_login.json -w '%{http_code}' -X POST $GE/auth/login -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$SENHA\"}")
if [ "$COD" = "401" ]; then
  ok "recusado (401): $(sed -E 's/.*"message":"([^"]*)".*/\1/' /tmp/fed_login.json | head -c 80)"
else
  nok "o login proprio ainda aceita senha: $COD"
fi

echo "--- 13. a senha orfa foi apagada do banco ---"
SEMSENHA=$(docker exec novo-gestao-postgres psql -U novo -d novo_gestao -tAc "select (\"passwordHash\" is null) from \"User\" where email = '$EMAIL';" | tr -d ' \r')
[ "$SEMSENHA" = "t" ] && ok "conta sem senha gravada" || nok "ainda ha hash de senha guardado"

echo "--- 14. o admin de plataforma continua tendo porta ---"
COD=$(curl -s -o /dev/null -w '%{http_code}' -X POST $GE/platform/auth/login -H 'Content-Type: application/json' -d '{"email":"x@x.com","password":"y"}')
[ "$COD" != "404" ] && ok "porta do Admin existe (respondeu $COD, nao 404)" || nok "a porta do Admin sumiu"

echo
[ "$falhas" = "0" ] && echo "TODOS OS 14 CASOS DA FEDERACAO FECHARAM" || echo "$falhas CASO(S) FALHARAM"
exit $falhas
