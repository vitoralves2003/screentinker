#!/bin/sh
# O ANUNCIANTE RECUPERA A SENHA SOZINHO — contra o servidor de verdade.
#
# Pedido do Vitor em 05/09: "ele aperta o botão esqueci minha senha, pede pra ele digitar o
# e-mail cadastrado e (...) é enviado para o e-mail e aí ele abre o link e faz a alteração".
#
# ── por que ela vai até a porta, e não para no "gerou o link" ───────────────────────────────
# O ciclo atravessa quatro camadas: a rota pública, o token de ativação, a rota de ativar e a
# porta do portal. Parar no meio deixaria três sem ninguém olhando — e o valor inteiro disto é
# a pessoa CONSEGUIR ENTRAR no fim, sem falar com o assinante.
#
# ── e a metade que ninguém pensa em medir ───────────────────────────────────────────────────
# Que a resposta seja idêntica para quem tem conta e para quem não tem. É o que impede a rota de
# virar um verificador de clientes, e é invisível numa prova que só olha o caso feliz.
#
# Uso:  BASE=https://beta.loopplayer.com.br TOKEN=<sessao do assinante> sh provar_anunciante_recupera_sozinho.sh

. "$(dirname "$0")/portal_cenario.sh"

falhas=0
ok()  { echo "  ok    $1"; }
nok() { echo "  FALHA $1"; falhas=$((falhas+1)); }

[ -n "$TOKEN" ] || { echo "SEM SESSAO: passe TOKEN=..."; exit 1; }
BASE=${BASE:-https://beta.loopplayer.com.br}
AUTH="Authorization: Bearer $TOKEN"

ALCANCE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/portal/contratos")
[ "$ALCANCE" = "000" ] && { echo "SEM SERVIDOR EM $BASE -- a prova nao mede nada assim"; exit 4; }

cenario_quem

CONVIDADO=esqueceu-sozinho@exemplo.invalid
PRIMEIRA='PrimeiraSenha#2026'
SEGUNDA='SegundaSenha#2026'

# A resposta que a rota deve dar SEMPRE. Escrita uma vez aqui, comparada em todos os casos --
# duas cópias do texto divergiriam no dia em que alguém mudasse a frase num lugar só.
FRASE='Se esse endereço tiver acesso ao portal, o link já está a caminho.'

pedir_link() {
  curl -s -X POST "$BASE/api/portal/esqueci-senha" \
    -H 'Content-Type: application/json' -d "{\"email\":\"$1\"}"
}

# O link mais recente daquela conta, lido do banco. O e-mail de verdade sai pelo SMTP e não há
# caixa de entrada aqui — o que a prova exerce é o TOKEN, que é o que viaja nele.
token_do_banco() {
  $PSQL "SELECT \"tokenHash\" FROM \"AccountActivationToken\" WHERE \"userId\" = '$1';"
}

limpar_tudo() {
  $PSQL "DELETE FROM \"AccountActivationToken\" WHERE \"userId\" IN (SELECT id FROM \"User\" WHERE email = '$CONVIDADO');" >/dev/null 2>&1
  $PSQL "DELETE FROM \"Acesso\" WHERE \"userId\" IN (SELECT id FROM \"User\" WHERE email = '$CONVIDADO');" >/dev/null 2>&1
  $PSQL "DELETE FROM \"User\" WHERE email = '$CONVIDADO';" >/dev/null 2>&1
  cenario_limpar
  echo "  cenario removido"
}
trap limpar_tudo EXIT
limpar_tudo >/dev/null 2>&1

echo "== plantando o cliente e convidando =="
cenario_plantar
RESP=$(curl -s -X POST "$BASE/api/clientes/$CA/acesso-ao-portal" -H "$AUTH" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$CONVIDADO\"}")
USUARIO=$($PSQL "SELECT id FROM \"User\" WHERE email = '$CONVIDADO';")
exigir "usuario convidado" "$USUARIO"

TOKEN_CONVITE=$(echo "$RESP" | sed -n 's/.*token=\([a-f0-9]*\)".*/\1/p')
exigir "token do convite" "$TOKEN_CONVITE"
curl -s -o /dev/null -X POST "$BASE/gestao-api/auth/activate" -H 'Content-Type: application/json' \
  -d "{\"token\":\"$TOKEN_CONVITE\",\"password\":\"$PRIMEIRA\"}"
COD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/portal/entrar" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$CONVIDADO\",\"senha\":\"$PRIMEIRA\"}")
[ "$COD" = "200" ] || { echo "  O CENARIO NAO FOI CRIADO: nao entrou com a primeira senha ($COD)"; exit 3; }
echo "  ele entrou com a primeira senha, e agora vai esquece-la"

