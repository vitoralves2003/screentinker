#!/bin/sh
# C3 — o login cai onde o plano manda.
#
# O navegador faz tres coisas depois de autenticar: pergunta o inicio ao menu, pede o token
# de troca e atravessa. Este script faz as mesmas tres, na mesma ordem, com os mesmos
# endpoints — se qualquer uma quebrar, o login para de sair do lugar certo.
#
# A pergunta que importa nao e "o menu respondeu?" e sim "a travessia termina numa sessao
# valida da Gestao?". Um token de troca que a Gestao recusa deixaria o cliente Master numa
# pagina de erro logo depois de acertar a senha.

OP=http://127.0.0.1:3110
GE=http://127.0.0.1:3121
EMAIL=cliente@exemplo.invalid
SENHA='SenhaCliente#2026'

. /tmp/mfa_lib.sh

falhas=0
ok()  { echo "  OK     $1"; }
nok() { echo "  FALHOU $1"; falhas=$((falhas+1)); }

WS=$(docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
const u=db.prepare('SELECT id FROM users WHERE email = ?').get('$EMAIL');
console.log(db.prepare('SELECT id FROM workspaces WHERE created_by = ?').get(u.id).id);
" 2>/dev/null | tr -d '\r')

por_plano() {
  docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
db.prepare('UPDATE workspaces SET plan_id = ? WHERE id = ?').run('$1','$WS');
" >/dev/null 2>&1
}

# A prova do passo 2 derruba a Operacao de proposito e a religa. Rodando logo depois, o
# login daqui bate numa porta que ainda esta abrindo -- e as oito checagens reprovam por
# uma causa que nao tem nada a ver com o destino do login.
until [ "$(curl -s -o /dev/null -w '%{http_code}' $OP/)" != "000" ]; do sleep 2; done

# E o segredo TOTP desta conta e rematriculado por outras provas. Preparar o proprio
# terreno torna o resultado independente da ordem de execucao.
preparar_mfa "$EMAIL" "$SENHA"

S=$(entrar "$EMAIL" "$SENHA")
[ -n "$S" ] && ok "autenticou (o funil onAuthSuccess comeca aqui)" || nok "nao autenticou"

echo "=== PRO — o inicio e a propria Operacao, sem travessia ==="
por_plano pro
INICIO=$(curl -s $OP/api/menu -H "Authorization: Bearer $S" | sed -n 's/.*"inicio":"\([^"]*\)".*/\1/p')
echo "  inicio: $INICIO"
case "$INICIO" in
  *'#/'*) ok "o inicio aponta para dentro da Operacao" ;;
  *) nok "esperava um endereco da Operacao, veio: $INICIO" ;;
esac

echo "=== MASTER — o inicio e a Gestao, e a travessia precisa funcionar ==="
por_plano master
INICIO=$(curl -s $OP/api/menu -H "Authorization: Bearer $S" | sed -n 's/.*"inicio":"\([^"]*\)".*/\1/p')
echo "  inicio: $INICIO"
case "$INICIO" in
  *'#/'*) nok "caiu na Operacao mesmo com Gestao no plano" ;;
  http*) ok "o inicio aponta para fora da Operacao" ;;
  *) nok "inicio vazio ou invalido: $INICIO" ;;
esac

# O passo que o login faz em seguida: descobrir para onde atravessar.
CFG=$(curl -s $OP/api/auth/config)
echo "$CFG" | grep -q '"gestao_url"' && ok "config publica traz gestao_url" || nok "sem gestao_url na config"

# O caminho extraido do inicio e o que vai no &d= — precisa ser interno e nao vazio.
DEST=$(echo "$INICIO" | sed -e 's|^https\?://[^/]*||')
echo "  destino: $DEST"
case "$DEST" in
  /?*) ok "destino e um caminho interno" ;;
  *) nok "destino nao serve para o &d=: '$DEST'" ;;
esac

# O token de troca.
T=$(curl -s -X POST $OP/api/auth/federation/gestao -H "Authorization: Bearer $S" \
      | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$T" ] && ok "a Operacao emitiu o token de troca" || nok "nenhum token de troca"

# A prova final: a Gestao aceita esse token e devolve uma sessao de verdade.
R=$(curl -s -X POST $GE/auth/federated -H 'Content-Type: application/json' \
      -d "{\"token\":\"$T\"}")
echo "$R" | grep -q '"accessToken"' \
  && ok "a Gestao aceitou e devolveu uma sessao" \
  || nok "a Gestao recusou a travessia: $(echo "$R" | head -c 160)"

# Uma sessao que nao abre nada nao e sessao. Usar o token no painel de destino.
A=$(echo "$R" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
if [ -n "$A" ]; then
  D=$(curl -s -o /dev/null -w '%{http_code}' $GE/dashboard/menu -H "Authorization: Bearer $A")
  [ "$D" = "200" ] && ok "a sessao abre o painel de destino (HTTP $D)" || nok "o destino recusou a sessao (HTTP $D)"
else
  nok "sem accessToken, nao da para conferir o destino"
fi

echo
[ "$falhas" = "0" ] && echo "C3: tudo passou" || echo "C3: $falhas falha(s)"
