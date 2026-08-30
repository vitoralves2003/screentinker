#!/bin/sh
# E1 — as abas de configuracoes que cada um ve.
#
# Duas perguntas, e as duas importam:
#
#   POR PAPEL. A tela da Gestao mostrava as sete abas para todo mundo, inclusive "Minha
#   assinatura", "Regua de cobranca" e "Usuarios" para um OPERADOR -- o papel cuja definicao
#   inteira e nao ver o Financeiro. O servidor recusa as acoes, entao o que se via eram portas
#   que nao abrem, que e pior do que portas que faltam.
#
#   POR PLANO. Um cliente Pro nao comprou Gestao e nao pode ver aba nenhuma dela; um Gestao
#   avulsa nao tem Operacao. Uma lista que ignore isso oferece um modulo que a pessoa nao tem.
#
# COMO SE REBAIXA O PAPEL NESTE PRODUTO, que custou duas rodadas descobrir:
#
# canAdmin (lib/permissions.js) e um OU de TRES fontes -- administrador de plataforma, papel
# na organizacao, papel no workspace. Basta uma delas para a pessoa ser TITULAR.
#
# Entao um teste que rebaixa so uma prova exatamente nada: na primeira tentativa mexi so no
# workspace e a lista nao mudou; na segunda mexi so na organizacao e ela nao mudou de novo.
# Nos dois casos a conclusao facil seria "o filtro nao funciona", e nos dois a conclusao
# estava errada -- o filtro funcionava e o teste e que nao rebaixava ninguem.

OP=http://127.0.0.1:3110
GE=http://127.0.0.1:3121
EMAIL=cliente@exemplo.invalid
SENHA='SenhaCliente#2026'

. "$(dirname "$0")/mfa_lib.sh"

falhas=0
ok()  { echo "  OK     $1"; }
nok() { echo "  FALHOU $1"; falhas=$((falhas+1)); }

TMP=${TMPDIR:-/tmp}

