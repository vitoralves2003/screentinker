#!/bin/sh
# O CICLO INTEIRO NA TELA — o anunciante manda pelo portal, o assinante decide na fila.
#
# É a única prova que atravessa as duas telas do portal com uma mídia de verdade no meio. As
# outras medem cada metade: esta mede a costura, que é onde uma promessa cumprida de um lado
# vira uma sala de espera sem porta do outro.
#
# Ela planta o contrato e o vínculo, sobe uma mídia PELA ROTA DO PORTAL (e não por SQL, porque o
# pedido de aprovação nasce na rota), e só então abre a fila num navegador.
#
# Uso:  TOKEN=<sessao> sh provar_fila_na_tela.sh

. "$(dirname "$0")/portal_cenario.sh"

[ -n "$TOKEN" ] || { echo "SEM SESSAO: passe TOKEN=..."; exit 1; }
BASE=${BASE:-https://beta.loopplayer.com.br}
UNI=${UNI:-https://beta.loopplayer.com.br/gestao}
AUTH="Authorization: Bearer $TOKEN"

ALCANCE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/portal/contratos" -H "$AUTH")
[ "$ALCANCE" = "000" ] && { echo "SEM SERVIDOR EM $BASE -- a prova nao mede nada assim"; exit 4; }

cenario_quem

# O nome carrega a marca para a limpeza alcançar, e é ele que a prova de navegador procura na
# fila: sem um nome próprio, ela mediria a fila inteira do staging.
NOME=prova-fila-na-tela.png

limpar_tudo() {
  $PSQL "DELETE FROM \"Aprovacao\" WHERE \"objetoId\" IN (SELECT id FROM content WHERE filename LIKE 'prova-fila-na-tela%');" >/dev/null 2>&1
  $PSQL "DELETE FROM content WHERE filename LIKE 'prova-fila-na-tela%';" >/dev/null 2>&1
  cenario_limpar
  echo "  cenario removido"
}
trap limpar_tudo EXIT
limpar_tudo >/dev/null 2>&1

echo "== plantando o contrato e o vinculo =="
cenario_plantar
cenario_vincular
echo "  contrato A=$KA  vinculos=$VINC"

echo ""
echo "== o anunciante manda uma midia pelo portal =="
ARQ="/tmp/$NOME"
printf '\211PNG\r\n\032\n\000\000\000\015IHDR\000\000\000\001\000\000\000\001\010\006\000\000\000\037\025\304\211\000\000\000\012IDATx\234c\000\001\000\000\005\000\001\015\012\055\264\000\000\000\000IEND\256B\140\202' > "$ARQ"
ENVIO=$(curl -s -X POST "$BASE/api/portal/contratos/$KA/midias" -H "$AUTH" -F "files=@$ARQ")
MIDIA=$(echo "$ENVIO" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
exigir "id da midia" "$MIDIA"

# O nome guardado pode ganhar sufixo na ingestão (colisão de nome no disco). Quem manda é o que
# está no banco: procurar na tela um nome que o servidor não gravou reprovaria uma tela correta.
NOME_REAL=$($PSQL "SELECT filename FROM content WHERE id = '$MIDIA';")
exigir "nome gravado" "$NOME_REAL"
echo "  midia=$MIDIA  arquivo=$NOME_REAL"

PENDENTE=$($PSQL "SELECT count(*) FROM \"Aprovacao\" WHERE \"objetoId\" = '$MIDIA' AND status = 'PENDENTE';")
[ "$PENDENTE" = "1" ] || { echo "  O CENARIO NAO FOI CRIADO: esperava 1 pedido pendente, achei $PENDENTE"; exit 3; }
echo "  o pedido esta na fila"

echo ""
echo "======== a fila, num navegador ========"
docker run --rm --network host --user root -v "$(cd "$(dirname "$0")" && pwd):/p" \
  -e TOKEN="$TOKEN" -e UNI="$UNI" -e ARQUIVO="$NOME_REAL" \
  -e NODE_PATH=/usr/src/app/node_modules \
  --entrypoint node zenika/alpine-chrome:with-puppeteer /p/a_fila_na_tela.js
saida=$?

echo ""
if [ "$saida" = "0" ]; then
  # A tela disse que aprovou. O banco é quem confirma: uma tela que some com a linha sem o
  # servidor ter mudado nada seria pior que uma tela que falha.
  FINAL=$($PSQL "SELECT status FROM \"Aprovacao\" WHERE \"objetoId\" = '$MIDIA';")
  if [ "$FINAL" = "APROVADO" ]; then
    echo "  ok    o banco confirma: APROVADO"
    echo "O CICLO DO PORTAL FECHA"
  else
    echo "  FALHA a tela aprovou e o banco diz '$FINAL'"
    saida=1
  fi
fi
exit $saida
