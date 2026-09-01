#!/bin/sh
# A LISTA DO CONTRATO -- nasce na ativação, é uma só, e não se confunde com as outras.
#
# ── POR QUE ELA SAI DA GESTÃO, E NÃO DAQUI ──────────────────────────────────────────────
# Os testes de unidade da Gestão provam a DECISÃO (quem ganha lista, com que nome) e os do
# servidor provam o ESQUEMA. Nenhum dos dois toca no meio: um OPERACAO_URL vazio, um segredo que
# não bate, um corpo que a rota recusa em silêncio. Cada um desses deixa as duas metades verdes e
# a corrente rompida -- foi por isso que provar_suspensao_por_atraso.sh existiu, e é por isso que
# esta cunha o token DENTRO do contêiner da Gestão, com o segredo e a URL que ELE tem, em vez de
# fabricar um do lado de cá que só provaria que eu sei assinar um JWT.
#
# ── E O QUE ELA MEDE DEPOIS ─────────────────────────────────────────────────────────────
# Idempotência, porque quem chama é um sistema e sistema repete: uma retentativa, um webhook de
# assinatura em duplicata, um contrato reativado. E a INVISIBILIDADE: a lista do contrato não
# pertence à página de Playlists nem ao seletor de destino, e um vazamento ali é sutil -- uma
# lista a mais numa página, que ninguém liga a um contrato assinado semanas antes.

OP=http://127.0.0.1:3110
EMAIL=cliente@exemplo.invalid
SENHA='SenhaCliente#2026'
CONTRATO="contrato-lista-prova"

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

echo "== A LISTA DO CONTRATO =="
echo

# ── limpeza da passagem anterior ────────────────────────────────────────────────────────
# Wholesale no contrato DESTA prova, e só nele: apagar por contrato_id inteiro levaria a lista de
# um contrato real junto (a lição de provar_suspensao_por_atraso.sh, que suspendeu a Móveis
# Abrantes por limpar demais).
limpar() {
  opdb "
const {db}=require('/app/server/db/database');
db.prepare('DELETE FROM playlists WHERE contrato_id=?').run('$CONTRATO');
console.log('ok');" >/dev/null
}
limpar

# ── a chamada, cunhada e disparada de DENTRO da Gestão ───────────────────────────────────
# Mesma cunhagem de PortaDeSistemaService: claim `sistema`, organização, e nada mais. O alcance
# quem decide é o outro lado, a partir da organização.
pedir_lista() {
  docker exec novo-gestao-api node -e "
const jwt = require('jsonwebtoken');
const agora = Math.floor(Date.now() / 1000);
const base = (process.env.OPERACAO_URL || '').replace(/\/+\$/, '');
if (!base || !process.env.OPERACAO_JWT_SECRET) {
  console.log('SEM_CONFIGURACAO'); process.exit(0);
}
const token = jwt.sign(
  { sistema: 'gestao', organization_id: '$ORG', iat: agora, exp: agora + 120 },
  process.env.OPERACAO_JWT_SECRET, { algorithm: 'HS256' });
fetch(base + '/api/sistema/contratos/$CONTRATO/lista', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ rotulo: '$1' }),
}).then(async (r) => {
  const t = await r.text();
  console.log(r.status + ' ' + t);
}).catch((e) => console.log('ERRO ' + e.message));
" 2>/dev/null | tr -d '\r'
}

echo "=== 1. a corrente inteira: Gestao cunha, Operacao cria ==="
R1=$(pedir_lista 'Padaria Central — Mídia Indoor · #1042')
case "$R1" in
  SEM_CONFIGURACAO*) nok "a Gestao nao tem OPERACAO_URL/OPERACAO_JWT_SECRET -- a corrente esta rompida no meio" ;;
  ERRO*)             nok "a Gestao nao alcancou a Operacao: $R1" ;;
  201*)              ok  "a Operacao criou a lista a pedido da Gestao" ;;
  *)                 nok "resposta inesperada: $(echo "$R1" | cut -c1-120)" ;;
esac