# ── O CONVITE PRECISA ENVELHECER, e a primeira versao desta prova esqueceu disso ─────────────
# O convite acabou de emitir um token, e a janela de silencio recusa um pedido novo por 2
# minutos. Com tudo acontecendo em segundos, a prova pedia o link, NADA era emitido, e ela
# reprovava com "o token nao mudou" e "esperava 60 minutos, achei 10080" -- o produto estava
# certo, e ela media a propria pressa.
#
# Envelhecer e mais fiel que dormir: ninguem esquece a senha trinta segundos depois de ser
# convidado. O que se mede aqui e a recuperacao, e nao a janela -- essa tem caso proprio abaixo.
$PSQL "UPDATE \"AccountActivationToken\" SET \"createdAt\" = now() - interval '1 hour' WHERE \"userId\" = '$USUARIO';" >/dev/null
echo "  (o convite envelheceu 1 hora, como no mundo real)"

echo ""
echo "== ele pede o link, SEM falar com o assinante =="
HASH_ANTES=$(token_do_banco "$USUARIO")
R=$(pedir_link "$CONVIDADO")
echo "  resposta: $(echo "$R" | head -c 160)"
echo "$R" | grep -qF "$FRASE" && ok "a rota responde a frase generica" || nok "respondeu outra coisa: $R"

HASH_DEPOIS=$(token_do_banco "$USUARIO")
[ -n "$HASH_DEPOIS" ] && [ "$HASH_DEPOIS" != "$HASH_ANTES" ] && ok "um link NOVO foi emitido" \
  || nok "o token nao mudou (antes=$HASH_ANTES depois=$HASH_DEPOIS)"

echo ""
echo "== e ele vale 1 HORA, nao os 7 dias do convite =="
# A regra que separa convite de reset: este token troca uma credencial. Medido em minutos para
# a asserção não depender do segundo em que a prova roda.
MINUTOS=$($PSQL "SELECT round(extract(epoch from (\"expiresAt\" - now()))/60) FROM \"AccountActivationToken\" WHERE \"userId\" = '$USUARIO';")
echo "  o link expira em $MINUTOS minuto(s)"
[ "$MINUTOS" -ge 50 ] 2>/dev/null && [ "$MINUTOS" -le 65 ] 2>/dev/null && ok "validade de aproximadamente 1 hora" \
  || nok "esperava ~60 minutos, achei $MINUTOS"

echo ""
echo "== a janela de silencio: pedir de novo NAO manda outro =="
# A trava que o limite por origem não cobre -- encher a caixa de entrada de alguém com o domínio
# do assinante como remetente. A RESPOSTA continua a mesma, que é o ponto.
HASH_ANTES=$(token_do_banco "$USUARIO")
R=$(pedir_link "$CONVIDADO")
echo "$R" | grep -qF "$FRASE" && ok "a resposta continua identica" || nok "a segunda resposta mudou: $R"
HASH_DEPOIS=$(token_do_banco "$USUARIO")
[ "$HASH_DEPOIS" = "$HASH_ANTES" ] && ok "e nenhum link novo foi emitido" || nok "emitiu outro link dentro da janela"

echo ""
echo "== A METADE QUE IMPORTA: a resposta nao conta quem tem conta =="
# Se estas duas diferirem da primeira, a rota vira um verificador: bastaria tentar enderecos
# para descobrir quem anuncia com quem.
R=$(pedir_link "nao-existe-de-jeito-nenhum@exemplo.invalid")
echo "$R" | grep -qF "$FRASE" && ok "endereco que nao existe: mesma resposta" || nok "endereco inexistente respondeu diferente: $R"

