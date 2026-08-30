#!/bin/sh
# Etapa 3 -- existe UMA fileira de abas, e nao duas com os mesmos nomes em outra ordem.
#
# O DEFEITO, medido nos prints do Vitor:
#
#     Operacao   Conta · Registro · Empresa · … · Assinatura · Pessoas
#     Gestao     Empresa · … · Assinatura · Pessoas  |  Conta
#
# Nao era descuido: os dois lados faziam filter(modulo === o meu) -> aba e filter(o outro) ->
# link no fim. Cada um punha os seus primeiro, e a ordem servida nunca era respeitada COMO
# FILEIRA.
#
# Sem navegador sem cabeca nesta maquina, o argumento e o mesmo da barra e e mais forte que
# comparar telas: um renderizador so + a mesma lista na mesma ordem => a mesma fileira.

OP=http://127.0.0.1:3110
UNI=http://127.0.0.1:3100
EMAIL=cliente@exemplo.invalid
SENHA='SenhaCliente#2026'
REPO=/opt/novo-operacao
REPO_GE=/opt/novo-gestao/repo
PAGINA_GE="$REPO_GE/apps/web/src/app/configuracoes/page.tsx"

. "$(dirname "$0")/mfa_lib.sh"

falhas=0
ok()  { echo "  OK     $1"; }
nok() { echo "  FALHOU $1"; falhas=$((falhas+1)); }
TMP=${TMPDIR:-/tmp}

# Mesmo filtro de provar_barra_unica.sh: procurar a palavra acusa os proprios comentarios que
# EXPLICAM a remocao. Ver a nota extensa la; aqui vai a versao curta, e ela se prova antes de
# ser usada.
so_codigo() {
  awk '
    {
      resto = $0; saida = ""
      while (length(resto) > 0) {
        if (dentro) {
          p = index(resto, "*/")
          if (p == 0) { resto = "" } else { resto = substr(resto, p + 2); dentro = 0 }
        } else {
          if (resto ~ /^[ \t]*\/\//) { resto = ""; continue }
          p = index(resto, "/*")
          if (p == 0) { saida = saida resto; resto = "" }
          else { saida = saida substr(resto, 1, p - 1); resto = substr(resto, p + 2); dentro = 1 }
        }
      }
      if (saida ~ /[^ \t{}]/) print saida
    }
  '
}

no_banco() { docker exec novo-operacao node -e "$1" 2>/dev/null | tr -d '\r'; }

echo "=== 0. o filtro de comentario funciona ==="
AMOSTRA=$(printf '%s\n' \
  '/*' \
  ' * a <nav> de abas virou uma tag' \
  ' */' \
  '{/*' \
  '  as abasDaOperacao viravam links depois de um traco' \
  '*/}' \
  '  <nav className="fileira">' | so_codigo)
echo "$AMOSTRA" | grep -q '<nav className' && ok "mantem a linha de codigo" || nok "o filtro comeu codigo"
[ "$(echo "$AMOSTRA" | grep -c 'nav')" = "1" ] \
  && ok "e descarta os comentarios" \
  || nok "sobrou comentario: $(echo "$AMOSTRA" | grep -c 'nav') ocorrencias"

echo
echo "=== 1. nenhum dos dois desenha a propria fileira ==="
grep -q '<loop-settings-tabs' "$REPO/frontend/js/views/settings.js" \
  && ok "a Operacao monta o componente" || nok "a Operacao nao monta o componente"
grep -q '<LoopSettingsTabs' "$PAGINA_GE" \
  && ok "a Gestao monta o componente" || nok "a Gestao nao monta o componente"

# A marca da fileira antiga de cada lado.
so_codigo < "$REPO/frontend/js/views/settings.js" | grep -q 'class="settings-tabs"' \
  && nok "a fileira antiga da Operacao ainda esta escrita a mao" \
  || ok "a fileira antiga da Operacao saiu"
so_codigo < "$PAGINA_GE" | grep -q 'abasDaOperacao' \
  && nok "a Gestao ainda separa 'as do outro modulo'" \
  || ok "a Gestao nao separa mais as abas do outro modulo"

echo "--- e ninguem mantem uma segunda lista de abas ---"
# O TABS local da Operacao dizia quais abas existem, em outra ordem e com outros nomes que a
# lista servida. Enquanto as duas existiram, cada lado comecava pelas suas.
so_codigo < "$REPO/frontend/js/views/settings.js" | grep -qE '^const TABS = \[' \
  && nok "o TABS local da Operacao voltou" \
  || ok "a Operacao nao tem lista de abas propria"

echo
echo "=== 2. os dois carregam o MESMO arquivo ==="
TIPO=$(curl -s -o "$TMP/tabs.js" -w '%{content_type}' "$UNI/components/loop-settings-tabs.js")
BYTES=$(wc -c < "$TMP/tabs.js")
case "$TIPO" in
  *javascript*) [ "$BYTES" -gt 5000 ] && ok "servido ($TIPO, $BYTES bytes)" \
                                      || nok "javascript pequeno demais: $BYTES bytes" ;;
  *) nok "respondeu '$TIPO', nao javascript" ;;
