#!/bin/sh
# UMA CÓPIA FORA DA MÁQUINA -- a passagem diária.
#
# ── O QUE ELA COPIA, E POR QUE ESTAS TRÊS COISAS ────────────────────────────────────────
#   Postgres de produção   o produto inteiro: contratos, cobranças, telas, listas, mídias
#   SQLite da casa velha   o histórico da Operação antiga, enquanto o volume existir
#   Os arquivos .env       SEM ELES um banco restaurado não decifra os tokens guardados.
#                          É o erro clássico: a pessoa restaura tudo e descobre que as
#                          integrações estão mortas.
#
# ── O QUE MUDOU EM 13/09, E POR QUE O BACKUP FICOU SEIS NOITES SEM RODAR ────────────────
# Este script nasceu quando havia DOIS Postgres: o antigo (loop-os-postgres, "produção") e o
# novo (novo-gestao-postgres, "staging"). O antigo foi removido em 7/09, com a migração
# concluída. O script continuou pedindo o dump dele, e como `set -e` aborta na primeira falha,
# NADA depois rodou: nem o banco novo, nem o SQLite, nem as mídias. Seis noites de
# "No such container" no log, e a operação financeira real sem cópia.
#
# A lição está em dois lugares agora: o nome do contêiner é UM só e é conferido antes de
# qualquer coisa; e o script grava a data do último sucesso em /opt/backup/ultimo-sucesso,
# para quem olhar a máquina saber em segundos se a cópia de hoje existe.
#
# ── O SQLITE DA CASA VELHA ──────────────────────────────────────────────────────────────
# O contêiner da Operação antiga está PARADO desde 12/09 e não volta. Com ele parado o SQLite
# consolidou o diário (não há mais remote_display.db-wal ao lado do .db), então o arquivo
# sozinho é uma cópia consistente. O script confere isso antes de copiar: se um dia o diário
# reaparecer com conteúdo e o contêiner continuar parado, ele para e explica, em vez de subir
# uma cópia que abre e está incompleta -- o pior formato de defeito que um backup pode ter.
#
# ── E ELA NUNCA APAGA NADA ──────────────────────────────────────────────────────────────
# `rclone copy`, jamais `sync`: sync apaga no destino o que sumiu na origem. O token do R2
# também não tem permissão de exclusão, então um `sync` falharia -- mas a intenção precisa estar
# no script, e não só na permissão. Duas travas, e a de cima é a que se lê.

set -eu

CONFIG=/opt/backup/r2.env
AREA=/opt/backup/tmp
ESTADO=/opt/backup/ultimo-sucesso
DATA=$(date -u +%Y-%m-%d)
CARIMBO=$(date -u +%Y-%m-%dT%H-%M-%SZ)

# O banco de produção. UM nome, conferido no começo -- ver o cabeçalho.
PG_CONTEINER=novo-gestao-postgres
# A casa velha, parada. Some deste script no dia em que o volume for apagado.
VELHA_CONTEINER=novo-operacao
VELHA_VOLUME=/var/lib/docker/volumes/novo-operacao_novo_operacao_data/_data
MIDIAS_DIR=$VELHA_VOLUME/uploads

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
# ambiente do processo filho, e uma variavel apenas atribuida nao chega la.
export BACKUP_SENHA

command -v rclone >/dev/null || morre "rclone não está instalado"
command -v openssl >/dev/null || morre "openssl não está instalado"

# ── o contêiner do banco EXISTE e está de pé? ───────────────────────────────────────────
# É a pergunta que faltou por seis noites. Conferida antes de qualquer trabalho, com uma
# mensagem que diz o nome -- para o próximo rename de contêiner não virar outra semana muda.
docker inspect -f '{{.State.Running}}' "$PG_CONTEINER" 2>/dev/null | grep -q true \
  || morre "o contêiner do banco de produção ($PG_CONTEINER) não existe ou não está rodando -- confira 'docker ps' e o nome no topo deste script"

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
# IPv4 -- entao a Cloudflare via um endereco fora da lista e recusava TUDO com 403. O sintoma
# nao dizia "IP errado", dizia "Access Denied", que manda procurar no lugar errado.

# ── 1. o Postgres de produção ───────────────────────────────────────────────────────────
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
  # Um dump com esquema e sem dados também "sai bem". Contar uma tabela que nunca é vazia em
  # produção é a diferença entre copiar o banco e copiar a forma dele.
  grep -q '^COPY public."Contract" ' "$AREA/$saida.sql" || morre "o dump não tem a tabela Contract -- é o banco certo?"
  gzip "$AREA/$saida.sql"
  log "$conteiner ($base): $(du -h "$AREA/$saida.sql.gz" | cut -f1)"
}

log "Postgres de produção..."
dump_pg "$PG_CONTEINER" producao-gestao

# ── 2. o SQLite da casa velha ───────────────────────────────────────────────────────────
# Dois caminhos, decididos pelo estado do contêiner:
#   rodando  → backup online do próprio SQLite, que atravessa o diário (WAL)
#   parado   → o diário foi consolidado; o .db sozinho é consistente, e a gente CONFERE isso
log "SQLite da casa velha..."
if docker inspect -f '{{.State.Running}}' "$VELHA_CONTEINER" 2>/dev/null | grep -q true; then
  docker exec "$VELHA_CONTEINER" node -e "
