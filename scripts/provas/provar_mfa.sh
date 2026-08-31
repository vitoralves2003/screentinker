#!/bin/sh
# A SEGUNDA ETAPA FOI REMOVIDA — e esta prova mudou de lado por causa disso.
#
# Ela provava um portao: que ele recusava sem o codigo E que ele ABRIA com o codigo certo.
# Metade da suite existia para a segunda metade -- um portao so testado do lado que recusa nao
# esta testado, porque um "return 403" incondicional passaria em todos os casos negativos.
#
# Agora nao ha portao. O que sobra a provar e o OPOSTO: que ele saiu por inteiro, e que nada
# dele ficou meio de pe.
#
# ── POR QUE ESTE ARQUIVO NAO FOI APAGADO ─────────────────────────────────────────────────
# Uma remocao de seguranca que nao deixa prova nenhuma e uma remocao que ninguem percebe se
# voltar pela metade -- uma rota que sobrou, um desvio no login, uma coluna sendo lida. Apagar
# o teste junto com a funcionalidade e como o codigo morto volta a andar.

OP=http://127.0.0.1:3110
EMAIL=cliente@exemplo.invalid
SENHA='SenhaCliente#2026'
REPO=/opt/novo-operacao

falhas=0
ok()  { echo "  OK     $1"; }
nok() { echo "  FALHOU $1"; falhas=$((falhas+1)); }

echo "=== 1. as rotas de segunda etapa nao existem mais ==="
for r in status setup enable disable verify recovery-codes/regenerate; do
  COD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OP/api/auth/totp/$r")
  case "$COD" in
    404) ok "/api/auth/totp/$r -> 404" ;;
    *)   nok "/api/auth/totp/$r ainda responde: $COD" ;;
  esac
done

echo
echo "=== 2. o login termina onde a senha e conferida ==="
#
# ESTE E O CASO QUE IMPORTA. O desvio antigo devolvia {mfa_required, mfa_token} em vez do
# token da sessao. Se ele tivesse ficado, o login pareceria funcionar e nao entregaria sessao
# nenhuma -- e todas as outras nove suites falhariam sem dizer por que.
#
curl -s -X POST "$OP/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$SENHA\"}" > /tmp/_prova_login.json

TEM_TOKEN=$(python3 -c "
import json
try: d=json.load(open('/tmp/_prova_login.json',encoding='utf-8'))
except Exception: print('erro'); raise SystemExit
print('sim' if d.get('token') else 'nao')
" 2>/dev/null)
[ "$TEM_TOKEN" = "sim" ] && ok "o login devolve o token da sessao direto" \
  || nok "o login nao devolveu token: $(head -c 120 /tmp/_prova_login.json)"

PEDE_MFA=$(python3 -c "
import json
try: d=json.load(open('/tmp/_prova_login.json',encoding='utf-8'))
except Exception: print('erro'); raise SystemExit
print('sim' if d.get('mfa_required') or d.get('mfa_token') else 'nao')
" 2>/dev/null)
[ "$PEDE_MFA" = "nao" ] && ok "e nao pede segunda etapa" \
  || nok "o login ainda pede segunda etapa"

echo "--- e a senha errada continua sendo recusada ---"
# A contraprova. Sem ela, "o login devolve token" seria verdade tambem no dia em que ele
# devolvesse token para qualquer um.
COD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OP/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"senha-que-nao-e-a-dele\"}")
[ "$COD" = "401" ] && ok "senha errada recusada (401)" \
  || nok "senha errada respondeu $COD"

echo
echo "=== 3. nada ficou meio de pe no codigo ==="
for f in server/lib/totp.js server/lib/totp-lockout.js; do
  [ -f "$REPO/$f" ] && nok "$f ainda existe" || ok "$f apagado"
done

# O desvio no login, e a exigencia que barrava a travessia para a Gestao.
grep -q 'mfa_required: true' "$REPO/server/routes/auth.js" \
  && nok "o desvio de segunda etapa voltou ao login" \
  || ok "o desvio nao esta mais no login"
grep -q "code: 'MFA_REQUIRED'" "$REPO/server/routes/auth.js" \
  && nok "a exigencia na travessia voltou" \
  || ok "a exigencia na travessia saiu"

echo "--- mas o guarda do token intermediario FICA ---"
#
# Nenhum token destes nasce mais, mas os ja emitidos valem ate expirar -- e um deles e
# meio-autenticado por definicao: a senha foi conferida e o segundo fator nao. Aceita-lo como
# sessao seria dar acesso a quem parou no meio.
#
grep -q "MFA_TOKEN_AUDIENCE" "$REPO/server/middleware/auth.js" \
  && ok "o guarda continua recusando token meio-autenticado" \
  || nok "o guarda saiu junto -- tokens em voo passariam como sessao"

echo "--- e os segredos parados continuam sem sair pela API ---"
# As colunas ficaram na tabela. Uma coluna parada com um segredo dentro continua sendo um
# segredo, e tirar da lista de redacao porque "a funcionalidade acabou" e como ele vaza.
grep -q "'totp_secret_enc'" "$REPO/server/routes/auth.js" \
  && ok "totp_secret_enc segue na lista de campos privados" \
  || nok "totp_secret_enc saiu da redacao -- a coluna ainda existe no banco"

echo
[ "$falhas" -eq 0 ] && echo "A SEGUNDA ETAPA SAIU, E SAIU INTEIRA" || echo "$falhas FALHA(S)"
exit "$falhas"