esac
A=$(curl -s "$OP/components/loop-settings-tabs.js" | md5sum | cut -d' ' -f1)
B=$(curl -s "$UNI/components/loop-settings-tabs.js" | md5sum | cut -d' ' -f1)
[ -n "$A" ] && [ "$A" = "$B" ] && ok "byte a byte identico pelas duas rotas" \
                              || nok "difere conforme o caminho: $A x $B"
grep -q "'/components/loop-settings-tabs.js'" "$REPO_GE/apps/web/src/components/layout/loop-settings-tabs.tsx" \
  && ok "a Gestao aponta para o arquivo compartilhado" \
  || nok "a Gestao nao aponta para o compartilhado"

echo
echo "=== 3. as duas portas mandam a MESMA fileira, na MESMA ORDEM ==="
preparar_mfa "$EMAIL" "$SENHA"
S=$(entrar "$EMAIL" "$SENHA")
case "$S" in *.*.*) : ;; *) echo "  FALHOU nao autenticou $EMAIL"; exit 1 ;; esac

IDS=$(no_banco "
const {db}=require('/app/server/db/database');
const u=db.prepare('SELECT id FROM users WHERE email = ?').get('$EMAIL');
const w=db.prepare('SELECT id, organization_id FROM workspaces WHERE created_by = ?').get(u.id);
console.log(w.organization_id+' '+u.id);
")
ORG=$(echo "$IDS" | cut -d' ' -f1)
UID_=$(echo "$IDS" | cut -d' ' -f2)

fed() {
  no_banco "
const jwt=require('jsonwebtoken');
const config=require('/app/server/config');
console.log(jwt.sign({organizationId:'$ORG',papel:'TITULAR',email:'$EMAIL'},config.federationSecret,
  {algorithm:'HS256',audience:'operacao',issuer:'gestao',expiresIn:60}));
"
}

achatar() {
  python3 -c "
import json,sys
try: d=json.load(open('$1'))
except Exception: print('ERRO-JSON'); sys.exit(0)
for a in (d.get('abas') or []):
    print('|'.join([str(a.get('id')),str(a.get('rotulo')),str(a.get('href')),str(a.get('modulo'))]))
"
}

curl -s "$OP/api/configuracoes" -H "Authorization: Bearer $S" > "$TMP/ab_nav.json"
curl -s "$OP/api/federation/configuracoes" -H "Authorization: Bearer $(fed)" > "$TMP/ab_fed.json"
achatar "$TMP/ab_nav.json" > "$TMP/ab_nav.txt"
achatar "$TMP/ab_fed.json" > "$TMP/ab_fed.txt"

N=$(grep -c . "$TMP/ab_nav.txt" 2>/dev/null || echo 0)
if [ "$N" -lt 4 ]; then
  nok "a fileira veio com $N abas -- pouco demais para provar algo"
else
  ok "a fileira tem $N abas"
  # `diff` compara ORDEM, e nao so conteudo. Era exatamente a ordem que divergia: os dois lados
  # tinham as mesmas abas, cada um comecando pelas suas.
  if diff -q "$TMP/ab_nav.txt" "$TMP/ab_fed.txt" >/dev/null 2>&1; then
    ok "navegador e federada: identicas, na mesma ordem"
  else
    nok "as duas portas divergem:"
    diff "$TMP/ab_nav.txt" "$TMP/ab_fed.txt" | head -10 | sed 's/^/         /'
  fi
fi

echo
echo "=== 4. o REGISTRO DE ATIVIDADES segue quem e DONO, pelas duas portas ==="
#
# Era a aba que existia num lado so: a TELA da Operacao perguntava a /activity/available, e a
# tela da Gestao nao tinha a quem perguntar. Agora a lista servida ja chega decidida.
#
# `dono` NAO e o mesmo que TITULAR: todo dono e titular, nem todo titular e dono. Rebaixar o
# papel em vez do vinculo provaria a coisa errada.
#
ANTES=$(no_banco "
const {db}=require('/app/server/db/database');
const m=db.prepare('SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?').get('$ORG','$UID_');
console.log(m ? m.role : 'nenhum');
")
restaurar() {
  [ "$ANTES" = "nenhum" ] || no_banco "
const {db}=require('/app/server/db/database');
db.prepare('UPDATE organization_members SET role = ? WHERE organization_id = ? AND user_id = ?').run('$ANTES','$ORG','$UID_');
" >/dev/null
}
trap restaurar EXIT INT TERM

tem_atividade() { grep -c '^atividade|' "$1"; }

if [ "$ANTES" != "org_owner" ]; then
  nok "o fixture nao e dono da organizacao (papel: $ANTES) -- nao da para provar os dois lados"
else
  [ "$(tem_atividade "$TMP/ab_nav.txt")" = "1" ] && ok "dono, navegador: a aba aparece" \
    || nok "dono, navegador: a aba nao apareceu"
  [ "$(tem_atividade "$TMP/ab_fed.txt")" = "1" ] && ok "dono, federada: a aba aparece" \
    || nok "dono, federada: a aba nao apareceu"

  # deixa de ser dono, CONTINUANDO titular
  no_banco "
const {db}=require('/app/server/db/database');
db.prepare('UPDATE organization_members SET role = ? WHERE organization_id = ? AND user_id = ?').run('org_admin','$ORG','$UID_');
" >/dev/null

  S2=$(entrar "$EMAIL" "$SENHA")
  curl -s "$OP/api/configuracoes" -H "Authorization: Bearer $S2" > "$TMP/ab_nav2.json"
  curl -s "$OP/api/federation/configuracoes" -H "Authorization: Bearer $(fed)" > "$TMP/ab_fed2.json"
  achatar "$TMP/ab_nav2.json" > "$TMP/ab_nav2.txt"
  achatar "$TMP/ab_fed2.json" > "$TMP/ab_fed2.txt"

  [ "$(tem_atividade "$TMP/ab_nav2.txt")" = "0" ] && ok "so titular, navegador: a aba some" \
    || nok "so titular, navegador: a aba continua aparecendo"
  [ "$(tem_atividade "$TMP/ab_fed2.txt")" = "0" ] && ok "so titular, federada: a aba some" \
    || nok "so titular, federada: a aba continua aparecendo"

  # e a contraprova: o resto da fileira NAO sumiu junto -- senao "a aba some" seria verdade
  # porque a resposta inteira quebrou.
  R=$(grep -c . "$TMP/ab_nav2.txt")
  [ "$R" -ge 4 ] && ok "e as outras $R abas continuam la" \
                 || nok "a fileira inteira encolheu para $R -- a resposta quebrou"

  restaurar
fi

echo "--- sem e-mail no token, a porta federada nao ADIVINHA que e dono ---"
# Uma Gestao ainda nao atualizada nao manda o campo. Sumir uma aba de quem tem direito e chato;
# mostrar a um colega o registro de tudo o que os outros fizeram e outra coisa.
SEM=$(no_banco "
const jwt=require('jsonwebtoken');
const config=require('/app/server/config');
console.log(jwt.sign({organizationId:'$ORG',papel:'TITULAR'},config.federationSecret,
  {algorithm:'HS256',audience:'operacao',issuer:'gestao',expiresIn:60}));
")
curl -s "$OP/api/federation/configuracoes" -H "Authorization: Bearer $SEM" > "$TMP/ab_sem.json"
achatar "$TMP/ab_sem.json" > "$TMP/ab_sem.txt"
[ "$(tem_atividade "$TMP/ab_sem.txt")" = "0" ] \
  && ok "sem e-mail: a aba do dono nao aparece" \
  || nok "sem e-mail: a aba do dono apareceu mesmo assim"

echo
[ "$falhas" -eq 0 ] && echo "TUDO VERDE -- uma fileira so, na mesma ordem pelas duas portas" \
                    || echo "$falhas FALHA(S)"
echo "(pixel e alinhamento continuam precisando de olho humano: nao ha navegador aqui)"
exit "$falhas"
