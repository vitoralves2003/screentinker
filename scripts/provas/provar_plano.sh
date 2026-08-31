#!/bin/sh
# Prova do portao do plano: a Gestao e um direito comprado, nao um efeito de ter conta.
#
# Percorre os quatro planos com o MESMO usuario, trocando so o plano do workspace. Se o portao
# dependesse de qualquer outra coisa -- papel, organizacao, sorte -- os quatro responderiam
# igual.
#
# ── O PORTAO MUDOU DE LUGAR, E ESTA SUITE MUDOU COM ELE ──────────────────────────────────
# Ele vivia em POST /api/auth/federation/gestao: a unica forma de chegar na Gestao era pedir um
# token de troca de 60 segundos, e aquela rota conferia o plano antes de assinar. Esta prova
# batia la.
#
# Com a sessao unica aquela rota deixou de existir. A decisao continua sendo da Operacao, que e
# onde plano e cobranca moram -- ela viaja no token, no campo gestao_enabled -- mas quem RECUSA
# agora e o guarda da Gestao, que e onde ficou a porta.
#
# Entao a prova passou a bater na porta nova: uma rota real da Gestao, com a sessao da Operacao.
# Bater no lugar antigo daria 404 nos quatro planos, e quatro 404 iguais pareceriam quatro
# recusas -- uma suite verde provando que o portao funciona depois de ele ter sumido.
#
# ── POR QUE ELA ENTRA DE NOVO A CADA PLANO ───────────────────────────────────────────────
# gestao_enabled nasce COM o token. Trocar o plano nao mexe num token ja emitido, e reusar a
# mesma sessao mediria o plano de quando ela foi criada -- os quatro passariam.

OP=http://127.0.0.1:3110
GE=http://127.0.0.1:3121
EMAIL=cliente@exemplo.invalid
SENHA='SenhaCliente#2026'

. /tmp/mfa_lib.sh

falhas=0
ok()  { echo "  OK     $1"; }
nok() { echo "  FALHOU $1"; falhas=$((falhas+1)); }

opdb() { docker exec novo-operacao node -e "$1" 2>/dev/null | tr -d '\r'; }

WS=$(opdb "
const {db}=require('/app/server/db/database');
const r=db.prepare('SELECT w.id FROM workspaces w JOIN users u ON u.id=w.created_by WHERE u.email = ?').get('$EMAIL');
console.log(r ? r.id : '');
")

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

if [ -z "$WS" ]; then
  echo "  FALHOU nao achei o workspace de $EMAIL"
  exit 1
fi

ORIGINAL=$(plano_ler)

if [ -z "$ORIGINAL" ]; then
  echo "  FALHOU nao consegui ler o plano atual -- nao mexo no que nao sei devolver"
  exit 1
fi

# Troca o plano, entra de novo e devolve o codigo da API da Gestao junto do que o token disse.
por_plano() {
  plano_escrever "$1"
  S=$(entrar "$EMAIL" "$SENHA")
  CLAIM=$(echo "$S" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('gestao_enabled',''))" 2>/dev/null)
  COD=$(curl -s -o /tmp/plano.json -w '%{http_code}' "$GE/clients" -H "Authorization: Bearer $S")
  echo "$COD $CLAIM"
}

echo "=== os quatro planos, mesmo usuario ==="

set -- "free 403 False" "pro 403 False" "master 200 True" "gestao 200 True"
for caso in "$@"; do
  nome=$(echo "$caso" | cut -d' ' -f1)
  esperado=$(echo "$caso" | cut -d' ' -f2)
  claim_esperado=$(echo "$caso" | cut -d' ' -f3)
  r=$(por_plano "$nome")
  cod=$(echo "$r" | cut -d' ' -f1)
  claim=$(echo "$r" | cut -d' ' -f2)

  if [ "$cod" = "$esperado" ] && [ "$claim" = "$claim_esperado" ]; then
    ok "$nome -> token diz $claim, API responde $cod"
  else
    nok "$nome -> esperava $esperado/$claim_esperado, veio $cod/$claim"
  fi
done

echo
echo "=== a recusa e do SERVIDOR, nao da tela ==="
# Esconder o item do menu nunca foi a trava. Este caso chama a rota direto, sem passar por
# tela nenhuma, com uma sessao valida de um plano que nao comprou a Gestao.
por_plano pro >/dev/null
S=$(entrar "$EMAIL" "$SENHA")
COD=$(curl -s -o /tmp/plano.json -w '%{http_code}' "$GE/contracts" -H "Authorization: Bearer $S")
[ "$COD" = "403" ] && ok "chamar a rota direto tambem e barrado (403)" || nok "a rota direta passou: $COD"

echo "=== e a mensagem diz o motivo, nao um erro generico ==="
if grep -qi "plano" /tmp/plano.json; then
  ok "$(head -c 90 /tmp/plano.json)"
else
  nok "a mensagem nao explica: $(head -c 120 /tmp/plano.json)"
fi

echo
echo "=== devolver o plano faz parte da prova ==="
# Uma prova que estraga o ambiente e pior que uma prova que falha: a proxima pessoa herda o
# estrago sem saber de onde veio. Ja aconteceu aqui -- um restore que falhou calado deixou
# esta conta no plano free, e a suite seguinte quebrou por causa disso.
plano_escrever "$ORIGINAL"
DEPOIS=$(plano_ler)
if [ "$DEPOIS" = "$ORIGINAL" ]; then
  ok "plano devolvido para '$ORIGINAL'"
else
  nok "NAO DEVOLVI O PLANO: era '$ORIGINAL', ficou '$DEPOIS' -- conserte antes de seguir"
fi

echo
[ "$falhas" = "0" ] && echo "O PORTAO DO PLANO FECHA E ABRE NOS QUATRO" || echo "$falhas CASO(S) FALHARAM"
exit $falhas
