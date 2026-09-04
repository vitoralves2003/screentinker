#!/bin/sh
# C1 — o menu que o servidor define, conferido nos quatro planos.
#
# A pergunta que importa: trocar o plano no banco muda o menu, sem tocar em codigo. Se
# nao mudar, a barra esta decidindo por conta propria em algum lugar — que e exatamente
# o que este endpoint existe para impedir.

OP=http://127.0.0.1:3110
EMAIL=cliente@exemplo.invalid
SENHA='SenhaCliente#2026'
REPO=/opt/novo-operacao

. /tmp/mfa_lib.sh

falhas=0
ok()  { echo "  OK     $1"; }
nok() { echo "  FALHOU $1"; falhas=$((falhas+1)); }

WS=$(docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
const u=db.prepare('SELECT id FROM users WHERE email = ?').get('$EMAIL');
console.log(db.prepare('SELECT id FROM workspaces WHERE created_by = ?').get(u.id).id);
" 2>/dev/null | tr -d '\r')

S=$(entrar "$EMAIL" "$SENHA")

menu_com_plano() {
  docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
db.prepare('UPDATE workspaces SET plan_id = ? WHERE id = ?').run('$1','$WS');
" >/dev/null 2>&1
  curl -s $OP/api/menu -H "Authorization: Bearer $S"
}

echo "=== FREE — so Operacao, sem titulo de secao ==="
R=$(menu_com_plano free)
echo "$R" | grep -q '"id":"operacao"' && ok "tem a secao Operacao" || nok "sem Operacao"
echo "$R" | grep -q '"id":"gestao"'   && nok "mostrou Gestao para o Free" || ok "sem Gestao"
echo "$R" | grep -q '"titulo":null'    && ok "titulo omitido (uma secao so)" || nok "titulo presente com uma secao"
# Flip de 02/09: mesmo sem Gestao no plano, o inicio e a pagina React de Telas — a queda
# para app#/devices e por infraestrutura (gestaoUrl ausente), que no staging esta presente.
echo "$R" | grep -q '"inicio":"[^"]*/gestao/telas"' && ok "inicio nas Telas (React)" || nok "inicio inesperado"

echo "=== PRO — igual ao Free ==="
R=$(menu_com_plano pro)
echo "$R" | grep -q '"id":"gestao"' && nok "mostrou Gestao para o Pro" || ok "sem Gestao"

echo "=== MASTER — as duas secoes, com titulo ==="
R=$(menu_com_plano master)
echo "$R" | grep -q '"id":"operacao"' && ok "tem Operacao" || nok "sem Operacao"
echo "$R" | grep -q '"id":"gestao"'   && ok "tem Gestao"   || nok "sem Gestao"
echo "$R" | grep -q '"titulo":"Opera' && ok "titulos presentes (duas secoes)" || nok "titulo omitido com duas secoes"
echo "$R" | grep -q '"inicio":"[^"]*\/dashboard"' && ok "inicio no painel da Gestao" || nok "inicio nao mudou com o plano"

echo "=== GESTAO AVULSA — so Gestao ==="
R=$(menu_com_plano gestao)
echo "$R" | grep -q '"id":"operacao"' && nok "mostrou Operacao para a Gestao avulsa" || ok "sem Operacao"
echo "$R" | grep -q '"id":"gestao"'   && ok "tem Gestao" || nok "sem Gestao"
echo "$R" | grep -q '"atencao_telas":0' && ok "sem alerta de telas (nao tem telas)" || nok "alerta de telas num plano sem telas"

echo
echo "=== AS REGRAS QUE VALEM PARA TODOS ==="
R=$(menu_com_plano master)

echo "--- nenhum item carrega numero ---"
echo "$R" | grep -qE '"(contagem|count|badge|numero)"' && nok "algum item tem contagem" || ok "nenhuma contagem em item"

echo "--- Relatorios saiu da barra (por enquanto), mas a ROTA continua viva ---"
# Sair da barra nao e deixar de existir: #/reports abre por endereco salvo, como agenda,
# widgets, video walls e quiosque ja faziam. A prova cobre as duas metades, porque so a
# primeira transformaria "escondi o item" em "quebrei a pagina" sem ninguem notar.
echo "$R" | grep -q '"id":"relatorios"' && nok "Relatorios ainda esta na barra" || ok "Relatorios fora da barra"
grep -rq "case '#/reports'\|'#/reports'" "$REPO/frontend/js/app.js" 2>/dev/null \
  && ok "e a rota #/reports continua registrada" \
  || nok "a rota #/reports sumiu junto -- isso quebra endereco salvo"

echo "--- LAYOUTS segue o PLANO, e nao o papel de plataforma ---"
#
# Ele vivia nos transversais atras de `plataforma`, entao so o dono da plataforma via. Mas
# quem guarda POST /layouts no servidor e checkLayoutsEnabled, que pergunta
# plan.layouts_enabled. Todo cliente Pro e Master pagava por Layouts e nenhum achava a porta.
#
# Os quatro planos, medidos no banco: free=0, pro=1, master=1, gestao=0.
#
for par in "master:1" "pro:1" "free:0" "gestao:0"; do
  P=${par%:*}; ESPERA=${par#*:}
  RR=$(menu_com_plano "$P")
  TEM=0; echo "$RR" | grep -q '"id":"layouts"' && TEM=1
  if [ "$TEM" = "$ESPERA" ]; then
    ok "$P: layouts $([ "$ESPERA" = 1 ] && echo 'aparece' || echo 'nao aparece')"
  else
    nok "$P: esperava layouts=$ESPERA, veio $TEM"
  fi
done

R=$(menu_com_plano master)
echo "--- e fica DENTRO da secao Operacao, logo depois de Playlists ---"
echo "$R" | python3 -c "
import json,sys
d=json.load(sys.stdin)
op=[s for s in d['secoes'] if s['id']=='operacao']
if not op:
    print('  FALHOU nao ha secao Operacao'); sys.exit(0)
ids=[i['id'] for i in op[0]['itens']]
if 'layouts' not in ids:
    print('  FALHOU layouts fora da secao Operacao'); sys.exit(0)
if ids.index('layouts') == ids.index('playlists')+1:
    print('  OK     ordem: '+' , '.join(ids))
else:
    print('  FALHOU layouts nao esta logo depois de playlists: '+' , '.join(ids))
"

echo "--- e nao aparece DUAS vezes para quem e admin de plataforma ---"
# O defeito exato que a barra servida veio encerrar: 'Administracao' vinha do menu E estava
# escrito a mao no rodape, aparecendo duas vezes so para quem menos reclama. Layouts agora e
# empurrado de um lugar so; empurrar tambem nos transversais repetiria a historia.
N=$(echo "$R" | grep -o '"id":"layouts"' | wc -l)
[ "$N" -le 1 ] && ok "layouts aparece $N vez" || nok "layouts aparece $N vezes no mesmo menu"

echo "--- nao existe item Inicio (o logo faz esse papel) ---"
echo "$R" | grep -qiE '"rotulo":"In.cio"' && nok "existe item Inicio" || ok "sem item Inicio"

echo "--- o alerta de telas NAO e mais contado aqui ---"
# As telas mudaram de casa no corte de 03/09: /api/devices e servido pelo Postgres da Gestao.
# O que sobrou neste SQLite foram linhas de semente, e a pilula dizia "2 telas precisam de
# atencao" enquanto a lista, servida pela outra casa, respondia "Nenhuma tela neste filtro".
# Um alerta que leva a uma pagina vazia ensina o leitor que ele mente, justamente antes da noite
# em que uma tela morre de verdade.
# A barra passou a perguntar a /api/resumo/telas (mesma origem, pelo navegador), e este campo e 0.
A=$(echo "$R" | sed -E 's/.*"atencao_telas":([0-9]+).*/\1/')
[ "$A" = "0" ] && ok "o menu nao conta mais telas em atencao (diz $A)" || nok "o menu ainda conta: $A"
BARRA="$(dirname "$0")/../../frontend/components/loop-sidebar.js"
if grep -q "resumo/telas" "$BARRA"; then
  ok "a barra busca a contagem em /api/resumo/telas"
else
  nok "a barra nao busca a contagem na casa nova -- a pilula ficaria muda para sempre"
fi

echo "--- sem autenticacao, recusa ---"
COD=$(curl -s -o /dev/null -w '%{http_code}' $OP/api/menu)
[ "$COD" = "401" ] && ok "recusado (401)" || nok "respondeu $COD"

docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
db.prepare('UPDATE workspaces SET plan_id = ? WHERE id = ?').run('master','$WS');
" >/dev/null 2>&1

echo
[ "$falhas" = "0" ] && echo "C1 FECHADO" || echo "$falhas CASO(S) FALHARAM"
exit $falhas
