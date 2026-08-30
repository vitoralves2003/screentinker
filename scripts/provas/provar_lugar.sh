#!/bin/sh
# Etapa 1 -- um nome so para o cliente, e um vocabulario so para o papel.
#
# O DEFEITO: a barra da Operacao escrevia "Vitor" (nome do workspace) e a da Gestao escrevia
# "Vitor's organization" (nome da organizacao), para a mesma pessoa na mesma sessao. E embaixo
# do avatar, "user" de um lado e "TITULAR" do outro.
#
# ── POR QUE ESTA PROVA PRECISA SABOTAR O BANCO ANTES ─────────────────────────────────────
# Se o nome da organizacao e o do workspace forem iguais, as duas portas concordam por
# acidente e a prova passa sem provar nada. Ja aconteceu tres vezes neste projeto -- um `sed`
# que devolvia a entrada inteira, um `grep -q ""` que casava com qualquer coisa. Entao aqui os
# dois nomes sao postos DIFERENTES de proposito, e so depois se pergunta qual deles saiu.

OP=http://127.0.0.1:3110
EMAIL=cliente@exemplo.invalid
SENHA='SenhaCliente#2026'

ORG_NOME='Padaria Central LTDA'
WS_NOME='rede-de-telas-antiga'

. "$(dirname "$0")/mfa_lib.sh"

falhas=0
ok()  { echo "  OK     $1"; }
nok() { echo "  FALHOU $1"; falhas=$((falhas+1)); }
TMP=${TMPDIR:-/tmp}

no_banco() { docker exec novo-operacao node -e "$1" 2>/dev/null | tr -d '\r'; }

campo() { python3 -c "
import json,sys
try:
    d=json.load(open('$1'))
except Exception as e:
    print('ERRO-JSON'); sys.exit(0)
v=d
for p in '$2'.split('.'):
    if not isinstance(v,dict) or p not in v: print('AUSENTE'); sys.exit(0)
    v=v[p]
print(v if v is not None else 'NULO')
"; }

# ── ground: descobrir os ids e por nomes diferentes nos dois lugares ──────────────────────
IDS=$(no_banco "
const {db}=require('/app/server/db/database');
const u=db.prepare('SELECT id FROM users WHERE email = ?').get('$EMAIL');
const w=db.prepare('SELECT id, organization_id FROM workspaces WHERE created_by = ?').get(u.id);
console.log(w.id+' '+w.organization_id+' '+u.id);
")
WS=$(echo "$IDS" | cut -d' ' -f1)
ORG=$(echo "$IDS" | cut -d' ' -f2)
UID_=$(echo "$IDS" | cut -d' ' -f3)

if [ -z "$WS" ] || [ -z "$ORG" ]; then
  echo "  FALHOU nao achei o workspace/organizacao de $EMAIL"; exit 1
fi

ANTES=$(no_banco "
const {db}=require('/app/server/db/database');
const o=db.prepare('SELECT name FROM organizations WHERE id = ?').get('$ORG');
const w=db.prepare('SELECT name FROM workspaces WHERE id = ?').get('$WS');
console.log(JSON.stringify({o:o.name,w:w.name}));
")

restaurar() {
  no_banco "
const {db}=require('/app/server/db/database');
const a=$ANTES;
db.prepare('UPDATE organizations SET name = ? WHERE id = ?').run(a.o,'$ORG');
db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(a.w,'$WS');
" >/dev/null
}
trap restaurar EXIT INT TERM

no_banco "
const {db}=require('/app/server/db/database');
db.prepare('UPDATE organizations SET name = ? WHERE id = ?').run('$ORG_NOME','$ORG');
db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run('$WS_NOME','$WS');
" >/dev/null

CONF=$(no_banco "
const {db}=require('/app/server/db/database');
const o=db.prepare('SELECT name FROM organizations WHERE id = ?').get('$ORG').name;
const w=db.prepare('SELECT name FROM workspaces WHERE id = ?').get('$WS').name;
console.log(o === w ? 'IGUAIS' : 'DIFERENTES');
")
[ "$CONF" = "DIFERENTES" ] \
  && ok "os dois nomes estao diferentes no banco (senao a prova nao provaria nada)" \
  || { echo "  FALHOU nao consegui deixar os nomes diferentes"; exit 1; }

preparar_mfa "$EMAIL" "$SENHA"
S=$(entrar "$EMAIL" "$SENHA")
case "$S" in *.*.*) : ;; *) echo "  FALHOU nao autenticou $EMAIL"; exit 1 ;; esac

# Token federado: o mesmo que a API da Gestao apresenta. Emitido aqui com o segredo real --
# forjar com outro segredo e o caso do provar_federacao.sh, e la ele TEM de ser recusado.
fed_token() {
  no_banco "
const jwt=require('jsonwebtoken');
const config=require('/app/server/config');
console.log(jwt.sign({organizationId:'$ORG',papel:'$1'},config.federationSecret,
  {algorithm:'HS256',audience:'operacao',issuer:'gestao',expiresIn:60}));
"
}

echo "=== 1. a porta do NAVEGADOR devolve o nome da organizacao ==="
curl -s "$OP/api/menu" -H "Authorization: Bearer $S" > "$TMP/lugar_nav.json"
NAV=$(campo "$TMP/lugar_nav.json" lugar.nome)
[ "$NAV" = "$ORG_NOME" ] && ok "lugar.nome = '$NAV'" \
  || nok "esperava '$ORG_NOME', veio '$NAV'"

echo "--- e NAO o nome do workspace (o defeito antigo) ---"
[ "$NAV" != "$WS_NOME" ] && ok "nao devolveu '$WS_NOME'" \
  || nok "voltou a devolver o nome do workspace"

echo "=== 2. a porta FEDERADA devolve exatamente o mesmo ==="
TOK=$(fed_token TITULAR)
curl -s "$OP/api/federation/menu" -H "Authorization: Bearer $TOK" > "$TMP/lugar_fed.json"
FED=$(campo "$TMP/lugar_fed.json" lugar.nome)
[ "$FED" = "$ORG_NOME" ] && ok "lugar.nome = '$FED'" \
  || nok "esperava '$ORG_NOME', veio '$FED'"

echo "--- as duas portas, byte a byte ---"
[ "$NAV" = "$FED" ] && ok "'$NAV' == '$FED'" \
  || nok "as portas divergem: navegador='$NAV' federada='$FED'"

echo "=== 3. o papel sai no mesmo vocabulario nas duas portas ==="
P_NAV=$(campo "$TMP/lugar_nav.json" usuario.papel_rotulo)
P_FED=$(campo "$TMP/lugar_fed.json" usuario.papel_rotulo)
[ "$P_NAV" = "TITULAR" ] && ok "navegador: $P_NAV" || nok "navegador: esperava TITULAR, veio '$P_NAV'"
[ "$P_FED" = "TITULAR" ] && ok "federada:  $P_FED" || nok "federada: esperava TITULAR, veio '$P_FED'"

echo "--- e nunca 'user', que era a palavra do banco vazando para a tela ---"
case "$P_NAV$P_FED" in
  *user*) nok "'user' ainda aparece como papel" ;;
  *) ok "nenhuma das portas escreve 'user'" ;;
