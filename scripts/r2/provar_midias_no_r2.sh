#!/bin/sh
# PROVA: com o R2 ligado, uma mídia servida do disco volta do R2 quando o disco não a tem (06/09).
#
# Pega a MENOR mídia de content, confirma que ela está no R2, apaga a cópia LOCAL, pede pela URL
# pública (o player não tem sessão — baixa anônimo) e confere byte a byte que o que voltou é a
# mesma mídia; depois confirma que o disco a recuperou sozinho (garantirLocal). Conservadora: guarda
# uma cópia de segurança e a restaura se qualquer passo falhar, para nunca perder o arquivo real.
set -u
BASE="${BASE:-https://beta.loopplayer.com.br}"
CRED=/opt/backup/r2-arquivos.env
CONTENT=$(docker exec novo-gestao-api printenv CONTENT_DIR 2>/dev/null)
CONTENT=$(docker inspect novo-gestao-api --format '{{range .Mounts}}{{.Destination}}|{{.Source}}{{"\n"}}{{end}}' 2>/dev/null \
  | awk -F'|' -v p="$CONTENT" '$1!="" && index(p,$1)==1 && (length(p)==length($1)||substr(p,length($1)+1,1)=="/") && length($1)>b {b=length($1);d=$1;s=$2} END{if(b)print s substr(p,length(d)+1)}')
[ -n "$CONTENT" ] && [ -d "$CONTENT" ] || { echo "FALHA: nao achei o content no host"; exit 1; }
[ -f "$CRED" ] || { echo "FALHA: falta $CRED"; exit 1; }

falhas=0
ok()    { echo "  ok    $1"; }
falha() { falhas=$((falhas+1)); echo "  FALHA $1"; }

# A menor mídia (mais rápida de baixar), ignorando os arquivos temporários de download.
ARQ=$(ls -S "$CONTENT" 2>/dev/null | grep -v '\.baixando-' | tail -1)
[ -n "$ARQ" ] || { echo "FALHA: content vazio"; exit 1; }
FULL="$CONTENT/$ARQ"
SHA=$(sha256sum "$FULL" | cut -d' ' -f1)
SIZE=$(stat -c %s "$FULL")
echo "mídia de prova: $ARQ ($SIZE bytes)"

# 1. está no R2?
set -a; . "$CRED"; set +a
export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ARQUIVOS_ACCESS_KEY_ID" RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_ARQUIVOS_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
if rclone lsf "R2:loop-player-midias/content/$ARQ" 2>/dev/null | grep -q "$ARQ"; then ok "a mídia está no R2"; else falha "a mídia NÃO está no R2 (não copiada?)"; exit 1; fi

# 2. apaga a cópia local (com rede de segurança)
cp "$FULL" /tmp/prova-midia.bak
rm -f "$FULL"
[ -f "$FULL" ] && falha "não consegui apagar a cópia local" || ok "cópia local apagada"

# 3. pede pela URL pública — deve baixar do R2 e servir
COD=$(curl -s -m 60 -o /tmp/prova-midia.out -w '%{http_code}' "$BASE/uploads/content/$ARQ")
SHA2=$(sha256sum /tmp/prova-midia.out 2>/dev/null | cut -d' ' -f1)
[ "$COD" = "200" ] && ok "a URL pública respondeu 200" || falha "a URL pública respondeu $COD"
[ "$SHA" = "$SHA2" ] && ok "o que voltou é a MESMA mídia (veio do R2)" || falha "o conteúdo servido difere do original (sha $SHA2)"

# 4. o disco a recuperou sozinho?
if [ -f "$FULL" ] && [ "$(sha256sum "$FULL" | cut -d' ' -f1)" = "$SHA" ]; then ok "garantirLocal rebaixou a cópia para o disco"; else falha "a cópia local não voltou"; fi

# rede de segurança: garante o arquivo de volta no disco de qualquer jeito
[ -f "$FULL" ] || cp /tmp/prova-midia.bak "$FULL"
rm -f /tmp/prova-midia.out /tmp/prova-midia.bak

echo ""
[ "$falhas" = "0" ] && echo "MÍDIAS NO R2: TUDO CERTO" || echo "$falhas FALHA(S)"
exit "$falhas"
