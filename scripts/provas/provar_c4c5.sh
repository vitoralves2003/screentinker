#!/bin/sh
# C4 + C5 — o cartao de Telas aponta para as telas que ele conta.
#
# A pergunta que importa NAO e "o link existe?". E "o link leva ao numero certo?". Um cartao
# que diz "2 precisam de atencao" e leva a uma pagina com quarenta devolve ao leitor a
# pergunta que ele ja tinha respondido; um que leva a uma pagina VAZIA ensina que ele mente,
# justamente antes da noite em que uma tela morre de verdade.
#
# Por isso cada caso aqui compara o NUMERO DO CARTAO com o TAMANHO DO RECORTE que o link
# abre, pelas mesmas fontes que o navegador usa.

OP=http://127.0.0.1:3110
GE=http://127.0.0.1:3121
EMAIL=cliente@exemplo.invalid
SENHA='SenhaCliente#2026'

. /tmp/mfa_lib.sh 2>/dev/null || . "$(dirname "$0")/mfa_lib.sh"

falhas=0
ok()  { echo "  OK     $1"; }
nok() { echo "  FALHOU $1"; falhas=$((falhas+1)); }

until [ "$(curl -s -o /dev/null -w '%{http_code}' $OP/)" != "000" ]; do sleep 2; done
preparar_mfa "$EMAIL" "$SENHA"
S=$(entrar "$EMAIL" "$SENHA")
[ -n "$S" ] || { echo "  FALHOU nao autenticou -- sem sessao nao ha o que provar"; exit 1; }

echo "=== 1. a Operacao serve os links junto com os numeros ==="
T=$(curl -s -X POST $OP/api/auth/federation/gestao -H "Authorization: Bearer $S" \
      | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
G=$(curl -s -X POST $GE/auth/federated -H 'Content-Type: application/json' \
      -d "{\"token\":\"$T\"}" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
[ -n "$G" ] || { echo "  FALHOU nao consegui uma sessao da Gestao"; exit 1; }

CARTAO=$(curl -s $GE/dashboard/telas -H "Authorization: Bearer $G")
echo "$CARTAO" | grep -q '"links"' && ok "o cartao recebeu os links" || nok "sem links no cartao: $(echo "$CARTAO" | head -c 160)"

# Os links tem de ser da OPERACAO, nao montados pela Gestao.
echo "$CARTAO" | grep -q '"attention":"http[^"]*app#/devices?f=atencao"' \
  && ok "o link de atencao aponta para o recorte, nao para a lista inteira" \
  || nok "link de atencao inesperado"

echo "=== 2. cada numero bate com o tamanho do recorte que ele abre ==="
num() { echo "$CARTAO" | sed -n "s/.*\"$1\":\([0-9-]*\).*/\1/p"; }
C_TOTAL=$(num total); C_ONLINE=$(num online); C_OFFLINE=$(num offline); C_AT=$(num attention_total)
echo "  cartao: total=$C_TOTAL no-ar=$C_ONLINE fora=$C_OFFLINE atencao=$C_AT"

# A mesma fonte que o navegador consulta ao abrir ?f=atencao.
VISAO=$(curl -s $OP/api/devices/overview -H "Authorization: Bearer $S")
O_AT=$(echo "$VISAO" | tr '{' '\n' | grep -c '"id"')
O_ONLINE=$(echo "$VISAO" | sed -n 's/.*"online":\([0-9]*\).*/\1/p')
O_OFFLINE=$(echo "$VISAO" | sed -n 's/.*"offline":\([0-9]*\).*/\1/p')

[ "$C_AT" = "$O_AT" ] \
  && ok "atencao: o cartao diz $C_AT e o recorte abre $O_AT" \
  || nok "atencao: cartao $C_AT x recorte $O_AT -- o link mentiria"

[ "$C_ONLINE" = "$O_ONLINE" ] \
  && ok "no ar: os dois dizem $C_ONLINE" \
  || nok "no ar: cartao $C_ONLINE x Operacao $O_ONLINE"

[ "$C_OFFLINE" = "$O_OFFLINE" ] \
  && ok "fora do ar: os dois dizem $C_OFFLINE" \
  || nok "fora do ar: cartao $C_OFFLINE x Operacao $O_OFFLINE"

echo "=== 3. a rota filtrada e servida (o navegador chega nela) ==="
for f in atencao fora-do-ar no-ar; do
  COD=$(curl -s -o /dev/null -w '%{http_code}' "$OP/app")
  [ "$COD" = "200" ] || { nok "a Operacao nao serviu /app para ?f=$f (HTTP $COD)"; continue; }
  ok "?f=$f: /app respondeu 200 (o filtro vive no fragmento, lido pelo navegador)"
done

echo "=== 4. o codigo do filtro esta no arquivo servido, nao so no repositorio ==="
JS=$(curl -s $OP/js/views/dashboard.js)
echo "$JS" | grep -q 'resolverRestricao' && ok "o resolvedor de filtro foi servido" || nok "dashboard.js servido nao tem o filtro"
echo "$JS" | grep -q "getOverview" && ok "f=atencao pergunta ao servidor (nao recalcula)" || nok "nao encontrei a consulta ao servidor"

echo "=== 5. a linha da barra lateral aponta para o recorte ==="
H=$(curl -s $OP/index.html)
echo "$H" | grep -q 'id="fleetAlert"' && {
  echo "$H" | grep -q 'href="#/devices?f=atencao"[^>]*id="fleetAlert"' \
    && ok "a linha de alerta leva as telas que ela conta" \
    || nok "a linha de alerta ainda leva a lista inteira"
} || nok "nao encontrei a linha de alerta"

echo
[ "$falhas" = "0" ] && echo "C4+C5: tudo passou" || echo "C4+C5: $falhas falha(s)"
exit $falhas