esac

echo "=== 4. um OPERADOR e chamado de OPERADOR pelas duas ==="
# canAdmin e um OU de TRES fontes -- papel de plataforma, da organizacao e do workspace.
# Rebaixar so uma prova exatamente nada: ja custou duas rodadas neste projeto.
ANTES_P=$(no_banco "
const {db}=require('/app/server/db/database');
const u=db.prepare('SELECT role FROM users WHERE id = ?').get('$UID_');
const o=db.prepare('SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?').get('$ORG','$UID_');
const w=db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get('$WS','$UID_');
console.log(JSON.stringify({u:u&&u.role,o:o&&o.role,w:w&&w.role}));
")
no_banco "
const {db}=require('/app/server/db/database');
db.prepare('UPDATE users SET role = ? WHERE id = ?').run('user','$UID_');
db.prepare('UPDATE organization_members SET role = ? WHERE organization_id = ? AND user_id = ?').run('org_member','$ORG','$UID_');
db.prepare('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?').run('workspace_viewer','$WS','$UID_');
" >/dev/null

S2=$(entrar "$EMAIL" "$SENHA")
curl -s "$OP/api/menu" -H "Authorization: Bearer $S2" > "$TMP/lugar_nav_op.json"
TOK2=$(fed_token OPERADOR)
curl -s "$OP/api/federation/menu" -H "Authorization: Bearer $TOK2" > "$TMP/lugar_fed_op.json"

O_NAV=$(campo "$TMP/lugar_nav_op.json" usuario.papel_rotulo)
O_FED=$(campo "$TMP/lugar_fed_op.json" usuario.papel_rotulo)
[ "$O_NAV" = "OPERADOR" ] && ok "navegador: $O_NAV" || nok "navegador: esperava OPERADOR, veio '$O_NAV'"
[ "$O_FED" = "OPERADOR" ] && ok "federada:  $O_FED" || nok "federada: esperava OPERADOR, veio '$O_FED'"

no_banco "
const {db}=require('/app/server/db/database');
const a=$ANTES_P;
db.prepare('UPDATE users SET role = ? WHERE id = ?').run(a.u,'$UID_');
if(a.o) db.prepare('UPDATE organization_members SET role = ? WHERE organization_id = ? AND user_id = ?').run(a.o,'$ORG','$UID_');
if(a.w) db.prepare('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?').run(a.w,'$WS','$UID_');
" >/dev/null

echo "=== 5. a forma antiga continua respondida, para nao quebrar a Gestao em producao ==="
# A Etapa 1 sobe sozinha, e a Gestao que esta no ar ainda le `workspace.nome`. Apagar agora
# seria derrubar a barra dela ate o proximo deploy. A Etapa 4 apaga, quando ninguem mais ler.
W_NAV=$(campo "$TMP/lugar_nav.json" workspace.nome)
case "$W_NAV" in
  AUSENTE|ERRO-JSON) nok "a chave antiga sumiu antes da hora: '$W_NAV'" ;;
  *) ok "workspace.nome ainda respondido ('$W_NAV')" ;;
esac

echo
[ "$falhas" -eq 0 ] && echo "TUDO VERDE" || echo "$falhas FALHA(S)"
exit "$falhas"
