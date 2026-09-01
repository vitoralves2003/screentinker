#!/bin/sh
# O LIMITE DE MIDIAS DO CONTRATO -- da Gestao ate a recusa do upload.
#
# ── O QUE SO ESTA SUITE PEGA ────────────────────────────────────────────────────────────
# Os testes da Gestao provam a REGRA (quem edita o quê, o que congela). Os do servidor provam a
# CONTAGEM e a clausula. Nenhum dos dois toca no meio: o empurrao pode nao sair, o corpo pode ser
# recusado em silencio, o espelho pode ficar com o numero velho. Cada um deixa as duas metades
# verdes e o assinante vendo upload recusado por um limite que ele ja mudou.
#
# ── E ELA MEDE A DIRECAO CERTA DA FALHA ─────────────────────────────────────────────────
# Contrato sem limite tem de deixar passar. Falhar fechado pararia todos os 65 contratos que a
# Operacao ainda nao conhece -- e o estrago apareceria na parede de uma loja, nao num log.

OP=http://127.0.0.1:3110
EMAIL=cliente@exemplo.invalid
SENHA='SenhaCliente#2026'
CONTRATO="contrato-limite-prova"

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
ORG=$(claim "$S" organization_id)
if [ -z "$ORG" ]; then echo "  FALHOU sem organizacao no token"; exit 1; fi

echo "== O LIMITE DE MIDIAS =="
echo

limpar() {
  opdb "
const {db}=require('/app/server/db/database');
db.prepare('DELETE FROM contratos_limites WHERE contrato_id=?').run('$CONTRATO');
db.prepare(\"DELETE FROM content WHERE id LIKE 'lim-prova-%'\").run();
console.log('ok');" >/dev/null
}
limpar

# Tres arquivos sem contrato, para irem entrando um a um.
opdb "
const {db}=require('/app/server/db/database');
const u=db.prepare('SELECT id FROM users LIMIT 1').get();
for (const n of [1,2,3]) {
  db.prepare('INSERT OR REPLACE INTO content (id,user_id,workspace_id,filename,filepath,mime_type,is_active) VALUES (?,?,?,?,?,?,1)')
    .run('lim-prova-'+n, u.id, '$WS', 'peca-'+n+'.png', '/tmp/p.png', 'image/png');
}
console.log('ok');" >/dev/null

marcar() {
  curl -s -o /dev/null -w '%{http_code}' -X PUT \
    -H "Authorization: Bearer $S" -H 'Content-Type: application/json' \
    -d "{\"contrato_id\":\"$CONTRATO\"}" "$OP/api/content/$1"
}

echo "=== 1. sem limite conhecido, tudo passa (falha ABERTO) ==="
# Os 65 contratos de hoje estao exatamente assim: a Operacao nunca ouviu falar deles.
C1=$(marcar lim-prova-1)
if [ "$C1" = "200" ]; then
  ok "contrato sem limite nao recusa nada"
else
  nok "recusou com $C1 um contrato que nao tem limite -- falhou FECHADO"
fi

echo
echo "=== 2. a Gestao empurra o limite, e a Operacao recebe ==="
EMPURRAO=$(docker exec novo-gestao-api node -e "
const jwt = require('jsonwebtoken');
const agora = Math.floor(Date.now() / 1000);
const base = (process.env.OPERACAO_URL || '').replace(/\/+\$/, '');
if (!base || !process.env.OPERACAO_JWT_SECRET) { console.log('SEM_CONFIGURACAO'); process.exit(0); }
const token = jwt.sign({ sistema: 'gestao', organization_id: '$ORG', iat: agora, exp: agora + 120 },
  process.env.OPERACAO_JWT_SECRET, { algorithm: 'HS256' });
fetch(base + '/api/sistema/contratos/$CONTRATO/limites', {
  method: 'PUT',
  headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ max_midias: 2, max_segundos: 15 }),
}).then(async (r) => console.log(r.status + ' ' + (await r.text())))
  .catch((e) => console.log('ERRO ' + e.message));
" 2>/dev/null | tr -d '\r')

case "$EMPURRAO" in
  SEM_CONFIGURACAO*) nok "a Gestao nao tem como falar com a Operacao -- corrente rompida no meio" ;;
  ERRO*)             nok "a Gestao nao alcancou a Operacao: $EMPURRAO" ;;
  200*)              ok  "a Operacao aceitou o limite vindo da Gestao" ;;
  *)                 nok "resposta inesperada: $(echo "$EMPURRAO" | cut -c1-100)" ;;
