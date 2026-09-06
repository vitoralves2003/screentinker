#!/bin/sh
# ETAPA 2 NA TELA — a fila mostra a PRÉVIA antes de decidir, e o painel avisa em Alertas.
#
# `etapa2_na_tela.js` exige uma peça pendente com nome conhecido (`PENDENTE`) e o contrato dela
# (`CONTRATO`) — sem isso ela PARA com saída 4, que é "não medi", não "reprovei". A rodada 12
# lia "a pendente mais recente da organização" no banco, e essa pendente era a MÍDIA REAL do
# Vitor. Uma prova que olha a peça do dono, mesmo só olhando, mede o dado dele e não o dela.
#
# Então este wrapper PLANTA a própria pendente, como `provar_fila_na_tela.sh`: o contrato e o
# vínculo do cenário, a sessão do portal, e um PNG de 1x1 mandado pela porta do anunciante —
# que nasce PENDENTE por desenho. E apaga tudo no fim, inclusive se falhar no meio.
#
# Uso:  TOKEN=<sessao do assinante> sh provar_etapa2_na_tela.sh

. "$(dirname "$0")/portal_cenario.sh"

[ -n "$TOKEN" ] || { echo "SEM SESSAO: passe TOKEN=..."; exit 1; }
UNI=${UNI:-https://beta.loopplayer.com.br/gestao}
BASE=${BASE:-https://beta.loopplayer.com.br}

cenario_quem
NOME=prova-etapa2-na-tela.png

limpar_tudo() {
  $PSQL "DELETE FROM \"Aprovacao\" WHERE \"objetoId\" IN (SELECT id FROM content WHERE filename LIKE 'prova-etapa2-%');" >/dev/null 2>&1
  $PSQL "DELETE FROM content WHERE filename LIKE 'prova-etapa2-%';" >/dev/null 2>&1
  cenario_limpar
  echo "  cenario removido"
}
trap limpar_tudo EXIT
limpar_tudo >/dev/null 2>&1

echo "== plantando o contrato, o vinculo e a sessao do portal =="
cenario_plantar
cenario_vincular
cenario_sessao_do_portal
echo "  contrato A=$KA"

echo "== o anunciante manda uma midia pelo portal (nasce pendente) =="
ARQ="/tmp/$NOME"
printf '\211PNG\r\n\032\n\000\000\000\015IHDR\000\000\000\001\000\000\000\001\010\006\000\000\000\037\025\304\211\000\000\000\012IDATx\234c\000\001\000\000\005\000\001\015\012\055\264\000\000\000\000IEND\256B\140\202' > "$ARQ"
ENVIO=$(curl -s -X POST "$BASE/api/portal/contratos/$KA/midias" -H "$PAUTH" -F "files=@$ARQ")
MIDIA=$(echo "$ENVIO" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
exigir "id da midia" "$MIDIA"
# O nome guardado pode ganhar sufixo na ingestão; quem manda é o que está no banco.
PENDENTE=$($PSQL "SELECT filename FROM content WHERE id = '$MIDIA';")
ESTADO=$($PSQL "SELECT status FROM \"Aprovacao\" WHERE \"objetoId\" = '$MIDIA';")
echo "  pendente='$PENDENTE' estado=$ESTADO"
[ "$ESTADO" = "PENDENTE" ] || { echo "A PECA NAO NASCEU PENDENTE ($ESTADO): nada a medir"; exit 1; }

# --user root porque a imagem roda como chrome e o volume vem do host; --network host para
# alcançar o proxy pelo mesmo endereço que um navegador de verdade usaria.
docker run --rm --network host --user root -v "$(cd "$(dirname "$0")" && pwd):/p" \
  -e TOKEN="$TOKEN" -e UNI="$UNI" -e BASE="$BASE" \
  -e PENDENTE="$PENDENTE" -e CONTRATO="$KA" \
  -e NODE_PATH=/usr/src/app/node_modules \
  --entrypoint node zenika/alpine-chrome:with-puppeteer /p/etapa2_na_tela.js
