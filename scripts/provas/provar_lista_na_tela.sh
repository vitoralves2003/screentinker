#!/bin/sh
# A TELA E DONA DO SEU CONTEUDO -- e por uma lista nela e o que separa o Free do Pro.
#
# ── O QUE MUDOU ──────────────────────────────────────────────────────────────────────────
# Antes, uma tela apontava para UMA playlist (devices.playlist_id): escolher a lista de um
# anunciante SUBSTITUIA o que a tela ja tinha. Nao existia "os meus arquivos MAIS a lista dele".
#
# Agora o espaco da tela aceita as tres coisas -- arquivo, widget e lista -- e o motor que
# expande e roda a lista dentro dela ja existia inteiro (lib/sublists.js, e um cursor de rotacao
# por tela em device_sublist_state, para cada tela rodar a lista no proprio ritmo).
#
# ── A TRAVA VAI NAS DUAS PORTAS, E E ISSO QUE ESTA SUITE GUARDA ──────────────────────────
# Uma lista pode entrar num espaco por dois caminhos: POST /assignments/device/:id (a tela) e
# POST /playlists/:id/items (a pagina de listas). Um cadeado em so um deles seria um cadeado ao
# lado de uma janela aberta -- e uma trava contornavel em um clique e pior que nenhuma, porque
# parece protecao.
#
# ── E O ARQUIVO CONTINUA DE GRACA ────────────────────────────────────────────────────────
# O caso 4 e o que impede o conserto obvio e errado: um middleware geral no router trancaria
# tambem "adicionar um video a uma tela", que e o caminho mais curto do produto.

OP=http://127.0.0.1:3110
EMAIL=cliente@exemplo.invalid
SENHA='SenhaCliente#2026'

. /tmp/mfa_lib.sh

falhas=0
ok()  { echo "  OK     $1"; }
nok() { echo "  FALHOU $1"; falhas=$((falhas+1)); }

opdb() { docker exec novo-operacao node -e "$1" 2>/dev/null | tr -d '\r'; }

claim() {
  echo "$1" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('$2',''))" 2>/dev/null
}

S=$(entrar "$EMAIL" "$SENHA")
if [ -z "$S" ]; then echo "  FALHOU nao consegui entrar"; exit 1; fi
WS=$(claim "$S" current_workspace_id)

# Uma tela e uma lista deste workspace. A lista NAO pode ser a da propria tela: uma lista dentro
# de si mesma e justamente o que validateSubList recusa, e o teste mediria a recusa errada.
IDS=$(opdb "
const {db}=require('/app/server/db/database');
const d=db.prepare('SELECT id FROM devices WHERE workspace_id = ? LIMIT 1').get('$WS');
const dev = d ? d.id : '';
const p=db.prepare('SELECT id FROM playlists WHERE workspace_id = ? AND (is_auto_generated IS NULL OR is_auto_generated = 0) LIMIT 1').get('$WS');
console.log((dev||'') + ' ' + (p ? p.id : ''));
")
DEV=$(echo "$IDS" | cut -d' ' -f1)
LISTA=$(echo "$IDS" | cut -d' ' -f2)

if [ -z "$DEV" ] || [ -z "$LISTA" ]; then
  echo "  FALHOU sem tela ou sem lista neste workspace -- nao ha o que provar"
  exit 1
fi

plano_ler() {
  opdb "
const {db}=require('/app/server/db/database');
const r=db.prepare('SELECT plan_id FROM workspaces WHERE id = ?').get('$WS');
console.log(r && r.plan_id ? r.plan_id : '');
"
}
plano_escrever() {
  opdb "
const {db}=require('/app/server/db/database');
db.prepare('UPDATE workspaces SET plan_id = ? WHERE id = ?').run('$1' || null, '$WS');
" >/dev/null
}

# Remove o que a prova acrescentou, para a rodada seguinte medir o mesmo ambiente.
limpar() {
  opdb "
const {db}=require('/app/server/db/database');
const d=db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get('$DEV');
if (d && d.playlist_id) db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND sub_playlist_id = ?').run(d.playlist_id, '$LISTA');
" >/dev/null
}

por_lista() {
  curl -s -o /tmp/_lst.json -w '%{http_code}' -X POST "$OP/api/assignments/device/$DEV" \
    -H "Authorization: Bearer $1" -H 'Content-Type: application/json' \
    -d "{\"sub_playlist_id\":\"$LISTA\"}"
}

PLANO_ANTES=$(plano_ler)
if [ -z "$PLANO_ANTES" ]; then
  echo "  FALHOU nao consegui ler o plano -- nao mexo no que nao sei devolver"
  exit 1
fi

echo "=== COM PLANO QUE INCLUI (o de hoje: $PLANO_ANTES) ==="

echo "--- 1. uma lista entra na tela ---"
limpar
COD=$(por_lista "$S")
case "$COD" in
  201) ok "aceita ($COD)" ;;
  *)   nok "recusou com $COD: $(head -c 160 /tmp/_lst.json)" ;;
esac

