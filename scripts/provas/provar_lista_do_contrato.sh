#!/bin/sh
# A LISTA DO CONTRATO EXISTE, E A PEÇA APROVADA CAI NELA — contra o banco de verdade.
#
# Duas perguntas, e nenhuma delas um teste de unidade responde:
#
#   1. Abrir um contrato cria a lista dele? A reparação estava prometida num comentário desde a
#      Etapa 7 e não existia em lugar nenhum — e o efeito não era um caso de borda: medido em
#      05/09, 61 contratos ativos e ZERO listas, porque os dois únicos lugares que criavam a
#      lista (assinatura e implantação) nunca rodaram para eles.
#
#   2. Aprovar põe a peça na lista? Antes, "aprovado" não significava nada: a peça ficava na
#      biblioteca esperando alguém encontrá-la e colocá-la à mão.
#
# ── e por que ela lê o SNAPSHOT no fim ──────────────────────────────────────────────────────
# Estar na lista não é estar na parede. O que a tela baixa é o `published_snapshot`, e uma peça
# que entra na lista sem republicar continua invisível até a próxima publicação por outro motivo.
#
# Uso:  BASE=https://beta.loopplayer.com.br TOKEN=<sessao> sh provar_lista_do_contrato.sh

. "$(dirname "$0")/portal_cenario.sh"

falhas=0
ok()  { echo "  ok    $1"; }
nok() { echo "  FALHA $1"; falhas=$((falhas+1)); }

