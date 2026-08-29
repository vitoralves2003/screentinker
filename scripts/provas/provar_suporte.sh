#!/bin/sh
. /tmp/mfa_lib.sh
# Prova do acesso de suporte: o dono da plataforma entra na Gestao de um cliente.
#
# Cada verificacao confere a FORMA do que recebeu, nao apenas se veio algo. A primeira
# versao deste teste imprimiu "OK" segurando uma mensagem de erro, porque so olhava se a
# variavel estava vazia.

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

WS=$(docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
const r=db.prepare('SELECT w.id FROM workspaces w JOIN users u ON u.id=w.created_by WHERE u.email LIKE ?').get('teste-ambiente-novo%');
console.log(r ? r.id : '');
" 2>/dev/null | tr -d '\r')

ANTES=$(docker exec novo-gestao-postgres psql -U novo -d novo_gestao -tAc "select count(*) from \"User\";" | tr -d ' \r')
AUD_ANTES=$(docker exec novo-gestao-postgres psql -U novo -d novo_gestao -tAc "select count(*) from \"AdminAuditLog\" where action = 'gestao.acesso_suporte';" | tr -d ' \r')

echo "=== 1. o suporte entra na Operacao (senha + segunda etapa) ==="
# Quem da suporte tambem passa pela segunda etapa: e quem tem mais alcance, e o portao
# da Gestao nao abre excecao para ele.
S=$(entrar "$SUP_EMAIL" "$SUP_SENHA")
ejwt "$S" && ok "sessao de plataforma" || nok "nao entrou: $(echo "$S" | head -c 120)"

echo "=== 2. alcanca o workspace do cliente (sem ser membro dele) ==="
S2=$(curl -s -X POST $OP/api/auth/switch-workspace -H "Authorization: Bearer $S" \
  -H 'Content-Type: application/json' -d "{\"workspace_id\":\"$WS\"}" | sed -E 's/.*"token":"([^"]+)".*/\1/')
ejwt "$S2" && ok "entrou no workspace do cliente" || nok "nao alcancou: $S2"

echo "=== 3. o token de troca vem MARCADO como acesso de suporte ==="
T=$(curl -s -X POST $OP/api/auth/federation/gestao -H "Authorization: Bearer $S2" | sed -E 's/.*"token":"([^"]+)".*/\1/')
if ejwt "$T"; then
  C=$(claims "$T")
  echo "$C" | grep -q '"actingAs":true' && ok "actingAs verdadeiro" || nok "veio sem a marca: $(echo "$C" | head -c 200)"
  echo "$C" | grep -q '"role":"TITULAR"' && ok "papel TITULAR (suporte administra)" || nok "papel inesperado"
else
  nok "nao veio token de troca"
fi

echo "=== 4. a Gestao aceita e devolve sessao de suporte ==="
R=$(curl -s -X POST $GE/auth/federated -H 'Content-Type: application/json' -d "{\"token\":\"$T\"}")
G=$(echo "$R" | sed -E 's/.*"accessToken":"([^"]+)".*/\1/')
ejwt "$G" && ok "sessao emitida" || nok "recusada: $(echo "$R" | head -c 200)"
echo "$R" | grep -q '"actingAs":true' && ok "resposta diz que e acesso de suporte" || nok "resposta nao marca o acesso"
echo "$R" | grep -q '"expiresIn":1800' && ok "dura 30 minutos, nao uma hora" || nok "duracao inesperada"

echo "=== 5. a sessao de suporte abre o financeiro do cliente ==="
COD=$(curl -s -o /dev/null -w '%{http_code}' $GE/clients -H "Authorization: Bearer $G")
[ "$COD" = "200" ] && ok "alcancou os dados do cliente" || nok "respondeu $COD"

echo
echo "=== O QUE NAO PODE TER ACONTECIDO ==="

echo "--- 6. nenhum usuario novo foi criado ---"
DEPOIS=$(docker exec novo-gestao-postgres psql -U novo -d novo_gestao -tAc "select count(*) from \"User\";" | tr -d ' \r')
[ "$ANTES" = "$DEPOIS" ] && ok "continuam $DEPOIS usuario(s)" || nok "criou usuario: $ANTES -> $DEPOIS"

echo "--- 7. o suporte NAO aparece entre as pessoas do cliente ---"
TEM=$(docker exec novo-gestao-postgres psql -U novo -d novo_gestao -tAc "select count(*) from \"User\" where email = '$SUP_EMAIL';" | tr -d ' \r')
[ "$TEM" = "0" ] && ok "nao existe como usuario da empresa" || nok "virou usuario do cliente"

echo "--- 8. o titular do cliente continua titular ---"
P=$(docker exec novo-gestao-postgres psql -U novo -d novo_gestao -tAc "select role::text from \"User\" where email = '$CLIENTE_EMAIL';" | tr -d ' \r')
[ "$P" = "TITULAR" ] && ok "intacto" || nok "papel do cliente virou $P"

echo
echo "=== O REGISTRO ==="
AUD_DEPOIS=$(docker exec novo-gestao-postgres psql -U novo -d novo_gestao -tAc "select count(*) from \"AdminAuditLog\" where action = 'gestao.acesso_suporte';" | tr -d ' \r')
[ "$AUD_DEPOIS" -gt "$AUD_ANTES" ] && ok "acesso registrado ($AUD_ANTES -> $AUD_DEPOIS)" || nok "nada foi registrado"
docker exec novo-gestao-postgres psql -U novo -d novo_gestao -tAc \
  "select metadata::text from \"AdminAuditLog\" where action = 'gestao.acesso_suporte' order by \"createdAt\" desc limit 1;" | sed 's/^/  /'

echo
[ "$falhas" = "0" ] && echo "TODOS OS CASOS DO ACESSO DE SUPORTE FECHARAM" || echo "$falhas CASO(S) FALHARAM"
exit $falhas
