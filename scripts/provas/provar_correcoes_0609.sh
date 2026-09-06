#!/bin/sh
# AS CORREÇÕES DE 06/09 NO CELULAR — rolagem depois de navegar, folhas que cabem na tela, o
# Dashboard em três fatias, as linhas de mídia e a prévia pelo link assinado.
# Roda de /opt/novo-operacao/scripts/provas, com TOKEN= da sessão do assinante.
[ -n "$TOKEN" ] || { echo "passe TOKEN=<sessao>"; exit 1; }
docker run --rm --network host --user root -v "$(cd "$(dirname "$0")" && pwd):/p" \
  -e TOKEN="$TOKEN" -e UNI="${UNI:-https://beta.loopplayer.com.br/gestao}" -e BASE="${BASE:-https://beta.loopplayer.com.br}" \
  -e NODE_PATH=/usr/src/app/node_modules \
  --entrypoint node zenika/alpine-chrome:with-puppeteer /p/correcoes_0609.js
