#!/bin/sh
# O BLOCO DE WORKSPACE — de quem são os dados desta tela.
#
# A pergunta que importa não é "o nome aparece?". É "num acesso de suporte, as DUAS barras
# dizem que é suporte, e nomeiam o CLIENTE e não quem está atendendo?".
#
# Um administrador de plataforma alcança o workspace de um cliente e passa a ver contratos e
# dinheiro que não são dele. As telas são idênticas nos dois casos. O erro que isto existe
# para impedir não é ler a tela errada -- é AGIR nela: cobrar, cancelar, mandar mensagem em
# nome de quem não pediu.
#
# Por isso cada caso aqui compara o que as duas barras dizem, e não apenas se dizem algo.

OP=http://127.0.0.1:3110
GE=http://127.0.0.1:3121
CLIENTE=cliente@exemplo.invalid
SENHA_CLIENTE='SenhaCliente#2026'
SUPORTE=suporte@loop.invalid
SENHA_SUPORTE='SenhaSuporte#2026'

. "$(dirname "$0")/mfa_lib.sh"

falhas=0
ok()  { echo "  OK     $1"; }
nok() { echo "  FALHOU $1"; falhas=$((falhas+1)); }

# campo() CAMINHO  <- lê um campo do JSON na entrada padrão, ou vazio se não houver
campo() { python3 -c "import json,sys
try:
    d=json.load(sys.stdin)
    w=d.get('workspace') or {}
    print(w.get('$1',''))
except Exception: print('')" 2>/dev/null; }

# barras() TOKEN_OPERACAO -> imprime 'nomeOp|suporteOp|nomeGe|suporteGe'
barras() {
  _s=$1
  _mo=$(curl -s $OP/api/menu -H "Authorization: Bearer $_s")
  _t=$(curl -s -X POST $OP/api/auth/federation/gestao -H "Authorization: Bearer $_s" \
        | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  _g=$(curl -s -X POST $GE/auth/federated -H 'Content-Type: application/json' \
        -d "{\"token\":\"$_t\"}" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("accessToken",""))
except Exception: print("")' 2>/dev/null)
  _mg=$(curl -s $GE/dashboard/menu -H "Authorization: Bearer $_g")
  printf '%s|%s|%s|%s' \
    "$(echo "$_mo" | campo nome)" "$(echo "$_mo" | campo suporte)" \
    "$(echo "$_mg" | campo nome)" "$(echo "$_mg" | campo suporte)"
}

echo "=== 1. sessao NORMAL: o cliente ve o proprio nome, sem marca de suporte ==="
preparar_mfa "$CLIENTE" "$SENHA_CLIENTE"
S=$(entrar "$CLIENTE" "$SENHA_CLIENTE")
case "$S" in *.*.*) : ;; *) echo "  FALHOU nao autenticou o cliente"; exit 1 ;; esac

R=$(barras "$S")
N_OP=$(echo "$R" | cut -d'|' -f1); S_OP=$(echo "$R" | cut -d'|' -f2)
N_GE=$(echo "$R" | cut -d'|' -f3); S_GE=$(echo "$R" | cut -d'|' -f4)
echo "  Operacao: '$N_OP' (suporte=$S_OP)   Gestao: '$N_GE' (suporte=$S_GE)"

[ -n "$N_OP" ] && ok "a barra da Operacao nomeia o workspace" || nok "sem nome na Operacao"
[ -n "$N_GE" ] && ok "a barra da Gestao nomeia o workspace"   || nok "sem nome na Gestao"
[ "$S_OP" = "False" ] && ok "Operacao NAO marca suporte numa sessao normal" || nok "Operacao marcou suporte sem ser: '$S_OP'"
[ "$S_GE" = "False" ] && ok "Gestao NAO marca suporte numa sessao normal"   || nok "Gestao marcou suporte sem ser: '$S_GE'"

