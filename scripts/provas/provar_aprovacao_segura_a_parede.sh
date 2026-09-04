#!/bin/sh
# A APROVAÇÃO SEGURA A PAREDE — e a suspensão alcança a sub-lista. Contra o banco de verdade.
#
# ── por que esta prova existe ───────────────────────────────────────────────────────────────
# Dois defeitos moravam no mesmo lugar, e nenhum aparecia em tela nenhuma:
#
# 1. O selo "esperando aprovação" era DECORATIVO. Nada fora do módulo do portal lia a tabela de
#    aprovação, então a peça do anunciante entrava pendente, ganhava o selo, e ia ao ar do mesmo
#    jeito se alguém a colocasse numa lista.
#
# 2. A suspensão de contrato não alcançava a SUB-LISTA. O SQL do snapshot é escrito duas vezes —
#    lista e sub-lista — e a suspensão entrou só na primeira. A lista do contrato entra numa tela
#    como sub-lista por desenho, então o caso principal da Etapa 6 era justamente o que escapava:
#    suspender marcava a linha, respondia 200, e o vídeo continuava na parede.
#
# As duas correções são a mesma frase num lugar só. Esta prova mede o EFEITO delas, que é a única
# coisa que uma trava de forma não pode afirmar: o que sai no `published_snapshot`.
#
# ── e por que ela lê o snapshot, e não a resposta de uma rota ───────────────────────────────
# O snapshot é o que a tela baixa e exibe. Uma rota pode responder certo e a parede continuar
# errada — foi exatamente o que a Etapa 6 fez ao marcar o contrato sem republicar. Perguntar à
# coluna é perguntar à parede.
#
# Uso:  BASE=https://beta.loopplayer.com.br TOKEN=<sessao> sh provar_aprovacao_segura_a_parede.sh

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

