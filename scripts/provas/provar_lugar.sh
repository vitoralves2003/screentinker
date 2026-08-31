#!/bin/sh
# Etapa 1 -- um nome so para o cliente, e um vocabulario so para o papel.
#
# O DEFEITO: a barra da Operacao escrevia "Vitor" (nome do workspace) e a da Gestao escrevia
# "Vitor's organization" (nome da organizacao), para a mesma pessoa na mesma sessao. E embaixo
# do avatar, "user" de um lado e "TITULAR" do outro.
#
# ── POR QUE ESTA PROVA PRECISA SABOTAR O BANCO ANTES ─────────────────────────────────────
# Se o nome da organizacao e o do workspace forem iguais, a prova passa por acidente, sem
# provar nada. Ja aconteceu tres vezes neste projeto -- um `sed`
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

# O gerador de token federado saiu junto com a porta que ele abria.

echo "=== 1. a porta do NAVEGADOR devolve o nome da organizacao ==="
curl -s "$OP/api/menu" -H "Authorization: Bearer $S" > "$TMP/lugar_nav.json"
NAV=$(campo "$TMP/lugar_nav.json" lugar.nome)
[ "$NAV" = "$ORG_NOME" ] && ok "lugar.nome = '$NAV'" \
  || nok "esperava '$ORG_NOME', veio '$NAV'"

echo "--- e NAO o nome do workspace (o defeito antigo) ---"
[ "$NAV" != "$WS_NOME" ] && ok "nao devolveu '$WS_NOME'" \
  || nok "voltou a devolver o nome do workspace"

#
# A SEGUNDA PORTA DEIXOU DE EXISTIR, e este trecho mudou de alvo por causa disso.
#
# Ele conferia que a porta do navegador e a FEDERADA devolviam o mesmo nome, byte a byte --
# a melhor garantia possivel enquanto houvesse duas. A Etapa 1 apagou a federada: o navegador
# da Gestao pergunta direto a /api/menu, com a sessao que ja tem, porque os dois modulos vivem
# na mesma origem desde a Fase B.
#
# Entao a pergunta deixou de ser "as duas concordam?" e virou "so ha uma?". Concordancia era o
# melhor que se podia pedir de duas portas; uma porta so nao tem com quem discordar.
#
echo "=== 2. a porta FEDERADA nao existe mais ==="
# 401, e nao 404, e a resposta CERTA: o porteiro da federacao guarda o mount inteiro e recusa
# um token de navegador antes de o roteador chegar a dizer que a rota nao existe. A rota sumiu;
# quem responde primeiro e o porteiro. O que importa provar e que ela NAO SERVE MAIS a lista --
# qualquer coisa que nao seja 2xx satisfaz isso.
COD=$(curl -s -o /dev/null -w '%{http_code}' "$OP/api/federation/menu" -H "Authorization: Bearer $S")
case "$COD" in
  2*) nok "a porta federada do menu AINDA SERVE o menu ($COD)" ;;
  *)  ok "/api/federation/menu nao serve mais ($COD)" ;;
esac

echo "=== 3. o papel sai no vocabulario certo ==="
P_NAV=$(campo "$TMP/lugar_nav.json" usuario.papel_rotulo)
[ "$P_NAV" = "TITULAR" ] && ok "TITULAR" || nok "esperava TITULAR, veio '$P_NAV'"

echo "--- e nunca 'user', que era a palavra do banco vazando para a tela ---"
# Mesma armadilha da comparacao acima: com o campo ausente, "nao contem 'user'" e verdade e
# nao significa nada. So vale como prova se houver um papel para inspecionar.
case "$P_NAV" in
  AUSENTE|NULO|ERRO-JSON) nok "sem papel para inspecionar: '$P_NAV'" ;;
  *user*) nok "'user' ainda aparece como papel" ;;
  *) ok "nenhuma das portas escreve 'user'" ;;
esac

echo "=== 4. um OPERADOR e chamado de OPERADOR ==="
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
O_NAV=$(campo "$TMP/lugar_nav_op.json" usuario.papel_rotulo)
[ "$O_NAV" = "OPERADOR" ] && ok "OPERADOR" || nok "esperava OPERADOR, veio '$O_NAV'"

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