const Database = require('/app/server/node_modules/better-sqlite3');
const db = new Database('/data/db/remote_display.db', { readonly: true });
db.backup('/tmp/copia.db')
  .then(() => { console.log('ok'); process.exit(0); })
  .catch((e) => { console.error(e.message); process.exit(1); });
" >/dev/null 2>"$AREA/sqlite.err" || morre "backup do SQLite falhou: $(tail -1 "$AREA/sqlite.err")"
  docker cp "$VELHA_CONTEINER:/tmp/copia.db" "$AREA/operacao-velha.db" >/dev/null
  docker exec "$VELHA_CONTEINER" rm -f /tmp/copia.db
  log "  (contêiner rodando: cópia online)"
else
  DB="$VELHA_VOLUME/db/remote_display.db"
  [ -f "$DB" ] || morre "o SQLite da casa velha não está em $DB -- se o volume foi apagado, remova este passo do script"
  # Diário com conteúdo e contêiner parado é a combinação que produz cópia incompleta.
  if [ -s "$DB-wal" ]; then
    morre "há um diário (remote_display.db-wal) com conteúdo e o contêiner está parado -- suba o contêiner uma vez para consolidar, ou copie os três arquivos juntos à mão"
  fi
  cp "$DB" "$AREA/operacao-velha.db"
  log "  (contêiner parado, sem diário pendente: cópia do arquivo)"
fi
[ -s "$AREA/operacao-velha.db" ] || morre "a cópia do SQLite saiu vazia"
gzip "$AREA/operacao-velha.db"
log "SQLite: $(du -h "$AREA/operacao-velha.db.gz" | cut -f1)"

# ── 3. os segredos ──────────────────────────────────────────────────────────────────────
# Só os que EXISTEM entram, e pelo menos os dois do produto têm de existir. A versão anterior
# listava um caminho apagado e silenciava o erro com `|| true`; funcionava por acaso.
log "arquivos de ambiente..."
ENVS=""
for f in opt/novo-gestao/repo/.env opt/novo-operacao/.env opt/backup/r2-arquivos.env; do
  [ -f "/$f" ] && ENVS="$ENVS $f"
done
echo "$ENVS" | grep -q 'opt/novo-gestao/repo/.env' || morre "o .env da Gestão não existe em /opt/novo-gestao/repo -- sem ele a restauração não decifra nada"
# shellcheck disable=SC2086
tar czf "$AREA/ambiente.tar.gz" -C / $ENVS
[ -s "$AREA/ambiente.tar.gz" ] || morre "nenhum .env foi capturado"
log "ambiente:$ENVS"

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
# Cada dia escreve uma CHAVE NOVA, com data no nome. Nada é sobrescrito, nada é apagado.
# Os .err são stderr de cada etapa e não sobem: um dia levariam uma mensagem de erro com dado
# dentro para o balde SEM CIFRA.
rm -f "$AREA"/*.err

log "subindo para o R2..."
rclone copy --bind 0.0.0.0 "$AREA" "r2:${R2_BUCKET}/bancos/${DATA}/${CARIMBO}/" --s3-no-check-bucket \
  || morre "envio dos bancos falhou"

# ── 6. as mídias, incrementais e em claro ───────────────────────────────────────────────
# `copy` e não `sync`. Ele só sobe o que ainda não está lá, então o custo diário é o que você
# acrescentou. EM CLARO, de propósito: são anúncios feitos para tocar em parede de loja.
#
# O BALDE É IMUTÁVEL, E ISSO DERRUBOU A PRIMEIRA RODADA DO SCRIPT NOVO (13/09). O R2 tem trava
# de retenção nos objetos: nada lá pode ser alterado nem apagado. O rclone, ao ver um arquivo
# com o mesmo tamanho e data diferente (as miniaturas regeneradas), tentava só "corrigir a
# data" -- e isso é uma reescrita, que a trava recusa com 409. Vinte e uma recusas, e o script
# inteiro saía com erro DEPOIS de os bancos já terem subido.
#
# `--ignore-existing`: o que já está no balde não é tocado, nunca. Um nome de mídia é único
# (id gerado), então um arquivo existente com o mesmo nome É o mesmo arquivo.
# `--no-update-modtime`: e nem a data se corrige. Backup imutável é para não mexer.
log "mídias..."
[ -d "$MIDIAS_DIR" ] || morre "a pasta de mídias não está em $MIDIAS_DIR"
rclone copy --bind 0.0.0.0 --ignore-existing --no-update-modtime \
  "$MIDIAS_DIR" "r2:${R2_BUCKET}/midias/" --s3-no-check-bucket \
  || morre "envio das mídias falhou"

# ── 7. o registro do sucesso ────────────────────────────────────────────────────────────
# Um arquivo com a data, escrito SÓ no fim. Quem abrir a máquina sabe em segundos se a cópia
# de hoje existe -- e o ensaio de restauração passou a recusar cópia velha demais.
echo "$CARIMBO bancos/${DATA}/${CARIMBO}/" > "$ESTADO"
log "pronto: bancos/${DATA}/${CARIMBO}/"

# O heartbeat do monitoramento: um toque DEPOIS do sucesso, nunca antes. A URL vem do Better
# Stack e mora em /opt/backup/r2.env como BACKUP_HEARTBEAT_URL. Sem ela, nada muda.
[ -n "${BACKUP_HEARTBEAT_URL:-}" ] && { curl -fsS -m 10 "$BACKUP_HEARTBEAT_URL" >/dev/null 2>&1 || log "aviso: o heartbeat do backup não tocou"; }
exit 0
