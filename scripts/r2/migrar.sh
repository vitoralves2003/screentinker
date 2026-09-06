#!/bin/sh
# MIGRAR OS ARQUIVOS PARA O R2 — mídias (volume da Operação dentro da Gestão) e documentos.
#   sh migrar.sh conferir   lista tamanhos, local e remoto, sem copiar
#   sh migrar.sh copiar     rclone copy (nunca sync: sync apaga no destino o que sumiu na origem)
# Lê /opt/backup/r2-arquivos.env (ver LEIA-ME.md).
set -u
CONFIG=/opt/backup/r2-arquivos.env
[ -f "$CONFIG" ] || { echo "falta $CONFIG (ver scripts/r2/LEIA-ME.md)"; exit 1; }
set -a; . "$CONFIG"; set +a
for v in R2_ACCOUNT_ID R2_ARQUIVOS_ACCESS_KEY_ID R2_ARQUIVOS_SECRET_ACCESS_KEY; do
  eval "x=\${$v:-}"; [ -n "$x" ] || { echo "falta $v em $CONFIG"; exit 1; }
done
command -v rclone >/dev/null || { echo "rclone não está instalado"; exit 1; }

export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ARQUIVOS_ACCESS_KEY_ID" RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_ARQUIVOS_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

# Onde os arquivos estão no disco, resolvido a partir do PRÓPRIO container da Gestão — nada de
# adivinhar nome de volume. As mídias moram onde a Gestão LÊ o content (a env CONTENT_DIR, que
# hoje aponta para o volume da Operação montado nela, /dados-operacao-velha/uploads/content); os
# documentos e as logomarcas ficam em /app/uploads/{contracts,organizations}.
API=novo-gestao-api
# Mapeia um caminho de DENTRO do container para o host, pelo mount mais específico que o contém.
mapear_host() {
  docker inspect "$API" --format '{{range .Mounts}}{{.Destination}}|{{.Source}}{{"\n"}}{{end}}' 2>/dev/null \
    | awk -F'|' -v p="$1" '
        $1 != "" && index(p, $1) == 1 && (length(p) == length($1) || substr(p, length($1) + 1, 1) == "/") && length($1) > blen \
          { blen = length($1); dest = $1; src = $2 }
        END { if (blen) print src substr(p, length(dest) + 1) }'
}
UPLOADS=$(mapear_host /app/uploads)
[ -n "$UPLOADS" ] || { echo "não achei o volume /app/uploads do $API"; exit 1; }
CONTENT_C=$(docker exec "$API" printenv CONTENT_DIR 2>/dev/null)
[ -n "$CONTENT_C" ] || CONTENT_C=/dados-operacao-velha/uploads/content
CONTENT=$(mapear_host "$CONTENT_C")
{ [ -n "$CONTENT" ] && [ -d "$CONTENT" ]; } || { echo "não achei o content no host ($CONTENT_C -> ${CONTENT:-vazio})"; exit 1; }

case "${1:-conferir}" in
  conferir)
    echo "== mídias: $CONTENT"; du -sh "$CONTENT" 2>/dev/null; rclone size R2:loop-player-midias/content 2>/dev/null | head -2
    for d in contracts organizations; do
      echo "== documentos/$d: $UPLOADS/$d"; du -sh "$UPLOADS/$d" 2>/dev/null; rclone size "R2:loop-player-documentos/$d" 2>/dev/null | head -2
    done
    ;;
  copiar)
    echo "== mídias -> R2:loop-player-midias/content"
    rclone copy "$CONTENT" R2:loop-player-midias/content --transfers 8 --checkers 16 --exclude '*.baixando-*' --stats 30s --stats-one-line
    for d in contracts organizations; do
      [ -d "$UPLOADS/$d" ] || continue
      echo "== documentos/$d -> R2:loop-player-documentos/$d"
      rclone copy "$UPLOADS/$d" "R2:loop-player-documentos/$d" --transfers 8 --checkers 16 --stats 30s --stats-one-line
    done
    echo "pronto. Agora: sh migrar.sh conferir"
    ;;
  *) echo "uso: sh migrar.sh conferir|copiar"; exit 1 ;;
esac