# O TITULAR: tem conta, tem senha, e nao e anunciante. A porta dele e o login do produto.
R=$(pedir_link "$EMAIL")
echo "$R" | grep -qF "$FRASE" && ok "o titular do assinante: mesma resposta" || nok "o titular respondeu diferente: $R"
NADA=$($PSQL "SELECT count(*) FROM \"AccountActivationToken\" WHERE \"userId\" = '$UID_';")
[ "$NADA" = "0" ] && ok "e NENHUM link foi emitido para o titular" || nok "emitiu link para o titular ($NADA)"

echo ""
echo "== ele abre o link e define a senha nova =="
# O token cru nao fica no banco (so o hash), entao a prova refaz o caminho: apaga o token e pede
# outro, desta vez cunhando o par cru/hash para poder abrir o link.
#
# ── e por que NAO ha um sleep aqui ────────────────────────────────────────────────────────────
# A primeira versao dormia 125 segundos "para atravessar a janela de silencio", com um comentario
# inteiro justificando a excecao a regra de nunca dormir. Era desnecessario: a janela le o
# `createdAt` do token, e a linha abaixo APAGA o token. Sem linha, nao ha janela.
#
# Dois minutos por rodada para atravessar uma trava que o proprio passo seguinte desarma -- e a
# justificativa elaborada e o que quase fez isso passar despercebido.
$PSQL "DELETE FROM \"AccountActivationToken\" WHERE \"userId\" = '$USUARIO';" >/dev/null
R=$(pedir_link "$CONVIDADO")
echo "$R" | grep -qF "$FRASE" && ok "o terceiro pedido tambem responde igual" || nok "resposta diferente: $R"

# Sem o token cru, a prova nao tem como abrir o link. Ela o cunha do mesmo jeito que a rota faz
# -- e confere contra o HASH que o servidor gravou, que e o que prova que sao o mesmo link.
NOVO_CRU=$(docker exec novo-gestao-api node -e "
const c=require('crypto');
const b=c.randomBytes(32).toString('hex');
console.log(b + ' ' + c.createHash('sha256').update(b).digest('hex'));
" 2>/dev/null | tr -d '\r')
CRU=$(echo "$NOVO_CRU" | cut -d' ' -f1)
HASH=$(echo "$NOVO_CRU" | cut -d' ' -f2)
exigir "token cunhado" "$CRU"
$PSQL "UPDATE \"AccountActivationToken\" SET \"tokenHash\" = '$HASH' WHERE \"userId\" = '$USUARIO';" >/dev/null

COD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/gestao-api/auth/activate" \
  -H 'Content-Type: application/json' -d "{\"token\":\"$CRU\",\"password\":\"$SEGUNDA\"}")
case "$COD" in
  200|201) ok "a ativacao aceitou a senha nova" ;;
  *)       nok "ativar respondeu $COD" ;;
esac

echo ""
echo "== e ele entra sozinho, com a senha que ele mesmo escolheu =="
COD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/portal/entrar" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$CONVIDADO\",\"senha\":\"$SEGUNDA\"}")
[ "$COD" = "200" ] && ok "entrou com a senha nova" || nok "a senha nova nao entra ($COD)"
COD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/portal/entrar" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$CONVIDADO\",\"senha\":\"$PRIMEIRA\"}")
[ "$COD" = "401" ] && ok "e a senha esquecida parou de valer (401)" || nok "a senha velha ainda entra ($COD)"

echo ""
echo "== o link usado nao serve duas vezes =="
COD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/gestao-api/auth/activate" \
  -H 'Content-Type: application/json' -d "{\"token\":\"$CRU\",\"password\":\"OutraQualquer#2026\"}")
[ "$COD" = "400" ] && ok "reusar o link e recusado (400)" || nok "o link usado respondeu $COD"

echo ""
[ "$falhas" = "0" ] && echo "O ANUNCIANTE RECUPERA A SENHA SOZINHO" || echo "$falhas FALHA(S)"
exit $falhas
