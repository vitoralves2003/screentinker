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

# A guarda de alcance nao leva sessao: o que ela pergunta e se HA servidor, e neste ponto
# nenhuma das duas sessoes existe ainda. Levar "$PAUTH" aqui mandava um cabecalho vazio.
ALCANCE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/portal/contratos")
[ "$ALCANCE" = "000" ] && { echo "SEM SERVIDOR EM $BASE -- a prova nao mede nada assim"; exit 4; }

cenario_quem

# O nome carrega a marca para a limpeza alcançar, e é ele que a prova de navegador procura na
# fila: sem um nome próprio, ela mediria a fila inteira do staging.
NOME=prova-fila-na-tela.png

limpar_tudo() {
  $PSQL "DELETE FROM \"Aprovacao\" WHERE \"objetoId\" IN (SELECT id FROM content WHERE filename LIKE 'prova-fila-%');" >/dev/null 2>&1
  $PSQL "DELETE FROM content WHERE filename LIKE 'prova-fila-%';" >/dev/null 2>&1
  cenario_limpar
  echo "  cenario removido"
}
trap limpar_tudo EXIT
limpar_tudo >/dev/null 2>&1

echo "== plantando o contrato e o vinculo =="
cenario_plantar
cenario_vincular
cenario_sessao_do_portal
echo "  contrato A=$KA  vinculos=$VINC"

echo ""
echo "== o anunciante manda uma midia pelo portal =="
ARQ="/tmp/$NOME"
printf '\211PNG\r\n\032\n\000\000\000\015IHDR\000\000\000\001\000\000\000\001\010\006\000\000\000\037\025\304\211\000\000\000\012IDATx\234c\000\001\000\000\005\000\001\015\012\055\264\000\000\000\000IEND\256B\140\202' > "$ARQ"
ENVIO=$(curl -s -X POST "$BASE/api/portal/contratos/$KA/midias" -H "$PAUTH" -F "files=@$ARQ")
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
if [ "$saida" != "0" ]; then exit $saida; fi

# A tela disse que aprovou. O banco é quem confirma: uma tela que some com a linha sem o
# servidor ter mudado nada seria pior que uma tela que falha.
FINAL=$($PSQL "SELECT status FROM \"Aprovacao\" WHERE \"objetoId\" = '$MIDIA';")
if [ "$FINAL" != "APROVADO" ]; then
  echo "  FALHA a tela aprovou e o banco diz '$FINAL'"
  exit 1
fi
echo "  ok    o banco confirma: APROVADO"

echo ""
echo "======== e a RECUSA, que e a metade que volta ========"
# A aprovação é a metade fácil: ela some da fila e vai ao ar. A recusa tem de ATRAVESSAR de
# volta — o motivo escrito pelo assinante precisa chegar ao portal de quem mandou. Sem isso a
# pessoa reenvia a mesma peça, e quem atende o telefone depois é o assinante.
MOTIVO='a imagem esta escura e o texto nao se le de longe'
SEGUNDA=/tmp/prova-fila-recusada.png
cp "$ARQ" "$SEGUNDA"
ENVIO2=$(curl -s -X POST "$BASE/api/portal/contratos/$KA/midias" -H "$PAUTH" -F "files=@$SEGUNDA")
MIDIA2=$(echo "$ENVIO2" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
exigir "id da segunda midia" "$MIDIA2"
PEDIDO2=$($PSQL "SELECT id FROM \"Aprovacao\" WHERE \"objetoId\" = '$MIDIA2' AND status = 'PENDENTE';")
exigir "pedido da segunda" "$PEDIDO2"

curl -s -o /dev/null -X POST "$BASE/api/aprovacoes/$PEDIDO2/recusar" -H "$AUTH" \
  -H 'Content-Type: application/json' -d "{\"motivo\":\"$MOTIVO\"}"
GRAVADO=$($PSQL "SELECT status FROM \"Aprovacao\" WHERE id = '$PEDIDO2';")
[ "$GRAVADO" = "RECUSADO" ] || { echo "  FALHA a recusa nao gravou (status '$GRAVADO')"; exit 1; }
echo "  o pedido foi recusado com motivo"

docker run --rm --network host --user root -v "$(cd "$(dirname "$0")" && pwd):/p" \
  -e TOKEN="$TOKEN_PORTAL" -e UNI="$UNI" -e FASE=recusada -e MOTIVO="$MOTIVO" \
  -e NODE_PATH=/usr/src/app/node_modules \
  --entrypoint node zenika/alpine-chrome:with-puppeteer /p/portal_na_tela.js
saida=$?

echo ""
[ "$saida" = "0" ] && echo "O CICLO DO PORTAL FECHA NOS DOIS SENTIDOS"
exit $saida
