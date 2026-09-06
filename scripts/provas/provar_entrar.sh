#!/bin/sh
# A PORTA DO PRODUTO NA CASA NOVA (06/09): /gestao/entrar faz o que /app#/login fazia, o aceite
# dos Termos existe nas duas pontas (cadastro e casco) e o segundo fator pede o código na porta.
# Roda na VPS, de /opt/novo-operacao/scripts/provas, com EMAIL= e SENHA= da conta de prova.
# A sessão e o cookie de navegador confiável vêm de lib/sessao.sh (passa pelo segundo fator
# pelo caminho de produção); o cookie deixa a prova entrar pela tela sem receber código.
[ -n "$EMAIL" ] && [ -n "$SENHA" ] || { echo "passe EMAIL=<conta de prova> SENHA=<senha>"; exit 1; }
AQUI=$(cd "$(dirname "$0")" && pwd)
BASE="${BASE:-https://beta.loopplayer.com.br}"
UNI="${UNI:-$BASE/gestao}"
. "$AQUI/lib/sessao.sh"
if [ -z "$TOKEN" ]; then
  entrar_de_prova "$EMAIL" "$SENHA" || { echo "SEM SESSAO"; exit 1; }
fi
docker run --rm --network host --user root -v "$AQUI:/p" \
  -e EMAIL="$EMAIL" -e SENHA="$SENHA" -e TOKEN="$TOKEN" -e COOKIE_CONFIANCA="$COOKIE_CONFIANCA" -e UNI="$UNI" -e BASE="$BASE" \
  -e NODE_PATH=/usr/src/app/node_modules --entrypoint node zenika/alpine-chrome:with-puppeteer /p/entrar.js