# Estado original, para devolver no fim. Uma prova que deixa a conta rebaixada quebra todas
# as outras suites que entram com ela.
ORIG_ORG=$(docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
const u=db.prepare('SELECT id FROM users WHERE email=?').get('$EMAIL');
const w=db.prepare('SELECT organization_id FROM workspaces WHERE created_by=?').get(u.id);
const m=db.prepare('SELECT role FROM organization_members WHERE organization_id=? AND user_id=?').get(w.organization_id,u.id);
console.log(m ? m.role : 'org_owner');
" 2>/dev/null | tr -d '\r')

ORIG_WS=$(docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
const u=db.prepare('SELECT id FROM users WHERE email=?').get('$EMAIL');
const w=db.prepare('SELECT id FROM workspaces WHERE created_by=?').get(u.id);
const m=db.prepare('SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?').get(w.id,u.id);
console.log(m ? m.role : 'workspace_admin');
" 2>/dev/null | tr -d '\r')

WS=$(docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
const u=db.prepare('SELECT id FROM users WHERE email=?').get('$EMAIL');
console.log(db.prepare('SELECT id FROM workspaces WHERE created_by=?').get(u.id).id);
" 2>/dev/null | tr -d '\r')

# por_papel() PAPEL_NA_ORG PAPEL_NO_WORKSPACE -- as duas, sempre, pelo motivo acima.
por_papel() {
  docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
const u=db.prepare('SELECT id FROM users WHERE email=?').get('$EMAIL');
const w=db.prepare('SELECT id,organization_id FROM workspaces WHERE created_by=?').get(u.id);
db.prepare('UPDATE organization_members SET role=? WHERE organization_id=? AND user_id=?').run('$1',w.organization_id,u.id);
db.prepare('UPDATE workspace_members SET role=? WHERE workspace_id=? AND user_id=?').run('$2',w.id,u.id);
" >/dev/null 2>&1
}

por_plano() {
  docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
db.prepare('UPDATE workspaces SET plan_id = ? WHERE id = ?').run('$1','$WS');
" >/dev/null 2>&1
}

restaurar() { por_papel "$ORIG_ORG" "$ORIG_WS"; por_plano master; }

# Le a lista de um arquivo, nao de echo: o JSON tem acentos e aspas, e o echo do sh e
# uma camada a mais que pode interpretar o que nao devia.
abas() { curl -s $OP/api/configuracoes -H "Authorization: Bearer $S" > "$TMP/abas.json"; }
tem()  { python3 -c "
import json,sys
d=json.load(open(sys.argv[1],encoding='utf-8'))
print('sim' if any(a['id']==sys.argv[2] for a in d['abas']) else 'nao')" "$TMP/abas.json" "$1" 2>/dev/null; }
quantas() { python3 -c "
import json,sys
print(len(json.load(open(sys.argv[1],encoding='utf-8'))['abas']))" "$TMP/abas.json" 2>/dev/null; }

preparar_mfa "$EMAIL" "$SENHA"
S=$(entrar "$EMAIL" "$SENHA")
case "$S" in *.*.*) : ;; *) echo "  FALHOU nao autenticou"; exit 1 ;; esac

echo "=== 1. TITULAR ve as abas de dinheiro e de pessoas ==="
por_papel org_owner workspace_admin; por_plano master; abas
for a in assinatura-fatura regua usuarios membros assinatura-plano; do
  [ "$(tem $a)" = "sim" ] && ok "titular ve '$a'" || nok "titular NAO ve '$a'"
done

echo "=== 2. OPERADOR nao ve nenhuma delas ==="
por_papel org_member editor; abas
for a in assinatura-fatura regua usuarios membros assinatura-plano; do
  [ "$(tem $a)" = "nao" ] && ok "operador nao ve '$a'" || nok "OPERADOR VE '$a' -- porta que nao abre"
done
# E continua vendo o que e dele: uma lista vazia seria outro defeito, nao a correcao.
[ "$(tem conta)" = "sim" ] && ok "operador continua vendo 'conta'" || nok "operador ficou sem aba nenhuma"

echo "=== 3. por PLANO: quem nao comprou o modulo nao ve as abas dele ==="
por_papel org_owner workspace_admin
por_plano pro;    abas
[ "$(tem usuarios)" = "nao" ] && [ "$(tem conta)" = "sim" ] \
  && ok "Pro: abas da Operacao, nenhuma da Gestao" || nok "Pro viu aba de Gestao"
por_plano free;   abas
[ "$(tem empresa)" = "nao" ] && ok "Free: nenhuma aba de Gestao" || nok "Free viu aba de Gestao"
por_plano gestao; abas
[ "$(tem conta)" = "nao" ] && [ "$(tem usuarios)" = "sim" ] \
  && ok "Gestao avulsa: abas da Gestao, nenhuma da Operacao" || nok "Gestao avulsa viu aba de Operacao"
por_plano master; abas
N=$(quantas)
[ "$N" -gt 8 ] 2>/dev/null && ok "Master ve os dois modulos ($N abas)" || nok "Master viu so $N abas"

echo "=== 4. a porta federada responde a MESMA lista ==="
# Se as duas portas divergirem, a tela muda de conteudo conforme o lado de onde se olha --
# que e o defeito inteiro que este endpoint existe para acabar.
T=$(curl -s -X POST $OP/api/auth/federation/gestao -H "Authorization: Bearer $S" \
      | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
curl -s -X POST $GE/auth/federated -H 'Content-Type: application/json' -d "{\"token\":\"$T\"}" \
  > "$TMP/sessao.json"
G=$(python3 -c "
import json,sys
try: print(json.load(open(sys.argv[1],encoding='utf-8')).get('accessToken',''))
except Exception: print('')" "$TMP/sessao.json" 2>/dev/null)

if [ -z "$G" ]; then nok "nao consegui uma sessao da Gestao para comparar"; else
  curl -s "$GE/dashboard/configuracoes" -H "Authorization: Bearer $G" > "$TMP/abas_ge.json"

  ids() { python3 -c "
import json,sys
try:
    d=json.load(open(sys.argv[1],encoding='utf-8'))
    print(','.join(sorted(a['id'] for a in d['abas'])))
except Exception: print('')" "$1" 2>/dev/null; }

  A=$(ids "$TMP/abas.json")      # como o navegador da Operacao pergunta
  B=$(ids "$TMP/abas_ge.json")   # como o navegador da Gestao pergunta
  echo "  Operacao: $A"
  echo "  Gestao:   $B"

  if [ -z "$A" ] || [ -z "$B" ]; then nok "nao consegui ler as duas listas"
  elif [ "$A" = "$B" ]; then ok "as duas portas devolvem a MESMA lista"
  else nok "DIVERGEM -- a tela mudaria de conteudo conforme o lado de onde se olha"; fi

  # E a lista da Gestao precisa marcar de quem e cada aba: sem isso ela nao sabe quais
  # desenhar e quais viram link para o outro modulo.
  M=$(python3 -c "
import json,sys
d=json.load(open(sys.argv[1],encoding='utf-8'))
print(','.join(sorted(set(a['modulo'] for a in d['abas']))))" "$TMP/abas_ge.json" 2>/dev/null)
  [ "$M" = "gestao,operacao" ] && ok "a lista marca os dois modulos ($M)" \
    || nok "modulos inesperados: '$M'"
fi

restaurar
echo
[ "$falhas" = "0" ] && echo "CONFIGURACOES: as abas seguem o papel e o plano" \
  || echo "CONFIGURACOES: $falhas falha(s)"
exit $falhas
