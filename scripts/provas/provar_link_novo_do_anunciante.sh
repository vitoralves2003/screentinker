#!/bin/sh
# QUEM ESQUECEU A SENHA VOLTA A ENTRAR — contra o servidor de verdade.
#
# Pergunta do Vitor em 05/09: "se o anunciante esquecer a senha como ele faz para recuperá-la?".
# Não fazia. A tela de entrada mandava pedir um link novo a quem opera as telas, e quem opera as
# telas não tinha como gerar: `liberar` só manda link para conta SEM senha.
#
# ── por que ela vai até o fim, e não para no "gerou o link" ─────────────────────────────────
# Um link gerado não é uma senha trocada. O que importa é a volta inteira: o assinante pede, a
# pessoa usa o link, define outra senha, e ENTRA com ela. Cada uma dessas quatro coisas mora numa
# camada diferente — a rota do tenant, o token de ativação, a rota de ativar, a porta do portal —
# e uma prova que parasse no meio deixaria as outras três sem ninguém olhando.
#
# E ela confere a coisa que ninguém pensa em conferir: a senha VELHA para de valer depois.
#
# Uso:  BASE=https://beta.loopplayer.com.br TOKEN=<sessao do assinante> sh provar_link_novo_do_anunciante.sh

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

CONVIDADO=esqueceu-a-senha@exemplo.invalid
PRIMEIRA='PrimeiraSenha#2026'
SEGUNDA='SegundaSenha#2026'

limpar_tudo() {
  $PSQL "DELETE FROM \"Acesso\" WHERE \"userId\" IN (SELECT id FROM \"User\" WHERE email = '$CONVIDADO');" >/dev/null 2>&1
  $PSQL "DELETE FROM \"AccountActivationToken\" WHERE \"userId\" IN (SELECT id FROM \"User\" WHERE email = '$CONVIDADO');" >/dev/null 2>&1
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
echo "  usuario=$USUARIO"

echo ""
echo "== ele define a primeira senha e entra =="
# Pela tela de ativação de verdade: o token do convite sai da resposta, e é ele que a pessoa
# recebe. Plantar o hash direto no banco mediria o banco, e o que interessa aqui é o CAMINHO.
TOKEN_ATIVACAO=$(echo "$RESP" | sed -n 's/.*token=\([a-f0-9]*\)".*/\1/p')
exigir "token do convite" "$TOKEN_ATIVACAO"
curl -s -o /dev/null -X POST "$BASE/gestao-api/auth/activate" -H 'Content-Type: application/json' \
  -d "{\"token\":\"$TOKEN_ATIVACAO\",\"password\":\"$PRIMEIRA\"}"
COD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/portal/entrar" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$CONVIDADO\",\"senha\":\"$PRIMEIRA\"}")
[ "$COD" = "200" ] || { echo "  O CENARIO NAO FOI CRIADO: ele nao entrou com a primeira senha ($COD)"; exit 3; }
echo "  entrou com a primeira senha"

echo ""
echo "== convidar de novo NAO manda link (e por isso a outra rota existe) =="
# O comportamento que criou o buraco, medido de propósito: sem esta linha, alguém "consertaria"
# o liberar um dia e ninguém saberia que a rota nova tinha deixado de ser necessária — ou pior,
# que o portal passou a disparar "defina sua senha" para quem não pediu.
DENOVO=$(curl -s -X POST "$BASE/api/clientes/$CA/acesso-ao-portal" -H "$AUTH" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$CONVIDADO\"}")
echo "$DENOVO" | grep -q '"linkDeAtivacao":null' && ok "liberar de novo nao gera link" \
  || nok "liberar mandou link a quem ja tem senha: $(echo "$DENOVO" | head -c 160)"

echo ""
echo "== o assinante pede um link novo =="
NOVO=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/clientes/$CA/acesso-ao-portal/$USUARIO/reenviar-link" -H "$AUTH")
COD=$(echo "$NOVO" | tail -1)
CORPO=$(echo "$NOVO" | head -n -1)
echo "  HTTP $COD  $(echo "$CORPO" | head -c 200)"
[ "$COD" = "200" ] && ok "a rota responde 200" || nok "a rota respondeu $COD"
echo "$CORPO" | grep -q '"redefinindo":true' && ok "e ela sabe que e REDEFINICAO, nao convite" \
  || nok "a resposta nao diz que e redefinicao"