[ -n "$TOKEN" ] || { echo "SEM SESSAO: passe TOKEN=..."; exit 1; }
BASE=${BASE:-https://beta.loopplayer.com.br}
AUTH="Authorization: Bearer $TOKEN"

ALCANCE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/portal/contratos" -H "$AUTH")
[ "$ALCANCE" = "000" ] && { echo "SEM SERVIDOR EM $BASE -- a prova nao mede nada assim"; exit 4; }

cenario_quem

limpar_tudo() {
  $PSQL "DELETE FROM \"Aprovacao\" WHERE \"objetoId\" IN (SELECT id FROM content WHERE filename LIKE 'prova-lista-%');" >/dev/null 2>&1
  $PSQL "DELETE FROM playlist_items WHERE content_id IN (SELECT id FROM content WHERE filename LIKE 'prova-lista-%');" >/dev/null 2>&1
  $PSQL "DELETE FROM content WHERE filename LIKE 'prova-lista-%';" >/dev/null 2>&1
  # A lista do contrato de prova morre com o contrato, mas o contrato é apagado por número e a
  # lista aponta para o id — então ela é removida aqui, antes.
  $PSQL "DELETE FROM playlists WHERE contrato_id IN (SELECT id FROM \"Contract\" WHERE number LIKE 'PROVA-%');" >/dev/null 2>&1
  cenario_limpar
  echo "  cenario removido"
}
trap limpar_tudo EXIT
limpar_tudo >/dev/null 2>&1

echo "== plantando o contrato e o vinculo =="
cenario_plantar
cenario_vincular
echo "  contrato A=$KA"

echo ""
echo "== antes de abrir, o contrato nao tem lista =="
# A guarda que faz a asserção seguinte significar alguma coisa: se já houvesse lista, "a lista
# existe" passaria sem a rota ter feito nada.
QUANTAS=$($PSQL "SELECT count(*) FROM playlists WHERE contrato_id = '$KA';")
[ "$QUANTAS" = "0" ] && ok "nenhuma lista ainda" || nok "ja havia $QUANTAS lista(s) -- a prova nao mede a criacao"

echo ""
echo "== a rota que a aba chama ao abrir =="
# O CORPO, e não só o código.
#
# A primeira versão conferia apenas o 200 e a asserção seguinte reprovava com "a lista NAO
# nasceu" — sem dizer que a rota tinha respondido `criada: false`. Um veredito que esconde a
# metade que explica custa uma investigação inteira, e custou.
RESP=$(curl -s -w '\n%{http_code}' -X POST "$BASE/gestao-api/contracts/$KA/lista" -H "$AUTH")
COD=$(echo "$RESP" | tail -1)
CORPO=$(echo "$RESP" | head -n -1)
echo "  resposta: $CORPO (HTTP $COD)"
[ "$COD" = "200" ] && ok "a rota responde 200" || nok "a rota respondeu $COD"
echo "$CORPO" | grep -q '"criada":true' && ok "e ela DIZ que criou" || nok "a rota respondeu sem criar: $CORPO"

LISTA=$($PSQL "SELECT id FROM playlists WHERE contrato_id = '$KA';")
[ -n "$LISTA" ] && ok "a lista do contrato nasceu" || nok "a lista NAO nasceu"
[ -n "$LISTA" ] || { echo ""; echo "$falhas FALHA(S)"; exit 1; }

ROTULO=$($PSQL "SELECT name FROM playlists WHERE id = '$LISTA';")
echo "  rotulo: $ROTULO"
# O rótulo é montado do contrato, juntando só o que existe -- "Padaria —  · #" seria pior que
# "Padaria". O cliente da prova chama-se "Padaria da Prova" e o contrato tem número.
echo "$ROTULO" | grep -q "Padaria da Prova" && ok "o rotulo traz o nome do anunciante" || nok "o rotulo veio '$ROTULO'"

echo ""
echo "== chamar de novo nao cria uma segunda =="
# É o que permite a aba chamar na abertura sem virar escrita a cada visita.
curl -s -o /dev/null -X POST "$BASE/gestao-api/contracts/$KA/lista" -H "$AUTH"
N=$($PSQL "SELECT count(*) FROM playlists WHERE contrato_id = '$KA';")
[ "$N" = "1" ] && ok "continua uma so" || nok "agora ha $N listas"

echo ""
echo "== o anunciante manda uma midia =="
ARQ=/tmp/prova-lista-contrato.png
printf '\211PNG\r\n\032\n\000\000\000\015IHDR\000\000\000\001\000\000\000\001\010\006\000\000\000\037\025\304\211\000\000\000\012IDATx\234c\000\001\000\000\005\000\001\015\012\055\264\000\000\000\000IEND\256B\140\202' > "$ARQ"
ENVIO=$(curl -s -X POST "$BASE/api/portal/contratos/$KA/midias" -H "$AUTH" -F "files=@$ARQ")
MIDIA=$(echo "$ENVIO" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
exigir "id da midia" "$MIDIA"

NA_LISTA=$($PSQL "SELECT count(*) FROM playlist_items WHERE playlist_id = '$LISTA' AND content_id = '$MIDIA';")
# Pendente NÃO entra: o que a aprovação libera é a colocação, e enfileirar antes de decidir
# tiraria o sentido de haver uma fila.
[ "$NA_LISTA" = "0" ] && ok "pendente NAO entra na lista" || nok "a peca pendente ja estava na lista"

echo ""
echo "== o assinante aprova =="
PEDIDO=$($PSQL "SELECT id FROM \"Aprovacao\" WHERE \"objetoId\" = '$MIDIA' AND status = 'PENDENTE';")
exigir "pedido na fila" "$PEDIDO"
curl -s -o /dev/null -X POST "$BASE/api/aprovacoes/$PEDIDO/aprovar" -H "$AUTH" -H 'Content-Type: application/json'

NA_LISTA=$($PSQL "SELECT count(*) FROM playlist_items WHERE playlist_id = '$LISTA' AND content_id = '$MIDIA';")
[ "$NA_LISTA" = "1" ] && ok "aprovar POS a peca na lista do contrato" || nok "aprovou e a peca nao entrou (achei $NA_LISTA)"

echo ""
echo "== e ela esta no que a tela baixa =="
# Estar na lista não é estar na parede: o que a tela exibe é o snapshot publicado.
SNAP=$($PSQL "SELECT COALESCE(published_snapshot, '') FROM playlists WHERE id = '$LISTA';")
echo "  snapshot: $(echo "$SNAP" | head -c 140)"
echo "$SNAP" | grep -q '\[' && ok "o snapshot foi escrito" || nok "a lista nao foi publicada"
echo "$SNAP" | grep -q "$MIDIA" && ok "a peca aprovada esta no snapshot" || nok "a peca entrou na lista e NAO no snapshot"

echo ""
echo "== aprovar de novo nao duplica =="
# O pedido já foi decidido, então a rota recusa -- mas a guarda de duplicata vive no serviço, e
# é ela que importa se um dia dois pedidos couberem no mesmo objeto.
curl -s -o /dev/null -X POST "$BASE/api/aprovacoes/$PEDIDO/aprovar" -H "$AUTH" -H 'Content-Type: application/json'
N=$($PSQL "SELECT count(*) FROM playlist_items WHERE playlist_id = '$LISTA' AND content_id = '$MIDIA';")
[ "$N" = "1" ] && ok "continua uma linha so na lista" || nok "a peca aparece $N vezes"

echo ""
[ "$falhas" = "0" ] && echo "A LISTA DO CONTRATO EXISTE E RECEBE O QUE FOI APROVADO" || echo "$falhas FALHA(S)"
exit $falhas