echo "--- 2. e ela chega com NOME, nao como um item vazio ---"
# O ITEM_SELECT precisou aprender a terceira origem de nome. Sem isso a lista grava certo e
# aparece em branco na tela, que e pior que nao poder adiciona-la.
NOME=$(curl -s "$OP/api/assignments/device/$DEV" -H "Authorization: Bearer $S" | python3 -c "
import json,sys
try:
    itens=json.load(sys.stdin)
    achou=[i for i in itens if i.get('sub_playlist_id')]
    print(achou[0].get('filename') or '' if achou else '')
except Exception: print('')" 2>/dev/null)
[ -n "$NOME" ] && ok "aparece como \"$NOME\"" || nok "a lista entrou sem nome na resposta"

echo "--- 3. e ela toca em ordem por padrao, nao em silencio ---"
ORDEM=$(opdb "
const {db}=require('/app/server/db/database');
const d=db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get('$DEV');
const r=d && db.prepare('SELECT sub_order FROM playlist_items WHERE playlist_id = ? AND sub_playlist_id = ?').get(d.playlist_id, '$LISTA');
console.log(r ? (r.sub_order || '') : '');
")
[ "$ORDEM" = "sequence" ] && ok "sub_order = sequence" \
  || nok "sub_order veio '$ORDEM' -- vazio cai em sequencial sem ninguem ter escolhido"

echo
echo "=== COM PLANO FREE ==="
limpar
plano_escrever free
S_FREE=$(entrar "$EMAIL" "$SENHA")

echo "--- 4. um ARQUIVO continua entrando (o caminho curto nao e o que se vende) ---"
ARQ=$(opdb "
const {db}=require('/app/server/db/database');
const c=db.prepare('SELECT id FROM content WHERE workspace_id = ? LIMIT 1').get('$WS');
console.log(c ? c.id : '');
")
if [ -z "$ARQ" ]; then
  echo "  (nao ha arquivo neste workspace -- caso nao aplicavel)"
else
  COD=$(curl -s -o /tmp/_arq.json -w '%{http_code}' -X POST "$OP/api/assignments/device/$DEV" \
    -H "Authorization: Bearer $S_FREE" -H 'Content-Type: application/json' \
    -d "{\"content_id\":\"$ARQ\"}")
  case "$COD" in
    201|409) ok "arquivo aceito no Free ($COD)" ;;
    *)       nok "o Free perdeu o direito de por um arquivo na tela: $COD" ;;
  esac
  # Tira o que acabou de entrar.
  opdb "
const {db}=require('/app/server/db/database');
const d=db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get('$DEV');
if (d && d.playlist_id) db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND content_id = ?').run(d.playlist_id, '$ARQ');
" >/dev/null
fi

echo "--- 5. mas uma LISTA e recusada, e a recusa diz o motivo ---"
COD=$(por_lista "$S_FREE")
if [ "$COD" = "403" ] && grep -q FEATURE_LOCKED /tmp/_lst.json; then
  ok "403 FEATURE_LOCKED: $(sed -E 's/.*\"error\":\"([^\"]*)\".*/\1/' /tmp/_lst.json | head -c 70)"
else
  nok "esperava 403 FEATURE_LOCKED, veio $COD: $(head -c 160 /tmp/_lst.json)"
fi

echo "--- 6. e a mensagem esta em portugues e nomeia um plano que EXISTE ---"
# Era "Playlist sub-lists requires the Premium plan or above": em ingles depois de o produto
# ficar so em portugues, falando de um conceito que ninguem precisa aprender, e citando um
# plano PREMIUM que nao esta a venda.
MSG=$(sed -E 's/.*"error":"([^"]*)".*/\1/' /tmp/_lst.json)
case "$MSG" in
  *Premium*|*requires*) nok "a mensagem antiga voltou: $MSG" ;;
  *Pró*|*Pro*)          ok "\"$MSG\"" ;;
  *)                    nok "mensagem inesperada: $MSG" ;;
esac

echo "--- 7. A OUTRA PORTA tambem esta trancada ---"
# Sem isto, o Free adiciona a lista pela pagina de listas e o cadeado da tela nao vale nada.
OUTRA=$(opdb "
const {db}=require('/app/server/db/database');
const r=db.prepare('SELECT id FROM playlists WHERE workspace_id = ? AND id <> ? LIMIT 1').get('$WS', '$LISTA');
console.log(r ? r.id : '');
")
if [ -z "$OUTRA" ]; then
  echo "  (so ha uma lista neste workspace -- nao da para testar a outra porta)"
else
  COD=$(curl -s -o /tmp/_prt.json -w '%{http_code}' -X POST "$OP/api/playlists/$OUTRA/items" \
    -H "Authorization: Bearer $S_FREE" -H 'Content-Type: application/json' \
    -d "{\"sub_playlist_id\":\"$LISTA\"}")
  [ "$COD" = "403" ] && ok "a pagina de listas recusa igual (403)" \
    || nok "a outra porta aceitou com $COD -- a trava e contornavel"
fi

echo
echo "=== DEVOLVER O PLANO E PARTE DA PROVA ==="
limpar
plano_escrever "$PLANO_ANTES"
DEPOIS=$(plano_ler)
if [ "$DEPOIS" = "$PLANO_ANTES" ]; then
  ok "plano devolvido para '$PLANO_ANTES'"
else
  nok "NAO DEVOLVI O PLANO: era '$PLANO_ANTES', ficou '$DEPOIS' -- conserte antes de seguir"
fi

echo
[ "$falhas" = "0" ] && echo "A TELA ACEITA LISTA, E SO QUEM PAGA" || echo "$falhas CASO(S) FALHARAM"
exit $falhas
