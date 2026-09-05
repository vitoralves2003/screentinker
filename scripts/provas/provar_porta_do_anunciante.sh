#!/bin/sh
# A PORTA DO ANUNCIANTE — contra o servidor de verdade, com uma conta convidada de verdade.
#
# ── o caso que justifica o desenho inteiro ──────────────────────────────────────────────────
# O token do portal é assinado com o MESMO segredo do token do assinante. Se o guarda de tenant
# não olhasse o escopo, ele passaria pela verificação de assinatura em qualquer rota do produto e
# viraria uma sessão de operador — com o `organizationId` do assinante que convidou, que é o pior
# caso possível: indistinguível de gente da casa.
#
# Então esta prova não se contenta em ver o portal abrir. Ela pega o token do anunciante e o
# aponta para Clientes, Contratos e Telas, e exige recusa nas três.
#
# ── e o convite, que é o outro lado ─────────────────────────────────────────────────────────
# Até 05/09 o vínculo só nascia por SQL. Aqui ele nasce pela rota que a ficha do cliente chama,
# com um e-mail que não existia — e a prova confere que a conta nasceu SEM senha (ela é definida
# pelo link) e SEM workspace (a pessoa de portal não é membro de nada).
#
# Uso:  BASE=https://beta.loopplayer.com.br TOKEN=<sessao do assinante> sh provar_porta_do_anunciante.sh

. "$(dirname "$0")/portal_cenario.sh"

falhas=0
ok()  { echo "  ok    $1"; }
nok() { echo "  FALHA $1"; falhas=$((falhas+1)); }

[ -n "$TOKEN" ] || { echo "SEM SESSAO: passe TOKEN=..."; exit 1; }
BASE=${BASE:-https://beta.loopplayer.com.br}
AUTH="Authorization: Bearer $TOKEN"

ALCANCE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/portal/contratos" -H "$AUTH")
[ "$ALCANCE" = "000" ] && { echo "SEM SERVIDOR EM $BASE -- a prova nao mede nada assim"; exit 4; }

cenario_quem

CONVIDADO=anunciante-da-prova@exemplo.invalid

limpar_tudo() {
  $PSQL "DELETE FROM \"Acesso\" WHERE \"userId\" IN (SELECT id FROM \"User\" WHERE email = '$CONVIDADO');" >/dev/null 2>&1
  $PSQL "DELETE FROM \"AccountActivationToken\" WHERE \"userId\" IN (SELECT id FROM \"User\" WHERE email = '$CONVIDADO');" >/dev/null 2>&1
  $PSQL "DELETE FROM \"User\" WHERE email = '$CONVIDADO';" >/dev/null 2>&1
  cenario_limpar
  echo "  cenario removido"
}
trap limpar_tudo EXIT
limpar_tudo >/dev/null 2>&1

echo "== plantando o cliente =="
cenario_plantar
echo "  cliente A=$CA"

echo ""
echo "== o assinante da acesso ao portal =="
RESP=$(curl -s -X POST "$BASE/api/clientes/$CA/acesso-ao-portal" -H "$AUTH" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$CONVIDADO\"}")
echo "  resposta: $(echo "$RESP" | head -c 220)"
echo "$RESP" | grep -q '"contaNova":true' && ok "a conta nasceu agora" || nok "a conta nao foi criada: $RESP"
echo "$RESP" | grep -q '"precisaDefinirSenha":true' && ok "e ela nasceu SEM senha" || nok "a conta nasceu com senha"
# O link volta sempre que foi gerado -- e nao so quando o e-mail falha.
echo "$RESP" | grep -q '"linkDeAtivacao":"http' && ok "o link de ativacao volta na resposta" || nok "sem link para mandar por WhatsApp"

USUARIO=$($PSQL "SELECT id FROM \"User\" WHERE email = '$CONVIDADO';")
exigir "usuario convidado" "$USUARIO"

VINCULO=$($PSQL "SELECT count(*) FROM \"Acesso\" WHERE \"userId\" = '$USUARIO' AND funcao = 'ANUNCIANTE' AND \"clientId\" = '$CA';")
[ "$VINCULO" = "1" ] && ok "o vinculo de ANUNCIANTE existe" || nok "esperava 1 vinculo, achei $VINCULO"

echo ""
echo "== e ela nao virou gente da casa =="
# A pessoa de portal existe SÓ no banco da Gestão. Sem conta na Operação ela não entra pelo login
# de lá — e o login da Gestão está fechado enquanto a Operação estiver ao lado.
NA_OPERACAO=$(docker exec novo-operacao node -e "
const m=require('/app/server/db/database'); const db=m.db||m.default||m;
const r=db.prepare('SELECT count(*) c FROM users WHERE email = ?').get('$CONVIDADO');
console.log(r.c);
" 2>/dev/null | tr -d '\r')
[ "$NA_OPERACAO" = "0" ] && ok "nenhuma conta na Operacao" || nok "a conta apareceu na Operacao ($NA_OPERACAO)"

echo ""
echo "== antes de definir a senha, ela nao entra =="
COD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/portal/entrar" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$CONVIDADO\",\"senha\":\"qualquer\"}")
[ "$COD" = "401" ] && ok "conta sem senha: 401" || nok "respondeu $COD"

echo ""
echo "== definindo a senha por fora, para seguir a prova =="
# A ativação real é pela tela /ativar-conta com o token do link. Aqui a senha entra direto no
# banco: o que esta prova mede é a PORTA, e passar pela tela de ativação mediria a tela.
SENHA='SenhaDoAnunciante#2026'
HASH=$(docker exec novo-gestao-api node -e "
const b=require('bcryptjs'); console.log(b.hashSync('$SENHA', 10));
" 2>/dev/null | tr -d '\r')
exigir "hash da senha" "$HASH"
$PSQL "UPDATE \"User\" SET \"passwordHash\" = '$HASH' WHERE id = '$USUARIO';" >/dev/null

echo ""
echo "== agora ela entra pela porta do portal =="
ENTRADA=$(curl -s -X POST "$BASE/api/portal/entrar" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$CONVIDADO\",\"senha\":\"$SENHA\"}")
TOKEN_PORTAL=$(echo "$ENTRADA" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
[ -n "$TOKEN_PORTAL" ] && ok "a entrada devolveu uma sessao" || nok "sem accessToken: $(echo "$ENTRADA" | head -c 200)"
[ -n "$TOKEN_PORTAL" ] || { echo ""; echo "$falhas FALHA(S)"; exit 1; }
PAUTH="Authorization: Bearer $TOKEN_PORTAL"

COD=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/portal/contratos" -H "$PAUTH")
[ "$COD" = "200" ] && ok "e ela abre o portal" || nok "o portal respondeu $COD"

echo ""
echo "== A METADE QUE IMPORTA: o token do portal nao entra no resto do produto =="
# Se qualquer uma destas passar, o desenho inteiro falhou: o convidado teria a casa do assinante.
#
# CAMINHOS QUE EXISTEM DE VERDADE. A primeira versão apontou para `/api/clientes` puro, que não é
# rota nenhuma — o controlador é `/api/clientes/:id/acesso-ao-portal`. O 404 dali era "não
# existe", e a prova o leu como "aceitou": um veredito assustador sobre nada.
#
# E a rota certa importa mais que a genérica: é justamente ela que lista e cria acessos ao portal.
# Um anunciante que a alcançasse poderia dar acesso a quem quisesse — inclusive a si mesmo, em
# outro cliente.
for rota in "/api/clientes/$CA/acesso-ao-portal" /gestao-api/clients /gestao-api/contracts /api/devices /api/content /api/playlists /api/aprovacoes; do
  COD=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$rota" -H "$PAUTH")
  case "$COD" in
    401|403) ok "$rota recusa ($COD)" ;;
    *)       nok "$rota ACEITOU o token do portal ($COD)" ;;
  esac
done

echo ""
echo "== e a sessao do assinante nao entra no portal =="
# A outra direção da mesma trava: o titular tem token válido e não é anunciante.
COD=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/portal/contratos" -H "$AUTH")
[ "$COD" = "401" ] && ok "a sessao do assinante e recusada no portal ($COD)" || nok "o portal aceitou a sessao do assinante ($COD)"

echo ""
echo "== quem nao tem vinculo nao entra, mesmo com senha certa =="
# A recusa é a MESMA de senha errada: dizer "sua conta não é de portal" ensina o que existe atrás.
$PSQL "DELETE FROM \"Acesso\" WHERE \"userId\" = '$USUARIO' AND funcao = 'ANUNCIANTE';" >/dev/null
COD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/portal/entrar" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$CONVIDADO\",\"senha\":\"$SENHA\"}")
[ "$COD" = "401" ] && ok "sem vinculo: 401, com a mesma frase" || nok "respondeu $COD"

