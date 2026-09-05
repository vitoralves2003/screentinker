#!/bin/sh
# ETAPA 2 NA TELA - a fila de aprovacao mostra a previa e o alerta aparece no painel.
#
# Roda etapa2_na_tela.js num Chrome de verdade contra o ambiente de teste, com a sessao do
# assinante. Os oraculos sao a API: a tela nao pode dizer o que a API nao diz.
#
# Uso:  TOKEN=<sessao do assinante> sh provar_etapa2_na_tela.sh

[ -n "$TOKEN" ] || { echo "SEM SESSAO: passe TOKEN=..."; exit 1; }
UNI=${UNI:-https://beta.loopplayer.com.br/gestao}
BASE=${BASE:-https://beta.loopplayer.com.br}

# --user root porque a imagem roda como chrome e o volume vem do host; --network host para
# alcancar o proxy pelo mesmo endereco que um navegador de verdade usaria.
docker run --rm --network host --user root -v "$(cd "$(dirname "$0")" && pwd):/p" \
  -e TOKEN="$TOKEN" -e UNI="$UNI" -e BASE="$BASE" \
  -e NODE_PATH=/usr/src/app/node_modules \
  --entrypoint node zenika/alpine-chrome:with-puppeteer /p/etapa2_na_tela.js
