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
UNI=http://127.0.0.1:3100
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
# A federacao morreu nas Etapas 1-2 e esta prova ficou meses atravessando por um tunel que
# nao existe (/api/auth/federation/gestao + /auth/federated, ambos apagados) — quebrada em
# silencio, porque ninguem a rodava. Desde a sessao unica o token da Operacao E a sessao da
# Gestao, pela mesma origem que o navegador usa.
CARTAO=$(curl -s $UNI/gestao-api/dashboard/telas -H "Authorization: Bearer $S")
echo "$CARTAO" | grep -q '"links"' && ok "o cartao recebeu os links" || nok "sem links no cartao: $(echo "$CARTAO" | head -c 160)"

# Os links tem de ser da OPERACAO, nao montados pela Gestao. Flip de 02/09: o recorte
# abre na pagina React de Telas, que le o mesmo filtro do hash.
echo "$CARTAO" | grep -q '"attention":"[^"]*/gestao/telas#/devices?f=atencao"' \
  && ok "o link de atencao aponta para o recorte, nao para a lista inteira" \
  || nok "link de atencao inesperado"

echo "=== 2. cada numero bate com o tamanho do recorte que ele abre ==="

# JSON lido como JSON, e nao raspado com sed. Contar '"id"' no corpo inteiro contaria tambem
# os objetos de cobranca e de biblioteca; e um sed que nao casa devolve vazio, entao comparar
# dois vazios daria um "OK" sobre nada. Os dois ja aprovaram lixo neste conjunto de provas.
campo() { python3 -c "import json,sys; d=json.load(sys.stdin); print(d$1)" 2>/dev/null; }

C_TOTAL=$(echo   "$CARTAO" | campo "['total']")
C_ONLINE=$(echo  "$CARTAO" | campo "['online']")
C_OFFLINE=$(echo "$CARTAO" | campo "['offline']")
C_AT=$(echo      "$CARTAO" | campo "['attention_total']")
echo "  cartao: total=$C_TOTAL no-ar=$C_ONLINE fora=$C_OFFLINE atencao=$C_AT"

# A mesma fonte que o navegador consulta ao abrir ?f=atencao: os ids DENTRO de attention.
VISAO=$(curl -s $OP/api/devices/overview -H "Authorization: Bearer $S")
O_AT=$(echo      "$VISAO" | campo "['attention'].__len__()")
O_ONLINE=$(echo  "$VISAO" | campo "['screens']['online']")
O_OFFLINE=$(echo "$VISAO" | campo "['screens']['offline']")

# Um numero que nao foi lido nao pode virar um caso que passa.
numerico() { echo "$1" | grep -qE '^-?[0-9]+$'; }
comparar() { # comparar ROTULO A B
  if ! numerico "$2" || ! numerico "$3"; then nok "$1: nao consegui ler os dois numeros ('$2' / '$3')"
  elif [ "$2" = "$3" ]; then ok "$1: os dois dizem $2"
  else nok "$1: cartao $2 x Operacao $3 -- o link levaria a outra quantidade"; fi
}

comparar "atencao"     "$C_AT"     "$O_AT"
comparar "no ar"       "$C_ONLINE" "$O_ONLINE"
comparar "fora do ar"  "$C_OFFLINE" "$O_OFFLINE"

echo "=== 3. a rota filtrada e servida (o navegador chega nela) ==="
# Flip de 02/09: os links levam a /gestao/telas, que hospeda a MESMA lista antiga.
for f in atencao fora-do-ar no-ar; do
  COD=$(curl -s -o /dev/null -w '%{http_code}' "$UNI/gestao/telas")
  [ "$COD" = "200" ] || { nok "a pagina de Telas nao respondeu para ?f=$f (HTTP $COD)"; continue; }
  ok "?f=$f: /gestao/telas respondeu 200 (o filtro vive no fragmento, lido pelo navegador)"
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
