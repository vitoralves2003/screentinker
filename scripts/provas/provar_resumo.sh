#!/bin/sh
# A Operacao responde "como estao as telas desta organizacao" -- e agora responde para o
# NAVEGADOR, com a sessao de quem pergunta.
#
# ── ESTA SUITE ESTAVA MEDINDO UMA ROTA QUE NAO EXISTIA MAIS ──────────────────────────────
# Ela batia em /api/federation/telas, uma rota servidor-com-servidor atras de um token
# assinado com FEDERATION_SECRET. Quatro dos sete casos eram sobre esse token: audiencia
# errada, segredo errado, sem organizacao.
#
# A rota foi apagada na Etapa 1 e virou /api/resumo/telas, atras da sessao normal. A suite
# continuou apontando para o endereco velho e passou a devolver 404 em tudo -- inclusive nas
# recusas, que "passavam" por motivo nenhum. Um 404 nao e uma recusa; e a ausencia de qualquer
# opiniao.
#
# O que sobreviveu da versao anterior sao os tres casos que nunca foram sobre o token:
# recusar quem nao tem sessao, concordar com a visao geral, e nao responder pela organizacao
# de outra pessoa.

OP=http://127.0.0.1:3110
EMAIL=cliente@exemplo.invalid
SENHA='SenhaCliente#2026'
OUTRO_EMAIL=vitor@loop.local

. /tmp/mfa_lib.sh

falhas=0
ok()  { echo "  OK     $1"; }
nok() { echo "  FALHOU $1"; falhas=$((falhas+1)); }

claim() {
  echo "$1" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('$2',''))" 2>/dev/null
}

echo "=== AS RECUSAS ==="

echo "--- 1. sem token ---"
COD=$(curl -s -o /dev/null -w '%{http_code}' $OP/api/resumo/telas)
[ "$COD" = "401" ] && ok "recusado (401)" || nok "respondeu $COD"

echo "--- 2. token assinado com outro segredo ---"
T=$(docker exec novo-gestao-api node -e "
const {sign}=require('jsonwebtoken');
console.log(sign({id:'x',email:'invasor@x.com',papel:'TITULAR',organization_id:'qualquer'},'segredo-errado',{expiresIn:'60s'}));
" 2>/dev/null | tr -d '\r')
COD=$(curl -s -o /dev/null -w '%{http_code}' $OP/api/resumo/telas -H "Authorization: Bearer $T")
[ "$COD" = "401" ] && ok "recusado (401)" || nok "aceitou token forjado: $COD"

echo "--- 3. token que nao e token ---"
COD=$(curl -s -o /dev/null -w '%{http_code}' $OP/api/resumo/telas -H "Authorization: Bearer nao.e.jwt")
[ "$COD" = "401" ] && ok "recusado (401)" || nok "respondeu $COD"

echo
echo "=== O CAMINHO CERTO ==="

S=$(entrar "$EMAIL" "$SENHA")
if [ -z "$S" ]; then
  nok "nao consegui entrar -- os casos seguintes so repetiriam esta causa"
  exit 1
fi

R=$(curl -s $OP/api/resumo/telas -H "Authorization: Bearer $S")
echo "$R" | grep -q '"total"' && ok "resumo devolvido" || nok "resposta inesperada: $(echo "$R" | head -c 200)"
echo "  $R"

echo
echo "=== BATE COM A VISAO GERAL DA OPERACAO? ==="
# A pergunta que importa: a rota do resumo conta as MESMAS telas que a pagina de Operacao
# conta. Duas contagens da mesma coisa que discordam e como um cliente descobre que uma delas
# esta errada -- e nao ha como saber qual.
V=$(curl -s $OP/api/devices/overview -H "Authorization: Bearer $S")
TOT_V=$(echo "$V" | sed -E 's/.*"screens":\{"total":([0-9]+).*/\1/')
TOT_R=$(echo "$R" | sed -E 's/.*"total":([0-9]+).*/\1/')
if [ -n "$TOT_R" ] && [ "$TOT_V" = "$TOT_R" ]; then
  ok "as duas dizem $TOT_R telas"
else
  nok "visao geral diz '$TOT_V', resumo diz '$TOT_R'"
fi

echo
echo "=== A ORGANIZACAO E A DE QUEM PERGUNTA ==="
# Antes isto se provava assinando um token com a organizacao de outro cliente. Sem o segredo
# nao da mais, e nem deveria: a organizacao agora vem da SESSAO, nao de um campo que quem
# chama escolhe. A prova equivalente e entrar como outra pessoa e ver outra resposta.
ORG=$(claim "$S" organization_id)
echo "$R" | grep -q "\"organization_id\":\"$ORG\"" \
  && ok "responde pela organizacao da sessao ($ORG)" \
  || nok "a resposta nao traz a organizacao da sessao"

OUTRA_SENHA=$(docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
const u=db.prepare('SELECT id FROM users WHERE email = ?').get('$OUTRO_EMAIL');
console.log(u ? 'existe' : '');
" 2>/dev/null | tr -d '\r')

if [ -z "$OUTRA_SENHA" ]; then
  echo "  (nao ha outra conta para comparar -- caso nao aplicavel)"
else
  # Nao se sabe a senha da outra conta, e nem e preciso: basta confirmar que a organizacao
  # dela e outra e que a resposta acima nao a menciona.
  OUTRA_ORG=$(docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
const u=db.prepare('SELECT id FROM users WHERE email = ?').get('$OUTRO_EMAIL');
const w=db.prepare('SELECT organization_id FROM workspaces WHERE created_by = ?').get(u.id);
console.log(w ? w.organization_id : '');
" 2>/dev/null | tr -d '\r')
  if [ -z "$OUTRA_ORG" ] || [ "$OUTRA_ORG" = "$ORG" ]; then
    echo "  (a outra conta nao tem organizacao propria -- caso nao aplicavel)"
  else
    echo "$R" | grep -q "$OUTRA_ORG" \
      && nok "a resposta menciona a organizacao de outro cliente ($OUTRA_ORG)" \
      || ok "nao menciona a organizacao do outro cliente"
  fi
fi

echo
[ "$falhas" = "0" ] && echo "O RESUMO DE TELAS FECHOU" || echo "$falhas CASO(S) FALHARAM"
exit $falhas
