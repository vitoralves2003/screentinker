#!/bin/sh
# A APLICACAO ABRE? -- a unica prova deste projeto que executa o frontend.
#
# ── POR QUE ELA EXISTE ───────────────────────────────────────────────────────────────────
# O Vitor viu a tela em branco TRES VEZES enquanto 148 checagens ficavam verdes. Nao havia
# contradicao: todas as outras provas perguntam ao servidor, e o servidor estava certo o tempo
# todo. O defeito era um SyntaxError no arranque de um modulo -- e um modulo que nao carrega
# nao deixa rastro em log nenhum.
#
# Foram dois, e os dois invisiveis para grep:
#   `atravessarParaGestao` declarada duas vezes em app.js (import + funcao antiga que ficou)
#   `const ESTILO` declarada nos dois componentes, que sao script CLASSICO e dividem o global
#
# `node --check` passou nos dois: sem "type": "module" ele trata o arquivo como CommonJS, onde
# declarar duas vezes nao e erro. Um verde que media outra linguagem.
#
# ── O QUE ELA MEDE ───────────────────────────────────────────────────────────────────────
# Carrega /app num Chrome de verdade e pergunta o que so um navegador sabe: houve erro no
# console, algum pedido falhou, e o que a barra DESENHOU -- atravessando o Shadow DOM, onde
# nenhuma checagem de texto alcanca.
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
  *) echo "  FALHOU nao autenticou $EMAIL"; exit 1 ;;
esac

# --network host para alcancar o 127.0.0.1 do servidor. O script montado em /p e o mesmo do
# repositorio: nada e copiado para dentro da imagem.
docker run --rm --network host \
  --entrypoint node \
  -e NODE_PATH=/usr/src/app/node_modules \
  -e TOKEN="$TK" \
  -e BASE="$OP" \
  -v "$AQUI:/p" \
  "$IMAGEM" /p/abrir.js
