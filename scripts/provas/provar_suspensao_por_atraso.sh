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
echo "=== 5b. O CASO DECISIVO: cobranca vencida de verdade, midia parando ==="
# Ate aqui a suite media tudo menos o principal -- a conta de teste nao tem cobranca nenhuma,
# entao o caminho automatico nunca chegava a suspender. Verde sem o caso decisivo manda procurar
# no lugar errado, e esta sessao inteira foi sobre isso.
#
# Roda na organizacao que TEM contratos. Cria uma cobranca vencida PROPRIA e a apaga no fim:
# mexer numa cobranca que ja existe seria mais dificil de desfazer com seguranca.
ORG_DADOS=$(gedb "SELECT \"organizationId\" FROM \"Contract\" WHERE status='ACTIVE' GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1")
CONTRATO_REAL=$(gedb "SELECT id FROM \"Contract\" WHERE status='ACTIVE' AND \"organizationId\"='$ORG_DADOS' LIMIT 1")
WS_DADOS=$(opdb "
const {db}=require('/app/server/db/database');
const w=db.prepare('SELECT id FROM workspaces WHERE organization_id=?').get('$ORG_DADOS');
console.log(w ? w.id : '');")

if [ -z "$CONTRATO_REAL" ] || [ -z "$WS_DADOS" ]; then
  nok "sem contrato ATIVO com workspace correspondente -- o caso decisivo NAO foi medido"
else
  # A midia do contrato, na Operacao, numa lista publicada.
  opdb "
const {db}=require('/app/server/db/database');
const u=db.prepare('SELECT id as user_id FROM users LIMIT 1').get();
db.prepare('INSERT OR REPLACE INTO content (id,user_id,workspace_id,filename,filepath,mime_type,duration_sec,contrato_id) VALUES (?,?,?,?,?,?,?,?)')
  .run('c-decisivo',u.user_id,'$WS_DADOS','anuncio-real.png','/tmp/a.png','image/png',10,'$CONTRATO_REAL');
db.prepare('INSERT OR REPLACE INTO playlists (id,user_id,workspace_id,name,status) VALUES (?,?,?,?,?)')
  .run('pl-decisivo',u.user_id,'$WS_DADOS','Prova do caso decisivo','draft');
db.prepare('DELETE FROM playlist_items WHERE playlist_id=?').run('pl-decisivo');
db.prepare('INSERT INTO playlist_items (playlist_id,content_id,sort_order,duration_sec) VALUES (?,?,0,10)').run('pl-decisivo','c-decisivo');
const {publishPlaylist}=require('/app/server/routes/playlists');
publishPlaylist('pl-decisivo', null);
console.log('ok');" >/dev/null

  no_ar_decisivo() {
    opdb "
const {db}=require('/app/server/db/database');
const p=db.prepare('SELECT published_snapshot FROM playlists WHERE id=?').get('pl-decisivo');
let n=[];
try { n=JSON.parse(p.published_snapshot||'[]').map(i=>i.content_id).filter(Boolean); } catch(e){}
console.log(n.includes('c-decisivo') ? 'sim' : 'nao');"
  }
  [ "$(no_ar_decisivo)" = "sim" ] && ok "a midia do contrato real esta no ar" \
    || nok "nao consegui por a midia no ar"

  # Uma cobranca vencida ha 40 dias, criada para esta prova.
  gedb "INSERT INTO \"ContractCharge\" (id,\"organizationId\",\"contractId\",\"dueDate\",amount,status,\"installmentNumber\",\"createdAt\",\"updatedAt\")
        VALUES ('charge-decisivo','$ORG_DADOS','$CONTRATO_REAL', now() - interval '40 days', 100, 'OVERDUE', 999, now(), now())
        ON CONFLICT (id) DO UPDATE SET \"dueDate\" = now() - interval '40 days', status='OVERDUE'" >/dev/null
  CRIADA=$(gedb "SELECT COUNT(*) FROM \"ContractCharge\" WHERE id='charge-decisivo'")
  [ "$CRIADA" = "1" ] && ok "cobranca vencida ha 40 dias criada" || nok "nao consegui criar a cobranca"

  # A regua daquela organizacao: 10 dias, automatico.
  gedb "INSERT INTO \"CollectionRuleSettings\" (id,\"organizationId\",active,mode,\"sendWindowStartHour\",\"sendWindowEndHour\",\"suspensionDaysOverdue\",\"suspensionMode\",\"createdAt\",\"updatedAt\")
        VALUES (gen_random_uuid(),'$ORG_DADOS',true,'ASSISTED',8,20,10,'AUTOMATIC',now(),now())
        ON CONFLICT (\"organizationId\") DO UPDATE SET active=true, \"suspensionDaysOverdue\"=10, \"suspensionMode\"='AUTOMATIC'" >/dev/null

  # E a passagem roda. Chamada por dentro, porque a sessao de teste e de OUTRA organizacao --
  # e nao ha, nem deve haver, uma rota que deixe um cliente rodar a regua de outro.
  RES=$(docker exec novo-gestao-api node -e "
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('/app/dist/app.module');
(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const { SuspensaoPorAtrasoService } = require('/app/dist/collection-rules/suspensao-por-atraso.service');
  const r = await app.get(SuspensaoPorAtrasoService).aplicarParaOrganizacao('$ORG_DADOS');
  console.log(JSON.stringify(r));
  await app.close();
})().catch(e => { console.log('ERRO: ' + e.message); process.exit(1); });
" 2>/dev/null | tail -1 | tr -d '\r')
  echo "  passagem: $RES"
  echo "$RES" | grep -q '"suspensos":1' && ok "a passagem suspendeu 1 contrato" \
    || nok "a passagem nao suspendeu: $RES"

  [ "$(no_ar_decisivo)" = "nao" ] && ok "A MIDIA SAIU DO AR -- a corrente inteira funciona" \
    || nok "A MIDIA CONTINUA NO AR depois de 40 dias de atraso"

  # E VOLTA AO PAGAR. Cobranca quitada, proxima passagem devolve.
  gedb "UPDATE \"ContractCharge\" SET status='PAID' WHERE id='charge-decisivo'" >/dev/null
  RES2=$(docker exec novo-gestao-api node -e "
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('/app/dist/app.module');
(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const { SuspensaoPorAtrasoService } = require('/app/dist/collection-rules/suspensao-por-atraso.service');
  console.log(JSON.stringify(await app.get(SuspensaoPorAtrasoService).aplicarParaOrganizacao('$ORG_DADOS')));
  await app.close();
})().catch(e => { console.log('ERRO: ' + e.message); process.exit(1); });
" 2>/dev/null | tail -1 | tr -d '\r')
  echo "  apos o pagamento: $RES2"
  [ "$(no_ar_decisivo)" = "sim" ] && ok "pago, a midia voltou sozinha" \
    || nok "a midia NAO voltou depois do pagamento: $RES2"

  # Limpa o cenario decisivo.
  gedb "DELETE FROM \"ContractCharge\" WHERE id='charge-decisivo'" >/dev/null
  gedb "UPDATE \"CollectionRuleSettings\" SET \"suspensionDaysOverdue\"=NULL, \"suspensionMode\"='ASSISTED' WHERE \"organizationId\"='$ORG_DADOS'" >/dev/null
  opdb "
const {db}=require('/app/server/db/database');
db.prepare('DELETE FROM contratos_suspensos WHERE contrato_id=?').run('$CONTRATO_REAL');
db.prepare('DELETE FROM playlist_items WHERE playlist_id=?').run('pl-decisivo');
db.prepare('DELETE FROM playlists WHERE id=?').run('pl-decisivo');
db.prepare('DELETE FROM content WHERE id=?').run('c-decisivo');
console.log('ok');" >/dev/null
  SOBROU=$(gedb "SELECT COUNT(*) FROM \"ContractCharge\" WHERE id='charge-decisivo'")
  [ "$SOBROU" = "0" ] && ok "cenario decisivo removido" || nok "sobrou cobranca de prova no banco"
fi

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
