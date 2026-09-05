#!/bin/sh
# ETAPA 6 NA TELA — a casa do anunciante, num navegador de verdade (05/09).
#
# Planta o mesmo cenário das outras provas do portal (dois clientes, um contrato ativo para
# cada, o vínculo com o cliente A, a senha do portal) e roda `etapa6_na_tela.js` com a SESSÃO
# DO PORTAL. O script confere, contra a própria API do portal: a entrada cai dentro do contrato,
# a marca no topo é a do assinante, as quatro seções, Faturas e Relatórios dizendo os números da
# API, Materiais dizendo "Em breve", e a barra inferior no celular DENTRO da tela.
#
# Um contrato plantado não tem cobrança nem exibição — então aqui as seções provam o estado
# vazio e o mecanismo (tela = API). O cheio se vê no uso real, e a mesma prova o conferiria.
#
# Uso:  TOKEN=<sessao do assinante> sh provar_etapa6_na_tela.sh

. "$(dirname "$0")/portal_cenario.sh"

[ -n "$TOKEN" ] || { echo "SEM SESSAO: passe TOKEN=..."; exit 1; }
UNI=${UNI:-https://beta.loopplayer.com.br/gestao}

cenario_quem
trap 'cenario_limpar; echo "  cenario removido"' EXIT
cenario_limpar

echo "== plantando dois clientes, um contrato ativo para cada, e o vinculo com o A =="
cenario_plantar
echo "  contrato A=$KA (cliente A)"
cenario_vincular
cenario_sessao_do_portal

# --user root porque a imagem roda como chrome e o volume vem do host; --network host para
# alcançar o proxy pelo mesmo endereço que um navegador de verdade usaria.
docker run --rm --network host --user root -v "$(cd "$(dirname "$0")" && pwd):/p" \
  -e TOKEN="$TOKEN_PORTAL" -e UNI="$UNI" \
  -e NODE_PATH=/usr/src/app/node_modules \
  --entrypoint node zenika/alpine-chrome:with-puppeteer /p/etapa6_na_tela.js