echo "$CORPO" | grep -q '"linkDeAtivacao":"http' && ok "o link volta na resposta (para o WhatsApp)" \
  || nok "sem link na resposta"

echo ""
echo "== e a senha velha continua valendo ATE ele usar o link =="
# Quem pediu por engano, ou nunca abriu o e-mail, não pode ficar trancado do lado de fora.
COD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/portal/entrar" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$CONVIDADO\",\"senha\":\"$PRIMEIRA\"}")
[ "$COD" = "200" ] && ok "a primeira senha ainda entra" || nok "gerar o link derrubou a senha atual ($COD)"

echo ""
echo "== ele usa o link e define outra senha =="
TOKEN_NOVO=$(echo "$CORPO" | sed -n 's/.*token=\([a-f0-9]*\)".*/\1/p')
exigir "token do link novo" "$TOKEN_NOVO"
# São tokens diferentes: o upsert troca o hash, então o anterior morre. Se fossem iguais, um link
# antigo esquecido numa caixa de entrada continuaria abrindo a conta.
[ "$TOKEN_NOVO" != "$TOKEN_ATIVACAO" ] && ok "o token novo NAO e o mesmo do convite" \
  || nok "o link novo repetiu o token antigo"
COD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/gestao-api/auth/activate" \
  -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN_NOVO\",\"password\":\"$SEGUNDA\"}")
# `case` e nao `[ ] || [ ] && ok || nok`: aquela corrente avalia da esquerda para a direita e
# acerta por acaso -- basta trocar a ordem dos ramos para ela passar a mentir em silencio.
case "$COD" in
  200|201) ok "a ativacao aceitou a senha nova" ;;
  *)       nok "ativar respondeu $COD" ;;
esac

echo ""
echo "== e agora e a SEGUNDA que entra, e so ela =="
COD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/portal/entrar" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$CONVIDADO\",\"senha\":\"$SEGUNDA\"}")
[ "$COD" = "200" ] && ok "ele entra com a senha nova" || nok "a senha nova nao entra ($COD)"
# A metade que ninguém confere: trocar a senha tem de INVALIDAR a anterior. Sem isto, a senha que
# vazou — ou que a pessoa quis trocar por outro motivo — continuaria abrindo a conta.
COD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/portal/entrar" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$CONVIDADO\",\"senha\":\"$PRIMEIRA\"}")
[ "$COD" = "401" ] && ok "e a senha velha parou de valer (401)" || nok "a senha velha ainda entra ($COD)"

echo ""
echo "== o link usado nao serve duas vezes =="
# `usedAt` existe para isso. Um link de definir senha que continua valendo depois de usado é uma
# chave permanente na caixa de entrada de alguém.
COD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/gestao-api/auth/activate" \
  -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN_NOVO\",\"password\":\"OutraQualquer#2026\"}")
[ "$COD" = "400" ] && ok "reusar o link e recusado (400)" || nok "o link usado respondeu $COD"

echo ""
echo "== e ninguem de fora pede link pela conta dos outros =="
# A trava que faz esta rota ser segura: sem ela, um userId no caminho geraria link de definicao
# de senha para qualquer conta -- inclusive a de um titular.
COD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/clientes/$CA/acesso-ao-portal/$UID_/reenviar-link" -H "$AUTH")
[ "$COD" = "404" ] && ok "o titular (sem vinculo aqui) recebe 404" || nok "pedir link para o titular respondeu $COD"
# E o cliente B, do MESMO tenant: quem opera a Padaria não mexe no acesso da Ótica.
COD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/clientes/$CB/acesso-ao-portal/$USUARIO/reenviar-link" -H "$AUTH")
[ "$COD" = "404" ] && ok "pelo cliente vizinho tambem: 404" || nok "pelo cliente vizinho respondeu $COD"

echo ""
[ "$falhas" = "0" ] && echo "QUEM ESQUECE A SENHA VOLTA A ENTRAR" || echo "$falhas FALHA(S)"
exit $falhas
