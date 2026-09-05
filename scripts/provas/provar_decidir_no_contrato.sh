#!/bin/sh
# A DECISÃO MORA NO CONTRATO — planta uma peça esperando e abre a aba num navegador.
#
# A prova de tela precisa de uma peça PENDENTE de verdade: sem ela, "não há nada esperando"
# passaria por vácuo em todas as asserções. Então esta planta o contrato, o vínculo e o envio
# pelo portal, e só depois abre o navegador.
#
# O aviso da barra também depende disso: ele só aparece quando há algo esperando, de propósito —
# um indicador permanente deixa de ser visto.
#
# Uso:  TOKEN=<sessao> sh provar_decidir_no_contrato.sh

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

limpar_tudo() {
  $PSQL "DELETE FROM \"Aprovacao\" WHERE \"objetoId\" IN (SELECT id FROM content WHERE filename LIKE 'prova-decidir%');" >/dev/null 2>&1
  $PSQL "DELETE FROM playlist_items WHERE content_id IN (SELECT id FROM content WHERE filename LIKE 'prova-decidir%');" >/dev/null 2>&1
  $PSQL "DELETE FROM content WHERE filename LIKE 'prova-decidir%';" >/dev/null 2>&1
  $PSQL "DELETE FROM playlists WHERE contrato_id IN (SELECT id FROM \"Contract\" WHERE number LIKE 'PROVA-%');" >/dev/null 2>&1
  cenario_limpar
  echo "  cenario removido"
}
trap limpar_tudo EXIT
limpar_tudo >/dev/null 2>&1

echo "== plantando o contrato, o vinculo e a lista =="
cenario_plantar
cenario_vincular
cenario_sessao_do_portal
# A lista precisa existir para aprovar ter onde por a peça — é a mesma chamada que a aba faz ao
# abrir, e adiantá-la aqui separa "a lista falhou" de "a decisão falhou".
curl -s -o /dev/null -X POST "$BASE/gestao-api/contracts/$KA/lista" -H "$AUTH"
LISTA=$($PSQL "SELECT id FROM playlists WHERE contrato_id = '$KA';")
exigir "lista do contrato" "$LISTA"

echo ""
echo "== o anunciante manda uma midia =="
NOME=prova-decidir.png
ARQ="/tmp/$NOME"
printf '\211PNG\r\n\032\n\000\000\000\015IHDR\000\000\000\001\000\000\000\001\010\006\000\000\000\037\025\304\211\000\000\000\012IDATx\234c\000\001\000\000\005\000\001\015\012\055\264\000\000\000\000IEND\256B\140\202' > "$ARQ"
ENVIO=$(curl -s -X POST "$BASE/api/portal/contratos/$KA/midias" -H "$PAUTH" -F "files=@$ARQ")
MIDIA=$(echo "$ENVIO" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
exigir "id da midia" "$MIDIA"
NOME_REAL=$($PSQL "SELECT filename FROM content WHERE id = '$MIDIA';")
exigir "nome gravado" "$NOME_REAL"

PENDENTES=$($PSQL "SELECT count(*) FROM \"Aprovacao\" WHERE \"objetoId\" = '$MIDIA' AND status = 'PENDENTE';")
[ "$PENDENTES" = "1" ] || { echo "  O CENARIO NAO FOI CRIADO: esperava 1 pendente, achei $PENDENTES"; exit 3; }
echo "  midia=$NOME_REAL esperando decisao"

echo ""
echo "== o resumo que o aviso da barra le =="
RESUMO=$(curl -s "$BASE/api/aprovacoes/resumo" -H "$AUTH")
echo "  resposta: $RESUMO"
echo "$RESUMO" | grep -qE '"pendentes":[1-9]' && echo "  ok    o resumo conta pelo menos uma" || { echo "  FALHA o resumo veio $RESUMO"; exit 1; }

echo ""
echo "== a fila filtrada por ESTE contrato =="
# Filtrar no servidor é o que a aba usa. Se o filtro for ignorado, ela mostraria a fila do
# tenant inteiro dentro de um contrato — e ninguém notaria com um contrato só.
SO_DELE=$(curl -s "$BASE/api/aprovacoes?contrato=$KA" -H "$AUTH" | grep -o '"id"' | wc -l)
DE_OUTRO=$(curl -s "$BASE/api/aprovacoes?contrato=$KB" -H "$AUTH" | grep -o '"id"' | wc -l)
[ "$SO_DELE" -ge 1 ] && echo "  ok    o contrato A tem pedido" || { echo "  FALHA o contrato A veio vazio"; exit 1; }
[ "$DE_OUTRO" = "0" ] && echo "  ok    o contrato B (vizinho) vem vazio" || { echo "  FALHA o filtro nao filtra: vizinho trouxe $DE_OUTRO"; exit 1; }

echo ""
echo "======== a aba, num navegador ========"
docker run --rm --network host --user root -v "$(cd "$(dirname "$0")" && pwd):/p" \
  -e TOKEN="$TOKEN" -e UNI="$UNI" -e CONTRATO="$KA" -e ARQUIVO="$NOME_REAL" \
  -e NODE_PATH=/usr/src/app/node_modules \
  --entrypoint node zenika/alpine-chrome:with-puppeteer /p/decidir_no_contrato.js
saida=$?

echo ""
if [ "$saida" = "0" ]; then
  # A tela disse que aprovou. O banco confirma — e a lista do contrato também, porque aprovar
  # põe a peça nela.
  FINAL=$($PSQL "SELECT status FROM \"Aprovacao\" WHERE \"objetoId\" = '$MIDIA';")
  NA_LISTA=$($PSQL "SELECT count(*) FROM playlist_items WHERE playlist_id = '$LISTA' AND content_id = '$MIDIA';")
  [ "$FINAL" = "APROVADO" ] && echo "  ok    o banco confirma: APROVADO" || { echo "  FALHA o banco diz '$FINAL'"; saida=1; }
  [ "$NA_LISTA" = "1" ] && echo "  ok    e a peca entrou na lista do contrato" || { echo "  FALHA a peca nao entrou na lista"; saida=1; }
fi

echo ""
[ "$saida" = "0" ] && echo "A DECISAO MORA NO CONTRATO, E A BARRA SO AVISA"
exit $saida
