#!/bin/sh
# A PORTA DO PRODUTO NA CASA NOVA (06/09): /gestao/entrar faz o que /app#/login fazia, e o
# aceite dos Termos existe nas duas pontas (cadastro e casco). Roda de
# /opt/novo-operacao/scripts/provas com EMAIL= e SENHA= da conta de prova (TOKEN é obtido aqui).
[ -n "$EMAIL" ] && [ -n "$SENHA" ] || { echo "passe EMAIL=<conta de prova> SENHA=<senha>"; exit 1; }
BASE="${BASE:-https://beta.loopplayer.com.br}"
UNI="${UNI:-$BASE/gestao}"
if [ -z "$TOKEN" ]; then
  TOKEN=$(curl -s -m 20 -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$SENHA\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
fi
[ -n "$TOKEN" ] || { echo "SEM SESSAO: o login por curl nao devolveu token"; exit 1; }
docker run --rm --network host --user root -v "$(cd "$(dirname "$0")" && pwd):/p" \
  -e EMAIL="$EMAIL" -e SENHA="$SENHA" -e TOKEN="$TOKEN" -e UNI="$UNI" -e BASE="$BASE" \
  -e NODE_PATH=/usr/src/app/node_modules --entrypoint node zenika/alpine-chrome:with-puppeteer /p/entrar.js