ID1=$(echo "$R1" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
if [ -n "$ID1" ]; then ok "a resposta traz o id da lista"; else nok "resposta sem id"; fi

echo
echo "=== 2. nasce publicada, e com o rotulo que a Gestao mandou ==="
# Uma lista que nascesse rascunho nao exibiria nada ao ser posta numa tela -- o mesmo defeito que
# a copia de playlist tinha, e o sintoma seria "coloquei a lista do contrato e a tela ficou preta".
EST=$(opdb "
const {db}=require('/app/server/db/database');
const p=db.prepare('SELECT status,name,workspace_id,is_auto_generated FROM playlists WHERE contrato_id=?').get('$CONTRATO');
console.log(p ? [p.status,p.name,p.workspace_id===('$WS')?'ws-certo':'WS-ERRADO',p.is_auto_generated].join('|') : 'NAO_EXISTE');")

case "$EST" in
  published*) ok "nasce publicada" ;;
  *)          nok "status inesperado: $EST" ;;
esac
case "$EST" in
  *"Padaria Central"*) ok "guarda o rotulo de emergencia que a Gestao mandou" ;;
  *)                   nok "o rotulo nao chegou: $EST" ;;
esac
case "$EST" in
  *ws-certo*) ok "no workspace da organizacao (resolvido do lado de ca, nao pelo corpo)" ;;
  *)          nok "workspace errado: $EST" ;;
esac
# is_auto_generated e OUTRA coisa: o espaco proprio de UMA tela. Se a lista do contrato o
# herdasse, ela sumiria de lugares onde deve estar e apareceria onde nao deve.
case "$EST" in
  *"|0") ok "NAO e marcada como espaco de tela -- sao coisas diferentes" ;;
  *)     nok "veio marcada como automatica: $EST" ;;
esac

echo
echo "=== 3. idempotente: sistema repete ==="
R2=$(pedir_lista 'Padaria Central — Mídia Indoor · #1042')
ID2=$(echo "$R2" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
if [ -n "$ID1" ] && [ "$ID1" = "$ID2" ]; then
  ok "a segunda chamada devolve a MESMA lista"
else
  nok "a segunda chamada devolveu outra coisa (id1=$ID1 id2=$ID2)"
fi
case "$R2" in
  *'"criada":false'*) ok "e diz que nao criou nada" ;;
  *)                  nok "nao avisou que ja existia" ;;
esac

QUANTAS=$(opdb "
const {db}=require('/app/server/db/database');
console.log(db.prepare('SELECT COUNT(*) c FROM playlists WHERE contrato_id=?').get('$CONTRATO').c);")
if [ "$QUANTAS" = "1" ]; then
  ok "existe UMA lista para o contrato"
else
  nok "existem $QUANTAS listas para o mesmo contrato"
fi

echo
echo "=== 4. invisivel onde nao pertence ==="
# A pagina de Playlists e a biblioteca do que se reaproveita. A lista do contrato pertence
# aquele contrato -- aparecer ali e uma lista a mais que ninguem liga a um contrato.
LISTAS=$(curl -s -H "Authorization: Bearer $S" "$OP/api/playlists")
if echo "$LISTAS" | grep -q "$ID1"; then
  nok "a lista do contrato aparece na resposta de /api/playlists"
else
  ok "a API de playlists nao a devolve"
fi

# E o corte do navegador, que e o que o assinante ve nas duas telas.
for ARQ in views/playlists.js components/enviar-para-modal.js; do
  CORPO=$(curl -s "$OP/js/$ARQ")
  if echo "$CORPO" | grep -q '!p.is_auto_generated && !p.contrato_id'; then
    ok "$ARQ corta as duas (espaco de tela e lista de contrato)"
  else
    nok "$ARQ nao corta a lista de contrato"
  fi
done

echo
echo "=== 5. a porta de sistema continua fechada para quem nao e sistema ==="
# O token do navegador nao pode abrir a porta de sistema: se abrisse, qualquer sessao criaria
# listas em nome da Gestao.
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $S" \
  "$OP/api/sistema/contratos/$CONTRATO/lista")
if [ "$CODE" = "401" ] || [ "$CODE" = "403" ]; then
  ok "token de navegador na porta de sistema: $CODE"
else
  nok "a porta de sistema aceitou um token de navegador ($CODE)"
fi

limpar

echo
if [ "$falhas" -eq 0 ]; then
  echo "TUDO PASSOU"
else
  echo "$falhas FALHARAM"
fi
exit $falhas
