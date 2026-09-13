#!/bin/sh
# UM BACKUP QUE NINGUÉM RESTAUROU É UMA HIPÓTESE.
#
# Este é o ensaio: baixa a cópia mais recente do R2, decifra, e sobe os dados num Postgres
# DESCARTÁVEL para conferir que o que está guardado volta de verdade.
#
# ── POR QUE ISTO EXISTE COMO SCRIPT, E NÃO COMO "a gente testa um dia" ──────────────────
# Todo backup quebrado do mundo passou meses parecendo bom. Os arquivos chegam, o tamanho é
# plausível, o log diz "pronto" -- e a única pergunta que importa (isto volta?) só é feita no
# dia em que não dá mais para escolher a resposta.
#
# Em 13/09 o exemplo foi nosso: seis noites de cópia falhando em silêncio, e o ensaio mensal
# só rodaria em 1/10. Por isso ele agora também recusa cópia VELHA: se a mais recente no balde
# tem mais de dois dias, o ensaio reprova antes de restaurar, porque um backup que restaura mas
# está desatualizado é o mesmo problema com outro nome.
#
# ── E ELE NÃO ENCOSTA EM NADA QUE ESTEJA NO AR ─────────────────────────────────────────
# O Postgres do ensaio é um contêiner novo, com nome próprio, sem porta publicada, e ele é
# destruído no fim. Nenhum comando aqui escreve em novo-gestao-postgres. A única leitura da
# produção é contar linhas, para a comparação do fim.

set -eu

CONFIG=/opt/backup/r2.env
AREA=/opt/backup/ensaio
CONTEINER=ensaio-restauracao-postgres
PG_PRODUCAO=novo-gestao-postgres
VELHA_CONTEINER=novo-operacao
IDADE_MAXIMA_DIAS=2

log() { echo "[$(date -u +%H:%M:%S)] $1"; }
morre() { echo "FALHOU: $1" >&2; exit 1; }

[ -f "$CONFIG" ] || morre "não existe $CONFIG"
# shellcheck disable=SC1090
. "$CONFIG"

export BACKUP_SENHA

export RCLONE_CONFIG_R2_REGION=auto
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

limpar() {
  docker rm -f "$CONTEINER" >/dev/null 2>&1 || true
  rm -rf "$AREA"
}
trap limpar EXIT INT TERM

rm -rf "$AREA"; mkdir -p "$AREA"

# ── 1. qual é a cópia mais recente, e ela é recente MESMO ───────────────────────────────
log "procurando a cópia mais recente..."
ULTIMA=$(rclone lsf --bind 0.0.0.0 "r2:${R2_BUCKET}/bancos/" --dirs-only --recursive 2>/dev/null \
  | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}/[0-9T:-]+Z/$' | sort | tail -1)
[ -n "$ULTIMA" ] || morre "não há nenhuma cópia no balde -- rode copiar.sh primeiro"
log "cópia: $ULTIMA"

# A data está no caminho (AAAA-MM-DD/...). Cópia velha demais reprova antes de qualquer
# download: é o ensaio dizendo "o backup parou" no dia em que parou, e não no dia 1 do mês.
DIA_DA_COPIA=$(echo "$ULTIMA" | cut -d/ -f1)
SEGUNDOS_COPIA=$(date -u -d "$DIA_DA_COPIA" +%s 2>/dev/null || echo 0)
SEGUNDOS_HOJE=$(date -u +%s)
IDADE_DIAS=$(( (SEGUNDOS_HOJE - SEGUNDOS_COPIA) / 86400 ))
[ "$IDADE_DIAS" -le "$IDADE_MAXIMA_DIAS" ] \
  || morre "a cópia mais recente é de $DIA_DA_COPIA ($IDADE_DIAS dias) -- o backup diário parou; veja /var/log/backup.log"

rclone copy --bind 0.0.0.0 "r2:${R2_BUCKET}/bancos/${ULTIMA}" "$AREA/" || morre "download falhou"