echo "=== 2. acesso de SUPORTE: as duas dizem que e suporte, e nomeiam o CLIENTE ==="
WS=$(docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
const u=db.prepare('SELECT id FROM users WHERE email=?').get('$CLIENTE');
console.log(db.prepare('SELECT id FROM workspaces WHERE created_by=?').get(u.id).id);
" 2>/dev/null | tr -d '\r')

preparar_mfa "$SUPORTE" "$SENHA_SUPORTE"
SUP=$(entrar "$SUPORTE" "$SENHA_SUPORTE")
case "$SUP" in *.*.*) : ;; *) echo "  FALHOU nao autenticou o suporte"; exit 1 ;; esac

# Trocar de workspace emite um token NOVO -- e e por isso que a travessia seguinte leva o
# tenant certo sem ninguem passar header nenhum.
NOVO=$(curl -s -X POST $OP/api/auth/switch-workspace -H "Authorization: Bearer $SUP" \
        -H 'Content-Type: application/json' -d "{\"workspace_id\":\"$WS\"}" \
        | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("token",""))
except Exception: print("")' 2>/dev/null)
case "$NOVO" in *.*.*) ok "o suporte entrou no workspace do cliente" ;;
  *) nok "nao consegui trocar de workspace"; echo; exit 1 ;; esac

R=$(barras "$NOVO")
N_OP=$(echo "$R" | cut -d'|' -f1); S_OP=$(echo "$R" | cut -d'|' -f2)
N_GE=$(echo "$R" | cut -d'|' -f3); S_GE=$(echo "$R" | cut -d'|' -f4)
echo "  Operacao: '$N_OP' (suporte=$S_OP)   Gestao: '$N_GE' (suporte=$S_GE)"

[ "$S_OP" = "True" ] && ok "a Operacao AVISA que e acesso de suporte" || nok "a Operacao nao avisa: '$S_OP'"
[ "$S_GE" = "True" ] && ok "a Gestao AVISA que e acesso de suporte"   || nok "a Gestao nao avisa: '$S_GE'"

# A metade que erra caro: mostrar o nome de quem ATENDE em vez de quem e ATENDIDO. Quem
# atende sabe que e ele; o que ele precisa ler na tela e de quem sao os numeros.
echo "$N_OP" | grep -qi 'suporte' && nok "a Operacao nomeou QUEM ATENDE, nao o cliente" \
  || ok "a Operacao nomeia o cliente, nao quem atende"
echo "$N_GE" | grep -qi 'suporte' && nok "a Gestao nomeou QUEM ATENDE, nao o cliente" \
  || ok "a Gestao nomeia o cliente, nao quem atende"

echo "=== 3. as duas barras falam do MESMO cliente ==="
# Divergir aqui seria o pior caso possivel: dois modulos abertos lado a lado, cada um
# dizendo que voce esta noutra conta.
O_ORG=$(curl -s $OP/api/menu -H "Authorization: Bearer $NOVO" | campo organizacao)
G_ORG=$(curl -s $GE/dashboard/menu -H "Authorization: Bearer $(curl -s -X POST $GE/auth/federated \
        -H 'Content-Type: application/json' -d "{\"token\":\"$(curl -s -X POST $OP/api/auth/federation/gestao \
        -H "Authorization: Bearer $NOVO" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')\"}" \
        | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("accessToken",""))
except Exception: print("")' 2>/dev/null)" | campo organizacao)
echo "  Operacao: '$O_ORG'   Gestao: '$G_ORG'"
if [ -z "$O_ORG" ] || [ -z "$G_ORG" ]; then nok "nao consegui ler a organizacao dos dois lados"
elif [ "$O_ORG" = "$G_ORG" ]; then ok "as duas dizem a mesma organizacao"
else nok "DIVERGEM: '$O_ORG' x '$G_ORG'"; fi

echo
[ "$falhas" = "0" ] && echo "WORKSPACE: as duas barras dizem de quem sao os dados, e concordam" \
  || echo "WORKSPACE: $falhas falha(s)"
exit $falhas
