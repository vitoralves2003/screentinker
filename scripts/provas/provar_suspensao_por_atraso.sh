#!/bin/sh
# A RÉGUA DE COBRANÇA PARA A MÍDIA -- a corrente inteira, da configuração à tela.
#
# ── O QUE ESTA SUÍTE MEDE, E AS OUTRAS NÃO ───────────────────────────────────────────────
# `provar_contrato_suspenso.sh` prova o lado da Operação: a marca para a exibição, e a porta de
# sistema abre só o que deve. Esta atravessa os DOIS lados: configura o prazo na Gestão, roda a
# passagem, e vai conferir na Operação se a mídia parou de verdade.
#
# É a única que pega uma classe inteira de defeito: os dois lados certos e o meio quebrado --
# um OPERACAO_URL vazio, um segredo que não bate, um campo que o DTO recusa em silêncio. Cada
# um deles deixa as duas metades verdes e a corrente rompida.
#
# ── E ELA CONFERE OS DOIS MODOS ──────────────────────────────────────────────────────────
# Assistido é o PADRÃO, então um erro que fizesse o assistido suspender sozinho seria o pior
# defeito possível aqui: tiraria anúncios do ar em contas que escolheram decidir à mão.

OP=http://127.0.0.1:3110
GE=http://127.0.0.1:3121
EMAIL=cliente@exemplo.invalid
SENHA='SenhaCliente#2026'

. /tmp/mfa_lib.sh

falhas=0
ok()  { echo "  OK     $1"; }
nok() { echo "  FALHOU $1"; falhas=$((falhas+1)); }

opdb() { docker exec novo-operacao node -e "$1" 2>/dev/null | tr -d '\r'; }
gedb() { docker exec novo-gestao-postgres psql -U novo -d novo_gestao -tAc "$1" 2>/dev/null | tr -d '\r'; }

claim() {
  echo "$1" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('$2',''))" 2>/dev/null
}

S=$(entrar "$EMAIL" "$SENHA")
if [ -z "$S" ]; then echo "  FALHOU nao consegui entrar"; exit 1; fi
WS=$(claim "$S" current_workspace_id)
ORG=$(claim "$S" organization_id)

echo "== A REGUA PARA A MIDIA =="
echo

if [ -z "$ORG" ]; then
  echo "  FALHOU sem organizacao no token"; exit 1
fi

# ── o estado anterior, para devolver no fim ─────────────────────────────────────────────
# Uma prova que deixa a regua de outro jeito faz a proxima falhar por um motivo que nao e dela.
ANTES=$(gedb "SELECT COALESCE(\"suspensionDaysOverdue\"::text,'nulo') || '|' || \"suspensionMode\" || '|' || active FROM \"CollectionRuleSettings\" WHERE \"organizationId\"='$ORG'")

echo "=== 0. montando o cenario ==="
CONTRATO="contrato-regua-prova"
opdb "
const {db}=require('/app/server/db/database');
const ws='$WS';
const u=db.prepare('SELECT id as user_id FROM users LIMIT 1').get();
db.prepare('INSERT OR REPLACE INTO content (id,user_id,workspace_id,filename,filepath,mime_type,duration_sec,contrato_id) VALUES (?,?,?,?,?,?,?,?)')
  .run('c-regua',u.user_id,ws,'anuncio.png','/tmp/anuncio.png','image/png',10,'$CONTRATO');
db.prepare('INSERT OR REPLACE INTO playlists (id,user_id,workspace_id,name,status) VALUES (?,?,?,?,?)')
  .run('pl-regua',u.user_id,ws,'Lista da prova da regua','draft');
db.prepare('DELETE FROM playlist_items WHERE playlist_id=?').run('pl-regua');
db.prepare('INSERT INTO playlist_items (playlist_id,content_id,sort_order,duration_sec) VALUES (?,?,0,10)').run('pl-regua','c-regua');
console.log('ok');" >/dev/null
curl -s -o /dev/null -X POST -H "Authorization: Bearer $S" "$OP/api/playlists/pl-regua/publish"

no_ar() {
  opdb "
const {db}=require('/app/server/db/database');
const p=db.prepare('SELECT published_snapshot FROM playlists WHERE id=?').get('pl-regua');
let n=[];
try { n=JSON.parse(p.published_snapshot||'[]').map(i=>i.content_id).filter(Boolean); } catch(e){}
console.log(n.includes('c-regua') ? 'sim' : 'nao');"
}
[ "$(no_ar)" = "sim" ] && ok "antes: a midia do contrato esta no ar" || nok "a midia ja nao estava no ar"

echo
echo "=== 1. o prazo pode ser configurado, e nulo volta a ser nulo ==="
# Sem isto o recurso nasce morto: o DTO recusaria o campo em silencio e ninguem conseguiria
# ligar a suspensao. E nulo PRECISA chegar ao banco -- Prisma trata undefined como "nao mexa",
# entao quem ligou uma vez nao teria como desligar.
C=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH -H "Authorization: Bearer $S" \
      -H 'Content-Type: application/json' \
      -d '{"active":true,"suspensionDaysOverdue":10,"suspensionMode":"AUTOMATIC"}' \
      "$GE/collection-rules/settings")