# Além do cenário, esta prova cria listas e um arquivo. Tudo com a mesma marca, e tudo apagado
# no fim — inclusive se ela morrer no meio.
limpar_tudo() {
  $PSQL "DELETE FROM playlist_items WHERE playlist_id IN (SELECT id FROM playlists WHERE name LIKE 'PROVA-APROVACAO%');" >/dev/null 2>&1
  $PSQL "DELETE FROM playlists WHERE name LIKE 'PROVA-APROVACAO%';" >/dev/null 2>&1
  $PSQL "DELETE FROM \"Aprovacao\" WHERE \"contratoId\" IN (SELECT id FROM \"Contract\" WHERE number LIKE 'PROVA-%');" >/dev/null 2>&1
  $PSQL "DELETE FROM content WHERE filename LIKE 'prova-aprovacao%';" >/dev/null 2>&1
  $PSQL "DELETE FROM contratos_suspensos WHERE contrato_id IN (SELECT id FROM \"Contract\" WHERE number LIKE 'PROVA-%');" >/dev/null 2>&1
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
echo "== o anunciante manda uma midia =="
# Um PNG 1x1 de verdade: o upload deriva mime e dimensões do arquivo, e um arquivo falso seria
# recusado por motivo que não é o desta prova.
ARQ=/tmp/prova-aprovacao.png
printf '\211PNG\r\n\032\n\000\000\000\015IHDR\000\000\000\001\000\000\000\001\010\006\000\000\000\037\025\304\211\000\000\000\012IDATx\234c\000\001\000\000\005\000\001\015\012\055\264\000\000\000\000IEND\256B\140\202' > "$ARQ"
ENVIO=$(curl -s -X POST "$BASE/api/portal/contratos/$KA/midias" -H "$AUTH" -F "files=@$ARQ")
echo "  resposta: $(echo "$ENVIO" | head -c 200)"
MIDIA=$(echo "$ENVIO" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
exigir "id da midia" "$MIDIA"
echo "  midia=$MIDIA"

echo "$ENVIO" | grep -q '"aguardandoAprovacao":true' && ok "o envio diz que espera aprovacao" || nok "o envio nao disse que espera"

ESTADO=$($PSQL "SELECT status FROM \"Aprovacao\" WHERE \"objetoTipo\" = 'content' AND \"objetoId\" = '$MIDIA';")
[ "$ESTADO" = "PENDENTE" ] && ok "o pedido nasceu PENDENTE" || nok "o pedido nasceu '$ESTADO'"

echo ""
echo "== a midia entra numa lista, e a lista e publicada =="
# Plantada por SQL: o alvo desta prova é o SQL do snapshot, e passar pelo seletor da tela mediria
# o seletor. O `publish` vai pela API, que é quem monta o snapshot de verdade.
LISTA=$($PSQL "INSERT INTO playlists (id, user_id, name, status, workspace_id)
  VALUES (gen_random_uuid()::text, '$UID_', 'PROVA-APROVACAO lista', 'draft', '$ORG') RETURNING id;" | head -1)
exigir "lista" "$LISTA"
$PSQL "INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec)
       VALUES ('$LISTA', '$MIDIA', 0, 10);" >/dev/null
curl -s -o /dev/null -X POST "$BASE/api/playlists/$LISTA/publish" -H "$AUTH"

SNAP=$($PSQL "SELECT COALESCE(published_snapshot, '') FROM playlists WHERE id = '$LISTA';")
echo "  snapshot: $(echo "$SNAP" | head -c 160)"
# A guarda contra medir vazio: um snapshot que nem foi escrito também "não contém" a mídia, e a
# asserção passaria pelo motivo errado.
echo "$SNAP" | grep -q '\[' && ok "o snapshot foi escrito" || nok "o publish nao escreveu snapshot nenhum"
echo "$SNAP" | grep -q "$MIDIA" && nok "a peca PENDENTE foi para a parede" || ok "a peca pendente NAO entrou no snapshot"

echo ""
echo "== o assinante aprova, e a peca sobe sozinha =="
PEDIDO=$($PSQL "SELECT id FROM \"Aprovacao\" WHERE \"objetoId\" = '$MIDIA' AND status = 'PENDENTE';")
exigir "pedido na fila" "$PEDIDO"
curl -s -o /dev/null -X POST "$BASE/api/aprovacoes/$PEDIDO/aprovar" -H "$AUTH" -H 'Content-Type: application/json'

# Sem republicar, o banco diria APROVADO e a parede continuaria sem a peça. Esta leitura é a que
# separa "decidiu" de "mudou o que a tela exibe".
SNAP=$($PSQL "SELECT COALESCE(published_snapshot, '') FROM playlists WHERE id = '$LISTA';")
echo "$SNAP" | grep -q "$MIDIA" && ok "aprovar REPUBLICOU e a peca entrou" || nok "aprovada, mas a parede nao mudou"

echo ""
echo "== e a suspensao alcanca a SUB-LISTA =="
# O caminho que escapava. A lista do contrato entra numa tela como sub-lista, então é assim que a
# mídia do anunciante chega à parede -- e era por aqui que ela voltava depois de suspensa.
MAE=$($PSQL "INSERT INTO playlists (id, user_id, name, status, workspace_id)
  VALUES (gen_random_uuid()::text, '$UID_', 'PROVA-APROVACAO mae', 'draft', '$ORG') RETURNING id;" | head -1)
exigir "lista mae" "$MAE"
$PSQL "INSERT INTO playlist_items (playlist_id, sub_playlist_id, sort_order)
       VALUES ('$MAE', '$LISTA', 0);" >/dev/null
curl -s -o /dev/null -X POST "$BASE/api/playlists/$MAE/publish" -H "$AUTH"

SNAP=$($PSQL "SELECT COALESCE(published_snapshot, '') FROM playlists WHERE id = '$MAE';")
echo "$SNAP" | grep -q "$MIDIA" && ok "sem suspensao, a peca chega pela sub-lista" || nok "a peca nao chegou pela sub-lista nem sem suspensao"

$PSQL "INSERT INTO contratos_suspensos (contrato_id, workspace_id, motivo, suspenso_em)
       VALUES ('$KA', '$ORG', 'prova', floor(extract(epoch from now()))::int);" >/dev/null
curl -s -o /dev/null -X POST "$BASE/api/playlists/$MAE/publish" -H "$AUTH"

SNAP=$($PSQL "SELECT COALESCE(published_snapshot, '') FROM playlists WHERE id = '$MAE';")
echo "  snapshot da mae: $(echo "$SNAP" | head -c 160)"
echo "$SNAP" | grep -q "$MIDIA" && nok "SUSPENSO e ainda na parede, pela sub-lista" || ok "suspenso, a peca sai tambem da sub-lista"

echo ""
[ "$falhas" = "0" ] && echo "A APROVACAO SEGURA A PAREDE, E A SUSPENSAO ALCANCA A SUB-LISTA" || echo "$falhas FALHA(S)"
exit $falhas
