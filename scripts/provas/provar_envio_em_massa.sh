#!/bin/sh
# O ENVIO EM MASSA, CLICADO NUM NAVEGADOR.
#
# ── POR QUE ELA EXISTE ───────────────────────────────────────────────────────────────────
# Este seletor teve QUATRO defeitos num dia, e os quatro foram achados pelo Vitor olhando a tela,
# nenhum pelas provas: o grupo que nao aparecia, o espaco proprio das telas oferecido como
# playlist, a busca escondida abaixo de seis itens, e o botao dizendo "Enviar para 2" com nada
# marcado a frente.
#
# Nao e azar. Havia prova de que a pagina carrega sem erro de JavaScript e prova de que a rota
# funciona por API -- e nenhuma de que o SELETOR faz o que promete quando alguem clica. As duas
# metades verdes e o meio nunca medido.
#
# Esta prova clica.
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
  "$IMAGEM" /p/abrir_envio_em_massa.js
