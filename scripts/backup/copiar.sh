#!/bin/sh
# UMA CÓPIA FORA DA MÁQUINA -- a passagem diária.
#
# ── O QUE ELA COPIA, E POR QUE ESTAS QUATRO COISAS ──────────────────────────────────────
#   Postgres de produção   os dados da Gestão
#   Postgres do staging    onde o trabalho acontece hoje
#   SQLite da Operação     telas, listas, snapshots publicados
#   Os arquivos .env       SEM ELES um banco restaurado não decifra os tokens guardados.
#                          É o erro clássico: a pessoa restaura tudo e descobre que as
#                          integrações estão mortas.
#
# ── O SQLITE NÃO É COPIADO COM `cp` ─────────────────────────────────────────────────────
# O banco está em modo WAL (há um remote_display.db-wal ao lado dele). Copiar só o arquivo .db
# produz um banco que ABRE NORMALMENTE e está sem tudo o que ainda vive no WAL -- uma cópia que
# parece boa e chegou incompleta. O pior formato de defeito que um backup pode ter.
#
# Por isso usamos o backup online do próprio SQLite (better-sqlite3 `.backup()`), que atravessa
# o WAL e devolve um arquivo consistente com o banco vivo.
#
# ── E ELA NUNCA APAGA NADA ──────────────────────────────────────────────────────────────
# `rclone copy`, jamais `sync`: sync apaga no destino o que sumiu na origem. O token do R2
# também não tem permissão de exclusão, então um `sync` falharia -- mas a intenção precisa estar
# no script, e não só na permissão. Duas travas, e a de cima é a que se lê.

set -eu

CONFIG=/opt/backup/r2.env
AREA=/opt/backup/tmp
DATA=$(date -u +%Y-%m-%d)
CARIMBO=$(date -u +%Y-%m-%dT%H-%M-%SZ)

log() { echo "[$(date -u +%H:%M:%S)] $1"; }
morre() { echo "FALHOU: $1" >&2; exit 1; }

# ── a configuração, e a recusa de rodar pela metade ─────────────────────────────────────
# Um backup que roda sem credencial "funciona" (sai 0, não escreve nada) e some do radar. Ele
# tem de gritar no primeiro dia, não no dia da restauração.
[ -f "$CONFIG" ] || morre "não existe $CONFIG -- as credenciais do R2 ainda não foram postas"
# shellcheck disable=SC1090
. "$CONFIG"

for v in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET BACKUP_SENHA; do
  eval "valor=\${$v:-}"
  [ -n "$valor" ] || morre "$v está vazio em $CONFIG"
done

# A senha precisa ir para o AMBIENTE, e nao so para o shell: `openssl -pass env:` le do
# ambiente do processo filho, e uma variavel apenas atribuida nao chega la. Sem isto o script
# morre na cifra -- que e o que ele deve fazer, mas o conserto e esta linha.
export BACKUP_SENHA

command -v rclone >/dev/null || morre "rclone não está instalado"
command -v openssl >/dev/null || morre "openssl não está instalado"

# ── área temporária, sempre limpa ───────────────────────────────────────────────────────
# O trap roda inclusive quando o script morre no meio: um dump de clientes esquecido em /opt é
# uma cópia sem cifra num disco que a gente acabou de decidir não confiar.
rm -rf "$AREA"
mkdir -p "$AREA"
trap 'rm -rf "$AREA"' EXIT INT TERM

# rclone lê a configuração do ambiente -- nada de arquivo de config com segredo dentro.
# region=auto e obrigatorio: sem ela o SDK do rclone 1.75 recusa antes de sair da maquina,
# com "region was not a valid DNS name".
export RCLONE_CONFIG_R2_REGION=auto
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true

# ── SAIR SEMPRE POR IPv4 (--bind 0.0.0.0 em toda chamada) ──────────────────────────────
# A VPS tem endereco IPv6 global, e o rclone o preferia. O filtro de IP do token so permite o
# IPv4 -- entao a Cloudflare via um endereco fora da lista e recusava TUDO com 403: gravar,
# ler e listar. O sintoma nao dizia "IP errado", dizia "Access Denied", que manda procurar
# no lugar errado (permissao, balde, chave).
#
# Forcado aqui, e nao resolvido acrescentando o IPv6 ao filtro: endereco IPv6 de VPS muda em
# migracao, e ai o backup pararia de novo -- pelo mesmo motivo, com a mesma mensagem enganosa.

