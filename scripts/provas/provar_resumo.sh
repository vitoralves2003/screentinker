#!/bin/sh
# Passo 1: a Operacao responde "como estao as telas desta organizacao".
#
# Os quatro primeiros casos sao as recusas. Uma rota servidor-com-servidor que aceita o
# que deveria negar e pior que uma rota ausente: ela parece protegida.

OP=http://127.0.0.1:3110

falhas=0
ok()  { echo "  OK     $1"; }
nok() { echo "  FALHOU $1"; falhas=$((falhas+1)); }

SEG=$(grep '^FEDERATION_SECRET=' /opt/novo-operacao/.env | cut -d= -f2)

# assina() ORG AUDIENCE ISSUER SEGREDO
assina() {
  docker exec novo-gestao-api node -e "
const {sign}=require('jsonwebtoken');
console.log(sign({organizationId:'$1'},'$4',{expiresIn:'60s',audience:'$2',issuer:'$3'}));
" 2>/dev/null | tr -d '\r'
}

ORG=$(docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
const u=db.prepare('SELECT id FROM users WHERE email = ?').get('cliente@exemplo.invalid');
const w=db.prepare('SELECT organization_id FROM workspaces WHERE created_by = ?').get(u.id);
console.log(w ? w.organization_id : '');
" 2>/dev/null | tr -d '\r')

echo "=== AS RECUSAS ==="

echo "--- 1. sem token ---"
COD=$(curl -s -o /dev/null -w '%{http_code}' $OP/api/federation/telas)
[ "$COD" = "401" ] && ok "recusado (401)" || nok "respondeu $COD"

echo "--- 2. token assinado com outro segredo ---"
T=$(assina "$ORG" operacao gestao segredo-errado)
COD=$(curl -s -o /dev/null -w '%{http_code}' $OP/api/federation/telas -H "Authorization: Bearer $T")
[ "$COD" = "401" ] && ok "recusado (401)" || nok "aceitou token forjado: $COD"

echo "--- 3. token da OUTRA direcao (audience gestao) nao serve aqui ---"
T=$(assina "$ORG" gestao operacao "$SEG")
COD=$(curl -s -o /dev/null -w '%{http_code}' $OP/api/federation/telas -H "Authorization: Bearer $T")
[ "$COD" = "401" ] && ok "recusado (401) — a audiencia separa os dois sentidos" || nok "aceitou o token do sentido inverso: $COD"

echo "--- 4. token sem organizacao ---"
T=$(docker exec novo-gestao-api node -e "
const {sign}=require('jsonwebtoken');
console.log(sign({},'$SEG',{expiresIn:'60s',audience:'operacao',issuer:'gestao'}));
" 2>/dev/null | tr -d '\r')
COD=$(curl -s -o /dev/null -w '%{http_code}' $OP/api/federation/telas -H "Authorization: Bearer $T")
[ "$COD" = "400" ] && ok "recusado (400)" || nok "respondeu $COD"

echo
echo "=== O CAMINHO CERTO ==="

T=$(assina "$ORG" operacao gestao "$SEG")
R=$(curl -s $OP/api/federation/telas -H "Authorization: Bearer $T")
echo "$R" | grep -q '"total"' && ok "resumo devolvido" || nok "resposta inesperada: $(echo "$R" | head -c 200)"
echo "  $R"

echo
echo "=== BATE COM A VISAO GERAL DA OPERACAO? ==="
# A pergunta que importa: a rota nova conta as MESMAS telas que a pagina de Operacao conta.
. /tmp/mfa_lib.sh
S=$(entrar cliente@exemplo.invalid "SenhaCliente#2026")
V=$(curl -s $OP/api/devices/overview -H "Authorization: Bearer $S")
TOT_V=$(echo "$V" | sed -E 's/.*"screens":\{"total":([0-9]+).*/\1/')
TOT_F=$(echo "$R" | sed -E 's/.*"total":([0-9]+).*/\1/')
[ "$TOT_V" = "$TOT_F" ] && ok "as duas dizem $TOT_F telas" || nok "visao geral diz $TOT_V, federacao diz $TOT_F"

echo
echo "=== ORGANIZACAO DE OUTRO CLIENTE NAO VAZA ==="
OUTRA=$(docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
const r=db.prepare('SELECT id FROM organizations WHERE id <> ? LIMIT 1').get('$ORG');
console.log(r ? r.id : '');
" 2>/dev/null | tr -d '\r')
if [ -n "$OUTRA" ]; then
  T2=$(assina "$OUTRA" operacao gestao "$SEG")
  R2=$(curl -s $OP/api/federation/telas -H "Authorization: Bearer $T2")
  echo "$R2" | grep -q "\"organization_id\":\"$OUTRA\"" && ok "responde pela organizacao do token, nao pela do anterior" || nok "confundiu as organizacoes"
else
  echo "  (so ha uma organizacao — caso nao aplicavel)"
fi

echo
[ "$falhas" = "0" ] && echo "PASSO 1 FECHADO" || echo "$falhas CASO(S) FALHARAM"
exit $falhas