esac

GRAVADO=$(opdb "
const {db}=require('/app/server/db/database');
const l=db.prepare('SELECT max_midias,max_segundos FROM contratos_limites WHERE contrato_id=?').get('$CONTRATO');
console.log(l ? l.max_midias+'|'+l.max_segundos : 'NAO_EXISTE');")
if [ "$GRAVADO" = "2|15" ]; then
  ok "e gravou os dois numeros"
else
  nok "o espelho ficou com: $GRAVADO"
fi

echo
echo "=== 3. a trava morde na N+1 ==="
# Ja ha 1 no contrato (o do passo 1). O segundo cabe; o terceiro nao.
C2=$(marcar lim-prova-2)
if [ "$C2" = "200" ]; then ok "a segunda cabe no limite de 2"; else nok "a segunda foi recusada com $C2"; fi

C3=$(marcar lim-prova-3)
if [ "$C3" = "409" ]; then
  ok "a TERCEIRA e recusada com 409"
else
  nok "a terceira passou (ou errou o codigo): $C3"
fi

# A recusa tem de dizer o numero e onde mudar -- "limite atingido" sozinho manda a pessoa
# procurar um limite que mora noutro sistema.
CORPO=$(curl -s -X PUT -H "Authorization: Bearer $S" -H 'Content-Type: application/json' \
  -d "{\"contrato_id\":\"$CONTRATO\"}" "$OP/api/content/lim-prova-3")
case "$CORPO" in
  *"aba Mídias do contrato"*) ok "a recusa diz onde mudar o limite" ;;
  *)                          nok "a recusa nao orienta: $(echo "$CORPO" | cut -c1-100)" ;;
esac
case "$CORPO" in
  *limite_de_midias*) ok "e traz o codigo, para a tela reagir sem ler texto" ;;
  *)                  nok "sem codigo na recusa" ;;
esac

echo
echo "=== 4. desativar uma abre vaga (simultaneas, nao uploads) ==="
# A regra que o Vitor destacou: substituir vale. Se a contagem fosse de uploads, trocar a peca de
# setembro pela de outubro seria recusado por causa de um arquivo que ninguem mais ve.
opdb "
const {db}=require('/app/server/db/database');
db.prepare('UPDATE content SET is_active=0 WHERE id=?').run('lim-prova-1');
console.log('ok');" >/dev/null

C3B=$(marcar lim-prova-3)
if [ "$C3B" = "200" ]; then
  ok "com uma desativada, a terceira entra"
else
  nok "a vaga nao abriu: $C3B"
fi

echo
echo "=== 5. limpar o limite na Gestao libera de novo ==="
# Nulo e um VALOR, nao silencio: se ausencia significasse "deixe como esta", um limite removido
# continuaria valendo aqui para sempre.
docker exec novo-gestao-api node -e "
const jwt = require('jsonwebtoken');
const agora = Math.floor(Date.now() / 1000);
const base = (process.env.OPERACAO_URL || '').replace(/\/+\$/, '');
const token = jwt.sign({ sistema: 'gestao', organization_id: '$ORG', iat: agora, exp: agora + 120 },
  process.env.OPERACAO_JWT_SECRET, { algorithm: 'HS256' });
fetch(base + '/api/sistema/contratos/$CONTRATO/limites', {
  method: 'PUT',
  headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ max_midias: null, max_segundos: null }),
}).then((r) => console.log(r.status)).catch(() => console.log('ERRO'));
" >/dev/null 2>&1

SOBROU=$(opdb "
const {db}=require('/app/server/db/database');
console.log(db.prepare('SELECT COUNT(*) c FROM contratos_limites WHERE contrato_id=?').get('$CONTRATO').c);")
if [ "$SOBROU" = "0" ]; then
  ok "a linha saiu -- nulo removeu o limite, e nao foi ignorado"
else
  nok "a linha ficou ($SOBROU) -- um limite removido continuaria valendo aqui"
fi

opdb "
const {db}=require('/app/server/db/database');
db.prepare('UPDATE content SET is_active=1 WHERE id=?').run('lim-prova-1');
console.log('ok');" >/dev/null
C1B=$(marcar lim-prova-1)
if [ "$C1B" = "200" ]; then ok "e as tres cabem de novo"; else nok "ainda recusa: $C1B"; fi

limpar

echo
if [ "$falhas" -eq 0 ]; then
  echo "TUDO PASSOU"
else
  echo "$falhas FALHARAM"
fi
exit $falhas
