#!/bin/sh
# A ROLAGEM NO CELULAR (06/09): as paginas de lista rolam ate o fim num viewport de telefone,
# o ultimo cartao termina acima da barra inferior, o contrato abre pelo nome e mostra o numero,
# e Telas nao mostra a midia tocando. Roda rolagem_no_celular.js num Chrome com a sessao do
# assinante. (O WebKit do iPhone fica fora do alcance do Chrome: ver diag_webkit.js.)
#
# Uso:  TOKEN=<sessao do assinante> sh provar_rolagem_no_celular.sh

[ -n "$TOKEN" ] || { echo "SEM SESSAO: passe TOKEN=..."; exit 1; }
UNI=${UNI:-https://beta.loopplayer.com.br/gestao}

docker run --rm --network host --user root -v "$(cd "$(dirname "$0")" && pwd):/p" \
  -e TOKEN="$TOKEN" -e UNI="$UNI" \
  -e NODE_PATH=/usr/src/app/node_modules \
  --entrypoint node zenika/alpine-chrome:with-puppeteer /p/rolagem_no_celular.js