# ── 2. decifrar ─────────────────────────────────────────────────────────────────────────
# Se a senha estiver errada, é AQUI que se descobre -- e não no dia do incêndio.
log "decifrando..."
for f in "$AREA"/*.enc; do
  [ -e "$f" ] || morre "nenhum arquivo cifrado na cópia"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
    -in "$f" -out "${f%.enc}" -pass env:BACKUP_SENHA \
    || morre "não decifrou $(basename "$f") -- a senha em $CONFIG não abre esta cópia"
done
[ -f "$AREA/producao-gestao.sql.gz" ] || morre "a cópia não tem o dump de produção (producao-gestao.sql.gz)"

# ── 3. o Postgres descartável ───────────────────────────────────────────────────────────
# A MESMA versão maior da produção: um dump do 16 restaurado num 15 falha por sintaxe, e o
# ensaio reprovaria uma cópia boa. Lida do contêiner de produção, para não envelhecer aqui.
VERSAO=$(docker exec "$PG_PRODUCAO" sh -c 'echo $PG_MAJOR' 2>/dev/null || echo 16)
log "subindo um Postgres descartável (${VERSAO})..."
docker run -d --name "$CONTEINER" \
  -e POSTGRES_PASSWORD=ensaio -e POSTGRES_USER=ensaio -e POSTGRES_DB=ensaio \
  "postgres:${VERSAO}-alpine" >/dev/null || morre "não subiu o contêiner do ensaio"

i=0
until docker exec "$CONTEINER" pg_isready -U ensaio >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 30 ] && morre "o Postgres do ensaio não ficou pronto"
  sleep 2
done

# ── 4. restaurar e CONFERIR ─────────────────────────────────────────────────────────────
# Restaurar sem erro não prova nada: um dump vazio restaura lindamente. O que se mede é se as
# tabelas voltaram com LINHAS dentro -- e quantas, contra a produção viva.
log "restaurando produção..."
gunzip -c "$AREA/producao-gestao.sql.gz" \
  | docker exec -i "$CONTEINER" psql -U ensaio -d ensaio -q >/dev/null 2>&1 \
  || morre "psql recusou o dump de produção"

conta_ensaio() { docker exec "$CONTEINER" psql -U ensaio -d ensaio -tAc "$1" 2>/dev/null || echo 0; }
conta_producao() {
  u=$(docker exec "$PG_PRODUCAO" sh -c 'echo $POSTGRES_USER'); b=$(docker exec "$PG_PRODUCAO" sh -c 'echo $POSTGRES_DB')
  docker exec "$PG_PRODUCAO" psql -U "$u" -d "$b" -tAc "$1" 2>/dev/null || echo '?'
}

TABELAS=$(conta_ensaio "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
log "tabelas restauradas: $TABELAS"
[ "$TABELAS" -gt 20 ] || morre "só $TABELAS tabelas voltaram -- a cópia está incompleta"

# As contagens que importam para o produto, lado a lado com a produção AGORA. Diferença
# pequena é normal (o dia andou desde a cópia); zero numa tabela que a produção tem cheia é
# esquema sem dados.
log "contagens (cópia | produção agora):"
for par in 'contratos|"Contract"' 'cobranças|"ContractCharge"' 'clientes|"Client"' 'telas|devices' 'mídias|content' 'listas|playlists' 'usuários|"User"'; do
  nome=${par%%|*}; tabela=${par#*|}
  c=$(conta_ensaio "SELECT count(*) FROM $tabela"); p=$(conta_producao "SELECT count(*) FROM $tabela")
  log "  $nome: $c | $p"
  [ "$c" -gt 0 ] || morre "a cópia tem zero em $tabela -- esquema sem dados"
done

# ── 5. e o SQLite da casa velha ─────────────────────────────────────────────────────────
# integrity_check varre o arquivo inteiro e acusa corrupção que uma contagem passaria batido.
# O contêiner da casa velha está parado, então a conferência roda num contêiner descartável
# com o sqlite3 de linha de comando -- sem compilar nada, que foi o que reprovou uma cópia boa
# na primeira versão deste ensaio.
log "conferindo o SQLite da casa velha..."
[ -f "$AREA/operacao-velha.db.gz" ] || morre "a cópia não tem o SQLite (operacao-velha.db.gz)"
gunzip -c "$AREA/operacao-velha.db.gz" > "$AREA/operacao.db"

#
# COPIADO PARA DENTRO DO CONTÊINER ANTES DE ABRIR (13/09). O banco está em modo diário, e o
# SQLite precisa criar um arquivo de memória compartilhada ao lado dele para abrir -- mesmo
# só para ler. Em pasta montada só-leitura isso dá "unable to open database file (14)", e o
# ensaio reprovava uma cópia perfeita com "não respondeu". Um ensaio que reprova o que está
# bom treina a pessoa a ignorá-lo, que é o pior resultado possível.
SAIDA=$(docker run --rm -v "$AREA:/e:ro" alpine:3.20 sh -c \
  "apk add --no-cache -q sqlite >/dev/null 2>&1 && cp /e/operacao.db /tmp/ensaio.db && sqlite3 /tmp/ensaio.db \"SELECT (SELECT integrity_check FROM pragma_integrity_check LIMIT 1) || '|' || (SELECT count(*) FROM devices) || '|' || (SELECT count(*) FROM playlists);\"" 2>/dev/null | tr -d '\r')

INTEGRIDADE=$(echo "$SAIDA" | cut -d'|' -f1)
TELAS=$(echo "$SAIDA" | cut -d'|' -f2)
LISTAS=$(echo "$SAIDA" | cut -d'|' -f3)

log "integridade do SQLite: ${INTEGRIDADE:-não respondeu}"
log "telas: ${TELAS:-?} · listas: ${LISTAS:-?}"
[ "$INTEGRIDADE" = "ok" ] || morre "o SQLite restaurado não passou no integrity_check"
[ "${TELAS:-0}" -gt 0 ] || morre "nenhuma tela voltou no SQLite -- esquema sem dados"

# ── 6. os segredos vieram? ──────────────────────────────────────────────────────────────
# Um banco restaurado sem o .env não decifra os tokens das integrações. Só se confere que o
# pacote existe e lista os arquivos; o conteúdo não se imprime.
[ -f "$AREA/ambiente.tar.gz" ] || morre "a cópia não tem o pacote de ambiente"
ARQUIVOS_ENV=$(tar tzf "$AREA/ambiente.tar.gz" | tr '\n' ' ')
log "ambiente: $ARQUIVOS_ENV"
echo "$ARQUIVOS_ENV" | grep -q 'novo-gestao/repo/.env' || morre "o .env da Gestão não está no pacote"

echo
echo "O ENSAIO PASSOU -- a cópia de ${ULTIMA} volta."
echo "  $TABELAS tabelas no Postgres, SQLite íntegro com $TELAS telas, ambiente presente."
# O heartbeat do ensaio: só quando o restore conferiu. ENSAIO_HEARTBEAT_URL em /opt/backup/r2.env.
[ -n "${ENSAIO_HEARTBEAT_URL:-}" ] && { curl -fsS -m 10 "$ENSAIO_HEARTBEAT_URL" >/dev/null 2>&1 || echo "aviso: o heartbeat do ensaio não tocou"; }
