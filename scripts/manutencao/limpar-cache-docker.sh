#!/bin/bash
# A FAXINA SEMANAL DO DOCKER -- domingos, 05:00 UTC (02:00 em Brasília).
#
# ── POR QUE ELA EXISTE ──────────────────────────────────────────────────────────────────
# Em 20/09 o disco da VPS estava em 78% e o alarme parecia ser volume de dados. Não era:
# dos 302 GB ocupados, 283 GB eram CACHE DE COMPILAÇÃO do Docker -- passos de build que ele
# guarda para acelerar a próxima compilação, e que nada nunca limitava. Cada publicação
# deixava mais um monte para trás, e ninguém olhava porque o número que se vê é "o disco",
# não "o cache".
#
# O perigo não era o cache: era o cache empurrar o disco para 100% numa noite qualquer. Disco
# cheio não falha de um jeito claro -- o Postgres para de aceitar escrita, o backup não
# consegue gravar o dump, e o painel devolve erro sem dizer por quê.
#
# ── O QUE ELA APAGA, E O QUE ELA NÃO ENCOSTA ────────────────────────────────────────────
#   APAGA   cache de compilação acima do teto, e camadas de imagem órfãs (as que sobram
#           quando uma imagem é reconstruída e a versão velha perde o nome)
#   NÃO     volume nenhum. Volume é DADO: é onde moram o Postgres, os uploads e o SQLite
#           da casa velha. Nenhum comando aqui aceita `volume`, de propósito.
#   NÃO     imagem em uso, nem imagem nomeada. `image prune` sem `-a` só pega órfã --
#           com `-a` ele levaria imagens que nenhum contêiner está rodando AGORA, o que
#           inclui a versão anterior da API, que é para onde se volta quando algo dá errado.
#
# ── O TETO, EM VEZ DE APAGAR TUDO ───────────────────────────────────────────────────────
# `--max-used-space` deixa o cache existir até um limite e joga fora o mais velho acima
# dele. Apagar tudo toda semana faria a primeira publicação de cada semana ser lenta sem
# necessidade. 20 GB é folgado para o ritmo de publicação daqui e é 5% do disco.
#
# ATENÇÃO À VERSÃO: até o Docker 28 esta flag se chamava `--keep-storage`. Aqui roda o 29,
# onde ela é `--max-used-space`. Se um dia o comando começar a recusar a flag, é isso --
# `docker builder prune --help` diz o nome atual.

set -u

TETO_DO_CACHE="20GB"
LOG_DATA=$(date -u '+%Y-%m-%d %H:%M UTC')

echo "════════════════════════════════════════════════════════════════════"
echo "FAXINA DO DOCKER -- $LOG_DATA"

# ── TRAVA: não limpar no meio de uma publicação ────────────────────────────────────────
# Um build em andamento está usando cache. O buildkit protege o que está em uso, mas uma
# faxina competindo com uma publicação é ruído na hora errada -- se colidir, a publicação é
# que importa, e a faxina pode esperar até domingo que vem.
EM_BUILD=$(docker ps --filter 'name=buildkit' --format '{{.Names}}' 2>/dev/null)
if [ -n "$EM_BUILD" ]; then
  echo "  ADIADA: há publicação em andamento ($EM_BUILD). Nada foi apagado."
  exit 0
fi

ANTES_PCT=$(df --output=pcent / | tail -1 | tr -d ' %')
ANTES_USADO=$(df -h --output=used / | tail -1 | tr -d ' ')
echo "  antes: disco em ${ANTES_PCT}% (${ANTES_USADO} usados)"

echo "  -- cache de compilação acima de $TETO_DO_CACHE --"
docker builder prune -f --max-used-space="$TETO_DO_CACHE" 2>&1 | tail -2 | sed 's/^/    /'

echo "  -- camadas de imagem órfãs --"
docker image prune -f 2>&1 | tail -2 | sed 's/^/    /'

DEPOIS_PCT=$(df --output=pcent / | tail -1 | tr -d ' %')
DEPOIS_USADO=$(df -h --output=used / | tail -1 | tr -d ' ')
echo "  depois: disco em ${DEPOIS_PCT}% (${DEPOIS_USADO} usados)"

# ── O AVISO QUE IMPORTA ────────────────────────────────────────────────────────────────
# Se mesmo DEPOIS da faxina o disco continua alto, o problema deixou de ser cache e passou a
# ser dado -- e aí a faxina semanal não resolve, ela só esconde. Esta linha é o que faz a
# diferença aparecer no log em vez de virar rotina silenciosa.
if [ "$DEPOIS_PCT" -ge 80 ]; then
  echo "  ATENÇÃO: o disco segue em ${DEPOIS_PCT}% DEPOIS da faxina."
  echo "           O que ocupa não é mais cache. Ver: docker system df; du -xh --max-depth=1 /var/lib/docker"
fi

# ── A PROVA DE QUE NADA CAIU ───────────────────────────────────────────────────────────
# A faxina não deveria derrubar nada, e esta linha é o que permite afirmar isso olhando o
# log de um domingo qualquer, em vez de confiar na intenção do script.
echo "  contêineres de pé ao final: $(docker ps -q | wc -l)"
docker ps --format '    {{.Names}}  {{.Status}}'
echo "FIM -- $(date -u '+%Y-%m-%d %H:%M UTC')"
