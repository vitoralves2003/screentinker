#!/bin/sh
# O ENVIO EM MASSA, CLICADO NUM NAVEGADOR.
#
# ── POR QUE ELA EXISTE ───────────────────────────────────────────────────────────────────
# Este seletor teve QUATRO defeitos num dia, e os quatro foram achados pelo Vitor olhando a tela,
# nenhum pelas provas: o grupo que nao aparecia, o espaco proprio das telas oferecido como
# playlist, a busca escondida abaixo de seis itens, e o botao dizendo "Enviar para 2" com nada
# marcado a frente.
#
# Nao e azar. Havia prova de que a pagina carrega sem erro de JavaScript e prova de que a rota
# funciona por API -- e nenhuma de que o SELETOR faz o que promete quando alguem clica. As duas
# metades verdes e o meio nunca medido.
#
# Esta prova clica.
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
  *)
    echo "  FALHOU nao autenticou $EMAIL"
    echo "         o limite de login e 10/min/IP: se outra suite acabou de rodar, espere um"
    echo "         minuto. Um vermelho aqui por 429 nao e defeito do produto."
    exit 1
    ;;
esac

# ── O CENARIO, montado aqui e desmontado no fim ───────────────────────────────────────────
# A conta de teste nao tem arquivo nenhum, e sem arquivo nao ha o que selecionar. Depender do que
# a conta por acaso tem e como uma prova sai com "sem dados" -- que e o mesmo que nao existir.
WS=$(echo "$TK" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['current_workspace_id'])" 2>/dev/null)

docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
const ws='$WS';
const u=db.prepare('SELECT id FROM users LIMIT 1').get();

for (const [id,nome] of [['c-massa-1','massa-um.png'],['c-massa-2','massa-dois.png']]) {
  db.prepare('INSERT OR REPLACE INTO content (id,user_id,workspace_id,filename,filepath,mime_type,duration_sec) VALUES (?,?,?,?,?,?,10)')
    .run(id,u.id,ws,nome,'/tmp/'+nome,'image/png');
}

// Uma lista NORMAL, para o tipo 'listas' existir -- as automaticas nao contam, e sao justamente
// o que nao pode aparecer.
db.prepare(\"INSERT OR REPLACE INTO playlists (id,user_id,workspace_id,name,status) VALUES (?,?,?,'Lista da prova de massa','published')\")
  .run('pl-massa',u.id,ws);

// Um grupo com as telas da conta, para 'grupos' existir e ser escolhivel.
db.prepare(\"INSERT OR REPLACE INTO device_groups (id,user_id,workspace_id,name) VALUES (?,?,?,'Grupo da prova')\")
  .run('g-massa',u.id,ws);
db.prepare('DELETE FROM device_group_members WHERE group_id=?').run('g-massa');
for (const d of db.prepare('SELECT id FROM devices WHERE workspace_id=?').all(ws)) {
  db.prepare('INSERT OR IGNORE INTO device_group_members (device_id,group_id) VALUES (?,?)').run(d.id,'g-massa');
}
console.log('cenario montado');
" >/dev/null

limpar_cenario() {
  docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
db.prepare('DELETE FROM playlist_items WHERE content_id IN (?,?)').run('c-massa-1','c-massa-2');
db.prepare('DELETE FROM playlist_items WHERE playlist_id=?').run('pl-massa');
db.prepare('DELETE FROM content WHERE id IN (?,?)').run('c-massa-1','c-massa-2');
db.prepare('DELETE FROM playlists WHERE id=?').run('pl-massa');
db.prepare('DELETE FROM device_group_members WHERE group_id=?').run('g-massa');
db.prepare('DELETE FROM device_groups WHERE id=?').run('g-massa');
console.log('cenario removido');
" >/dev/null
}

docker run --rm --network host \
  --entrypoint node \
  -e NODE_PATH=/usr/src/app/node_modules \
  -e TOKEN="$TK" \
  -e BASE="$OP" \
  -v "$AQUI:/p" \
  "$IMAGEM" /p/abrir_envio_em_massa.js
SAIDA=$?

# Desmontar faz parte da prova: uma suite que deixa arquivo e grupo para tras faz a proxima medir
# um ambiente que ninguem montou de proposito.
limpar_cenario

exit $SAIDA