# ── 1. os dois Postgres ─────────────────────────────────────────────────────────────────
dump_pg() {
  conteiner=$1; saida=$2
  usuario=$(docker exec "$conteiner" sh -c 'echo $POSTGRES_USER')
  base=$(docker exec "$conteiner" sh -c 'echo $POSTGRES_DB')
  [ -n "$usuario" ] && [ -n "$base" ] || morre "não descobri usuário/base de $conteiner"

  # O pipe inteiro tem de falhar junto: sem isto, um pg_dump que morre no meio ainda produz um
  # .gz válido -- pequeno, aberto sem erro, e sem metade das tabelas.
  if ! docker exec "$conteiner" pg_dump -U "$usuario" -d "$base" > "$AREA/$saida.sql" 2>"$AREA/$saida.err"; then
    morre "pg_dump de $conteiner falhou: $(tail -1 "$AREA/$saida.err")"
  fi
  [ -s "$AREA/$saida.sql" ] || morre "o dump de $conteiner saiu vazio"
  gzip "$AREA/$saida.sql"
  log "$conteiner: $(du -h "$AREA/$saida.sql.gz" | cut -f1)"
}

log "Postgres..."
dump_pg loop-os-postgres producao-gestao
dump_pg novo-gestao-postgres staging-gestao

# ── 2. o SQLite, pelo backup online ─────────────────────────────────────────────────────
# NÃO é `cp`. Ver o cabeçalho: o banco está em WAL, e copiar o .db cru entrega um arquivo que
# abre e está incompleto.
log "SQLite da Operação..."
docker exec novo-operacao node -e "
const Database = require('/app/server/node_modules/better-sqlite3');
const db = new Database('/data/db/remote_display.db', { readonly: true });
db.backup('/tmp/copia.db')
  .then(() => { console.log('ok'); process.exit(0); })
  .catch((e) => { console.error(e.message); process.exit(1); });
" >/dev/null 2>"$AREA/sqlite.err" || morre "backup do SQLite falhou: $(tail -1 "$AREA/sqlite.err")"

docker cp novo-operacao:/tmp/copia.db "$AREA/staging-operacao.db" >/dev/null
docker exec novo-operacao rm -f /tmp/copia.db
[ -s "$AREA/staging-operacao.db" ] || morre "a cópia do SQLite saiu vazia"
gzip "$AREA/staging-operacao.db"
log "SQLite: $(du -h "$AREA/staging-operacao.db.gz" | cut -f1)"

# ── 3. os segredos ──────────────────────────────────────────────────────────────────────
log "arquivos de ambiente..."
tar czf "$AREA/ambiente.tar.gz" \
  -C / \
  opt/loop-os-app/repo/.env \
  opt/novo-gestao/repo/.env \
  opt/novo-operacao/.env 2>/dev/null || true
[ -s "$AREA/ambiente.tar.gz" ] || morre "nenhum .env foi capturado -- uma restauração sem eles não decifra nada"

# ── 4. cifrar ───────────────────────────────────────────────────────────────────────────
# São nomes, documentos e WhatsApp de pessoas reais. A senha vem do arquivo de configuração e
# TAMBÉM está com o Vitor: uma cópia cifrada cuja única chave morreu junto com o servidor é
# uma cópia que não existe.
log "cifrando..."
for f in "$AREA"/*.gz; do
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
    -in "$f" -out "$f.enc" -pass env:BACKUP_SENHA || morre "cifra falhou em $f"
  rm -f "$f"
done

# ── 5. subir ────────────────────────────────────────────────────────────────────────────
# Cada dia escreve uma CHAVE NOVA, com data no nome. Nada é sobrescrito, nada é apagado -- é
# assim que a permissão sem exclusão vira histórico de verdade.
# Os arquivos .err sao a captura de stderr de cada etapa -- servem para a mensagem de falha e
# nao para o backup. Subi-los enche a copia de arquivos vazios e, pior, um dia levaria uma
# mensagem de erro com dado dentro para o balde SEM CIFRA.
rm -f "$AREA"/*.err

log "subindo para o R2..."
rclone copy --bind 0.0.0.0 "$AREA" "r2:${R2_BUCKET}/bancos/${DATA}/${CARIMBO}/" --s3-no-check-bucket \
  || morre "envio dos bancos falhou"

# ── 6. as mídias, incrementais e em claro ───────────────────────────────────────────────
# `copy` e não `sync`: sync apagaria no destino o que sumiu na origem, que é o oposto de um
# backup. Ele só sobe o que ainda não está lá, então o custo diário é o que você acrescentou.
#
# EM CLARO, de propósito: são anúncios feitos para tocar em parede de loja, não dado pessoal.
# Cifrá-los custaria CPU e mataria o incremental -- cada cifra muda o arquivo inteiro, e todo
# dia subiria tudo de novo.
log "mídias..."
rclone copy --bind 0.0.0.0 /var/lib/docker/volumes/novo-operacao_novo_operacao_data/_data/uploads \
  "r2:${R2_BUCKET}/midias/" --s3-no-check-bucket \
  || morre "envio das mídias falhou"

log "pronto: bancos/${DATA}/${CARIMBO}/"