echo ""
[ "$falhas" = "0" ] && echo "  (o servidor passou; falta a tela)" || echo "$falhas FALHA(S) no servidor"

# ── A TELA, com a mesma conta que a prova acabou de convidar ──────────────────────────────────
#
# Ela roda DEPOIS de todas as medições de servidor e antes da limpeza, porque precisa do vínculo
# de pé — e o passo anterior o removeu de propósito para medir a recusa. Recriado aqui.
#
# Só roda se ainda não houve falha: com o servidor reprovado, a tela mediria outra coisa.
if [ "$falhas" = "0" ]; then
  $PSQL "INSERT INTO \"Acesso\" (id, \"userId\", \"organizationId\", funcao, \"clientId\", \"criadoEm\")
         VALUES (gen_random_uuid()::text, '$USUARIO', '$ORG', 'ANUNCIANTE', '$CA', CURRENT_TIMESTAMP);" >/dev/null
  echo ""
  echo "======== a entrada, num navegador ========"
  docker run --rm --network host --user root -v "$(cd "$(dirname "$0")" && pwd):/p" \
    -e UNI="${UNI:-https://beta.loopplayer.com.br/gestao}" \
    -e EMAIL="$CONVIDADO" -e SENHA="$SENHA" -e CLIENTE="Padaria da Prova" \
    -e NODE_PATH=/usr/src/app/node_modules \
    --entrypoint node zenika/alpine-chrome:with-puppeteer /p/entrar_no_portal.js
  [ $? = 0 ] || falhas=$((falhas+1))
fi

echo ""
[ "$falhas" = "0" ] && echo "A PORTA DO ANUNCIANTE FUNCIONA, E SO PARA ELE"
exit $falhas
