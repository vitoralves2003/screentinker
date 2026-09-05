#!/bin/sh
# A ETAPA 1 DO PORTAL, NUM NAVEGADOR -- os cinco consertos que o Vitor apontou olhando a tela.
#
#   1. a barra nao tem mais o aviso "N midias esperam aprovacao"
#   2. nem o nome da organizacao no topo (o "Suporte a <cliente>" continua, quando e suporte)
#   3. o cartao do painel chama-se "Alertas", e nao "Alertas prioritarios"
#   4. os videos aparecem com miniatura no modal "Adicionar a tela"
#   5. o campo "Contrato do anunciante" lista os contratos do cliente (lia `data`, a API manda `items`)
#
# ── a licao que esta prova carrega ──────────────────────────────────────────────────────────
# A primeira versao procurava o campo de busca por /buscar/i e achava o "Buscar arquivos..." da
# PAGINA, atras do modal. Digitava o nome do cliente no filtro de arquivos, nenhuma lista de
# anunciante aparecia, e a assercao "nao diz 'nao tem contratos'" passava POR VAZIO. Cada passo
# intermediario agora e afirmado -- a busca listou o anunciante, os contratos carregaram -- para
# a assercao final nao poder passar sem os anteriores terem acontecido.
#
# Uso:  TOKEN=<sessao do assinante> sh provar_etapa1_na_tela.sh

[ -n "$TOKEN" ] || { echo "SEM SESSAO: passe TOKEN=..."; exit 1; }
UNI=${UNI:-https://beta.loopplayer.com.br/gestao}
PSQL="docker exec novo-gestao-postgres psql -U novo -d novo_gestao -tAc"
EMAIL=${EMAIL:-cliente@exemplo.invalid}

# Um cliente desta organizacao que TEM contrato fora de rascunho -- e o caso que o campo dizia
# nao existir. Sem um, o passo 5 nao mede nada, e a prova PARA em vez de reprovar.
ORG=$($PSQL "SELECT \"organizationId\" FROM \"User\" WHERE email = '$EMAIL';")
CLI=$($PSQL "SELECT c.name FROM \"Client\" c JOIN \"Contract\" k ON k.\"clientId\" = c.id WHERE c.\"organizationId\" = '$ORG' AND k.status IN ('ISSUED','SIGNING','ACTIVE') AND k.\"isStandalone\" = false LIMIT 1;")
[ -n "$CLI" ] || { echo "SEM CLIENTE COM CONTRATO EMITIDO nesta organizacao -- o passo 5 nao tem o que medir"; exit 4; }
echo "  cliente com contrato: $CLI"

docker run --rm --network host --user root -v "$(cd "$(dirname "$0")" && pwd):/p" \
  -e TOKEN="$TOKEN" -e UNI="$UNI" -e CLIENTE="$CLI" \
  -e NODE_PATH=/usr/src/app/node_modules \
  --entrypoint node zenika/alpine-chrome:with-puppeteer /p/etapa1_na_tela.js