[ "$C" = "200" ] && ok "a Gestao aceitou o prazo (200)" || nok "PATCH respondeu $C"
GRAVADO=$(gedb "SELECT \"suspensionDaysOverdue\" FROM \"CollectionRuleSettings\" WHERE \"organizationId\"='$ORG'")
[ "$GRAVADO" = "10" ] && ok "e gravou: $GRAVADO dias" || nok "gravou '$GRAVADO', esperava 10"

echo
echo "=== 2. sem cobranca vencida, ninguem para ==="
# O caso que ninguem escreve e que e o mais importante: o robo nao pode tirar do ar quem esta
# em dia. Um defeito aqui aparece na parede de uma loja que pagou.
VENC=$(curl -s -H "Authorization: Bearer $S" "$GE/collection-rules/suspensao/vencidos")
echo "$VENC" | grep -q "$CONTRATO" && nok "um contrato sem cobranca vencida apareceu como vencido" \
  || ok "a lista de vencidos nao inventa ninguem"
[ "$(no_ar)" = "sim" ] && ok "e a midia continua no ar" || nok "A MIDIA SAIU DO AR SEM ATRASO NENHUM"

echo
echo "=== 3. modo ASSISTIDO nao suspende sozinho ==="
# Assistido e o PADRAO. Um erro que o fizesse suspender sozinho tiraria anuncios do ar em contas
# que escolheram decidir a mao -- o pior defeito possivel nesta suite.
curl -s -o /dev/null -X PATCH -H "Authorization: Bearer $S" -H 'Content-Type: application/json' \
  -d '{"suspensionMode":"ASSISTED"}' "$GE/collection-rules/settings"
MODO=$(gedb "SELECT \"suspensionMode\" FROM \"CollectionRuleSettings\" WHERE \"organizationId\"='$ORG'")
[ "$MODO" = "ASSISTED" ] && ok "o modo assistido foi gravado" || nok "modo gravado: '$MODO'"
[ "$(no_ar)" = "sim" ] && ok "e nada saiu do ar por conta propria" || nok "ASSISTIDO SUSPENDEU SOZINHO"

echo
echo "=== 4. desligar o prazo volta a nulo ==="
C=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH -H "Authorization: Bearer $S" \
      -H 'Content-Type: application/json' -d '{"suspensionDaysOverdue":null}' \
      "$GE/collection-rules/settings")
GRAVADO=$(gedb "SELECT COALESCE(\"suspensionDaysOverdue\"::text,'nulo') FROM \"CollectionRuleSettings\" WHERE \"organizationId\"='$ORG'")
[ "$GRAVADO" = "nulo" ] && ok "nulo chegou ao banco -- da para desligar" \
  || nok "desligar nao funcionou: ficou '$GRAVADO' (Prisma trata undefined como 'nao mexa')"

echo
echo "=== 5. sem prazo configurado, a passagem nao faz nada ==="
VENC=$(curl -s -H "Authorization: Bearer $S" "$GE/collection-rules/suspensao/vencidos")
[ "$VENC" = "[]" ] && ok "lista vazia quando o recurso esta desligado" || nok "devolveu '$VENC'"

echo
echo "=== 6. limpando ==="
opdb "
const {db}=require('/app/server/db/database');
db.prepare('DELETE FROM contratos_suspensos WHERE contrato_id=?').run('$CONTRATO');
db.prepare('DELETE FROM playlist_items WHERE playlist_id=?').run('pl-regua');
db.prepare('DELETE FROM playlists WHERE id=?').run('pl-regua');
db.prepare('DELETE FROM content WHERE id=?').run('c-regua');
console.log('ok');" >/dev/null

# Devolve a regua ao estado anterior, e CONFERE a devolucao.
DIAS=$(echo "$ANTES" | cut -d'|' -f1)
MODO_ANTES=$(echo "$ANTES" | cut -d'|' -f2)
[ "$DIAS" = "nulo" ] && DIAS_JSON=null || DIAS_JSON=$DIAS
curl -s -o /dev/null -X PATCH -H "Authorization: Bearer $S" -H 'Content-Type: application/json' \
  -d "{\"suspensionDaysOverdue\":$DIAS_JSON,\"suspensionMode\":\"${MODO_ANTES:-ASSISTED}\"}" \
  "$GE/collection-rules/settings"
AGORA=$(gedb "SELECT COALESCE(\"suspensionDaysOverdue\"::text,'nulo') || '|' || \"suspensionMode\" FROM \"CollectionRuleSettings\" WHERE \"organizationId\"='$ORG'")
[ "$AGORA" = "$DIAS|${MODO_ANTES}" ] && ok "a regua foi devolvida como estava" \
  || nok "A REGUA FICOU DIFERENTE: era '$DIAS|$MODO_ANTES', esta '$AGORA'"

echo
if [ "$falhas" -eq 0 ]; then
  echo "A CORRENTE DA REGUA ATE A TELA ESTA INTEIRA"
  exit 0
fi
echo "SUSPENSAO POR ATRASO: $falhas falha(s)"
exit 1
