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
# Rodar isto é barato. Não rodar é apostar.
#
# ── E ELE NÃO ENCOSTA EM NADA QUE ESTEJA NO AR ─────────────────────────────────────────
# O Postgres do ensaio é um contêiner novo, com nome próprio, numa porta que não é a de
# ninguém, e ele é destruído no fim. Nenhum comando aqui aponta para loop-os-postgres nem para
# novo-gestao-postgres.

set -eu

CONFIG=/opt/backup/r2.env
AREA=/opt/backup/ensaio
CONTEINER=ensaio-restauracao-postgres

log() { echo "[$(date -u +%H:%M:%S)] $1"; }
morre() { echo "FALHOU: $1" >&2; exit 1; }

[ -f "$CONFIG" ] || morre "não existe $CONFIG"
# shellcheck disable=SC1090
. "$CONFIG"

# region=auto e obrigatorio: sem ela o SDK do rclone 1.75 recusa antes de sair da maquina,
# com "region was not a valid DNS name".
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

# ── 1. qual é a cópia mais recente ──────────────────────────────────────────────────────
log "procurando a cópia mais recente..."
ULTIMA=$(rclone lsf --bind 0.0.0.0 "r2:${R2_BUCKET}/bancos/" --dirs-only --recursive 2>/dev/null \
  | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}/[0-9T:-]+Z/$' | sort | tail -1)
[ -n "$ULTIMA" ] || morre "não há nenhuma cópia no balde -- rode copiar.sh primeiro"
log "cópia: $ULTIMA"

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

# ── 3. o Postgres descartável ───────────────────────────────────────────────────────────
log "subindo um Postgres descartável..."
docker run -d --name "$CONTEINER" \
  -e POSTGRES_PASSWORD=ensaio -e POSTGRES_USER=ensaio -e POSTGRES_DB=ensaio \
  postgres:16-alpine >/dev/null || morre "não subiu o contêiner do ensaio"

i=0
until docker exec "$CONTEINER" pg_isready -U ensaio >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 30 ] && morre "o Postgres do ensaio não ficou pronto"
  sleep 2
done

# ── 4. restaurar e CONFERIR ─────────────────────────────────────────────────────────────
# Restaurar sem erro não prova nada: um dump vazio restaura lindamente. O que se mede é se as
# tabelas voltaram com LINHAS dentro.
log "restaurando produção..."
gunzip -c "$AREA/producao-gestao.sql.gz" \
  | docker exec -i "$CONTEINER" psql -U ensaio -d ensaio -q >/dev/null 2>&1 \
  || morre "psql recusou o dump de produção"

TABELAS=$(docker exec "$CONTEINER" psql -U ensaio -d ensaio -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
CONTRATOS=$(docker exec "$CONTEINER" psql -U ensaio -d ensaio -tAc \
  'SELECT count(*) FROM "Contract"' 2>/dev/null || echo 0)

log "tabelas restauradas: $TABELAS"
log "contratos restaurados: $CONTRATOS"

[ "$TABELAS" -gt 20 ] || morre "só $TABELAS tabelas voltaram -- a cópia está incompleta"
[ "$CONTRATOS" -gt 0 ] || morre "nenhum contrato voltou -- a cópia tem esquema e não tem dados"

# ── 5. e o SQLite ───────────────────────────────────────────────────────────────────────
# A pergunta aqui é a que o WAL torna real: a cópia trouxe as gravações recentes, ou só o que
# já tinha sido escrito no arquivo principal?
log "conferindo o SQLite..."
gunzip -c "$AREA/staging-operacao.db.gz" > "$AREA/operacao.db"
TELAS=$(docker run --rm -v "$AREA:/w" -w /w node:20-alpine sh -c \
  "npm i better-sqlite3 --silent >/dev/null 2>&1 && node -e \"
const D=require('better-sqlite3');
const db=new D('/w/operacao.db',{readonly:true});
console.log(db.prepare('SELECT COUNT(*) c FROM devices').get().c);
\"" 2>/dev/null || echo erro)

log "telas no SQLite restaurado: $TELAS"
[ "$TELAS" != "erro" ] || morre "o SQLite restaurado não abriu"

echo
echo "O ENSAIO PASSOU -- a cópia de ${ULTIMA} volta."
echo "  $TABELAS tabelas, $CONTRATOS contratos, $TELAS telas."
