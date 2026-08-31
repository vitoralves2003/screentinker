#!/bin/sh
# O MODAL DE ADICIONAR ITENS, ABERTO DE VERDADE -- nos dois lugares que o usam.
#
# ── POR QUE ELA EXISTE ───────────────────────────────────────────────────────────────────
# `provar_abrir.sh` abre /app#/ e /gestao/dashboard, e nenhuma das duas carrega
# views/playlists.js ou views/device-detail.js. O modal so passa a existir quando alguem clica
# em "Adicionar", entao ele ficava fora do alcance de TODAS as provas -- e acabou de mudar de
# casa, de views/playlists.js para components/adicionar-itens-modal.js.
#
# Uma mudanca de casa quebra pelo que fica para tras, e o que fica nao da erro de sintaxe: e um
# ReferenceError no instante em que a linha roda. Duas vezes hoje foi assim -- `hydrateAuthImages`
# e `CATALOGO` vieram no codigo e ficaram de fora dos imports -- e as duas so apareceriam ao
# abrir uma aba especifica deste modal. `node --check` passa nos dois casos.
#
# ── O QUE ELA MEDE ───────────────────────────────────────────────────────────────────────
# Abre a pagina de listas e a pagina da tela num Chrome de verdade, CLICA no botao de adicionar
# em cada uma, percorre as abas do modal, e pergunta o que so um navegador sabe: houve erro no
# console, o titulo diz o nome certo do destino, e cada item que pede duracao tem o campo dele.
#
# Roda num conteiner; nada e instalado no servidor.

OP=${OP:-http://127.0.0.1:3110}
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
  -v "$AQUI:/p" \
  "$IMAGEM" /p/abrir_modal.js
