#!/bin/sh
# A LISTA DO CONTRATO TEM ABA PRÓPRIA — planta uma e abre o seletor num navegador.
#
# A prova precisa de uma lista de contrato DE VERDADE: sem ela, "não está em Playlists" passaria
# por vácuo, e "está em Contratos" reprovaria por falta de cenário e não por defeito.
#
# Ela planta o contrato, cria a lista pela mesma rota que a aba de Mídias chama, e abre uma tela
# para usar o seletor de adicionar conteúdo.
#
# Uso:  TOKEN=<sessao> sh provar_quarta_aba.sh

. "$(dirname "$0")/portal_cenario.sh"

[ -n "$TOKEN" ] || { echo "SEM SESSAO: passe TOKEN=..."; exit 1; }
BASE=${BASE:-https://beta.loopplayer.com.br}
UNI=${UNI:-https://beta.loopplayer.com.br/gestao}
AUTH="Authorization: Bearer $TOKEN"

ALCANCE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/portal/contratos" -H "$AUTH")
[ "$ALCANCE" = "000" ] && { echo "SEM SERVIDOR EM $BASE -- a prova nao mede nada assim"; exit 4; }

cenario_quem

limpar_tudo() {
  $PSQL "DELETE FROM playlists WHERE contrato_id IN (SELECT id FROM \"Contract\" WHERE number LIKE 'PROVA-%');" >/dev/null 2>&1
  cenario_limpar
  echo "  cenario removido"
}
trap limpar_tudo EXIT
limpar_tudo >/dev/null 2>&1

echo "== plantando o contrato e a lista dele =="
cenario_plantar
curl -s -o /dev/null -X POST "$BASE/gestao-api/contracts/$KA/lista" -H "$AUTH"
ROTULO=$($PSQL "SELECT name FROM playlists WHERE contrato_id = '$KA';")
exigir "lista do contrato" "$ROTULO"
echo "  lista: $ROTULO"

echo ""
echo "== a listagem manda os numeros do contrato =="
# Sem eles a aba nao teria o que mostrar alem do nome -- e a prova de tela nao saberia distinguir
# "o campo nao veio" de "a tela nao o desenha".
LINHA=$(curl -s "$BASE/api/playlists" -H "$AUTH" | tr ',' '\n' | grep -A0 "contrato_limite\|contrato_midias\|contrato_suspenso" | head -3)
echo "$LINHA" | grep -q "contrato_limite" && echo "  ok    contrato_limite vem na listagem" || { echo "  FALHA sem contrato_limite"; exit 1; }
echo "$LINHA" | grep -q "contrato_midias" && echo "  ok    contrato_midias vem na listagem" || { echo "  FALHA sem contrato_midias"; exit 1; }

echo ""
echo "== uma tela para abrir o seletor =="
TELA=$($PSQL "SELECT id FROM devices WHERE workspace_id IS NOT NULL LIMIT 1;")
exigir "tela" "$TELA"

echo ""
echo "======== o seletor, num navegador ========"
docker run --rm --network host --user root -v "$(cd "$(dirname "$0")" && pwd):/p" \
  -e TOKEN="$TOKEN" -e UNI="$UNI" -e TELA="$TELA" -e LISTA="$ROTULO" \
  -e NODE_PATH=/usr/src/app/node_modules \
  --entrypoint node zenika/alpine-chrome:with-puppeteer /p/a_quarta_aba.js
saida=$?

echo ""
[ "$saida" = "0" ] && echo "A LISTA DO CONTRATO NAO SE MISTURA"
exit $saida
