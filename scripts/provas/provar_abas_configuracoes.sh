#!/bin/sh
# A ABA DE CONFIGURAÇÕES PEDIDA ABRE? -- num navegador, nos dois módulos.
#
# ── POR QUE ELA EXISTE ───────────────────────────────────────────────────────────────────
# `provar_configuracoes.sh` tem 351 linhas e todas perguntam QUEM VÊ O QUÊ: papel, plano, quem é
# dono. Nenhuma perguntava para ONDE a aba leva -- e por isso ficou verde em todas as rodadas
# enquanto SEIS abas apontavam para o mesmo endereço e cinco abriam a errada.
#
# A metade servidor desse conserto (o href carregar `?aba=<id>`) já é conferida lá, por curl. A
# outra metade não dá: se a TELA lê o parâmetro e abre o painel certo só se descobre abrindo. E
# essa é justamente a metade que estava quebrada -- o `?aba=` existia no href muito antes desta
# etapa e ninguém o lia, nem de um lado nem do outro. Um parâmetro escrito e ignorado passa por
# qualquer checagem que olhe só o endereço.
#
# Roda num contêiner; nada é instalado no servidor.

OP=${OP:-http://127.0.0.1:3110}
UNI=${UNI:-http://127.0.0.1:3100}
EMAIL=${EMAIL:-cliente@exemplo.invalid}
SENHA=${SENHA:-'SenhaCliente#2026'}
IMAGEM=zenika/alpine-chrome:with-puppeteer
AQUI=$(cd "$(dirname "$0")" && pwd)

. "$AQUI/mfa_lib.sh"

if ! docker image inspect "$IMAGEM" >/dev/null 2>&1; then
  echo "  FALHOU a imagem $IMAGEM nao esta baixada"
  echo "         docker pull $IMAGEM"
  exit 1
fi

preparar_mfa "$EMAIL" "$SENHA" >/dev/null 2>&1
TK=$(entrar "$EMAIL" "$SENHA")
case "$TK" in
  *.*.*) : ;;
  *)
    echo "  FALHOU nao autenticou $EMAIL"
    echo "         o limite de login e 10/min/IP: se outra suite acabou de rodar, espere um"
    echo "         minuto. Um vermelho aqui por 429 nao e defeito do produto."
    exit 1
    ;;
esac

docker run --rm --network host \
  --entrypoint node \
  -e NODE_PATH=/usr/src/app/node_modules \
  -e TOKEN="$TK" \
  -e BASE="$OP" \
  -e UNI="$UNI" \
  -v "$AQUI:/p" \
  "$IMAGEM" /p/abrir_configuracoes.js
