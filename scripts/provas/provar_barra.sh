#!/bin/sh
# Etapa 1 — a barra e a mesma nos dois modulos.
#
# A pergunta que importa nao e "os itens existem?". E "existe UMA lista?". Toda divergencia que
# apareceu neste projeto -- icone faltando, cor do tema claro, logotipo estourando, e o
# "Administracao" que aparecia DUAS VEZES para um administrador de plataforma -- nasceu de
# alguem manter uma segunda lista escrita a mao.
#
# Por isso os casos abaixo olham o que o SERVIDOR entrega, e nao o repositorio.

UNI=http://127.0.0.1:3100
OP=http://127.0.0.1:3110
EMAIL=cliente@exemplo.invalid
SENHA='SenhaCliente#2026'
PLATAFORMA=teste-ambiente-novo@exemplo.invalid
SENHA_PLAT='SenhaDeTeste#2026'

. "$(dirname "$0")/mfa_lib.sh"

falhas=0
ok()  { echo "  OK     $1"; }
nok() { echo "  FALHOU $1"; falhas=$((falhas+1)); }
TMP=${TMPDIR:-/tmp}

echo "=== 1. nenhum item aparece duas vezes ==="
# O bug concreto: "Administracao" vinha do menu servido E estava escrito a mao no rodape do
# HTML, apontando para a mesma rota. So um administrador de plataforma via -- que e justamente
# quem menos reclama.
preparar_mfa "$PLATAFORMA" "$SENHA_PLAT"
S=$(entrar "$PLATAFORMA" "$SENHA_PLAT")
case "$S" in *.*.*) : ;; *) echo "  FALHOU nao autenticou o admin de plataforma"; exit 1 ;; esac

curl -s "$OP/api/menu" -H "Authorization: Bearer $S" > "$TMP/menu_plat.json"
REP=$(python3 -c "
import json,sys
from collections import Counter
m=json.load(open(sys.argv[1],encoding='utf-8'))
todos=[i['rotulo'] for s in m['secoes'] for i in s['itens']]
todos+=[i['rotulo'] for i in m.get('transversais',[])]
todos+=[i['rotulo'] for i in m.get('rodape',[])]
print(','.join(k for k,v in Counter(todos).items() if v>1))" "$TMP/menu_plat.json" 2>/dev/null)
[ -z "$REP" ] && ok "nenhum rotulo repetido no menu servido" || nok "repetidos: $REP"

# E o HTML nao pode voltar a escrever o item a mao.
curl -s "$UNI/app" > "$TMP/app.html"
grep -q 'adminNavItem' "$TMP/app.html" \
  && nok "o HTML voltou a escrever o item de Administracao a mao" \
  || ok "o HTML nao escreve item de nav a mao"

echo "=== 2. o rodape vem do servidor, com a Ajuda ==="
python3 -c "
import json,sys
m=json.load(open(sys.argv[1],encoding='utf-8'))
r=m.get('rodape') or []
print('sim' if any(i['id']=='ajuda' for i in r) else 'nao')" "$TMP/menu_plat.json" 2>/dev/null | grep -q sim \
  && ok "o menu serve a Ajuda no rodape" || nok "sem Ajuda no rodape servido"

# Configuracoes NAO vem do servidor, e isso e deliberado: e a tela do proprio modulo, com rota
# local em cada lado. Se um dia vier, vira travessia desnecessaria.
python3 -c "
import json,sys
m=json.load(open(sys.argv[1],encoding='utf-8'))
alvos=[i['id'] for s in m['secoes'] for i in s['itens']]+[i['id'] for i in m.get('transversais',[])]+[i['id'] for i in (m.get('rodape') or [])]
print('sim' if 'configuracoes' in alvos else 'nao')" "$TMP/menu_plat.json" 2>/dev/null | grep -q nao \
  && ok "Configuracoes fica local, fora do menu servido" || nok "Configuracoes entrou no menu servido"

echo "=== 3. a Gestao alcanca a Ajuda que so a Operacao tinha ==="
AJUDA=$(python3 -c "
import json,sys
m=json.load(open(sys.argv[1],encoding='utf-8'))
for i in (m.get('rodape') or []):
    if i['id']=='ajuda': print(i['href'])" "$TMP/menu_plat.json" 2>/dev/null)
echo "  href: $AJUDA"
case "$AJUDA" in
  http*/app#/help) ok "aponta para a pagina de ajuda da Operacao" ;;
  *) nok "endereco inesperado" ;;
esac

echo "=== 4. recolher: um dono so, e o estado atravessa ==="
#
# ESTA SECAO MUDOU DE ALVO NA ETAPA 2, e a razao importa.
#
# Ela conferia que a Operacao TINHA um botao de recolher no index.html e que os dois lados
# guardavam o estado na mesma chave. Estava certa para o mundo em que existiam duas barras: o
# melhor que se podia pedir era que as duas concordassem.
#
# Agora existe uma. O botao e a chave se mudaram para components/loop-sidebar.js, e a pergunta
# deixou de ser "as duas concordam?" para virar "ha uma so?". Procurar o botao no index.html
# passou a acusar falha por uma remocao proposital -- e prova que grita a toa ensina a ignorar
# o vermelho, que e pior que nao ter prova.
#
# A verificacao completa vive em provar_barra_unica.sh. O que fica aqui e o fio que esta suite
# sempre puxou: o estado nao se perde ao atravessar.
#
COMP=$(curl -s "$UNI/components/loop-sidebar.js")

echo "$COMP" | grep -q 'loop_os_sidebar_collapsed'   && ok "o componente guarda o recolhimento"   || nok "o componente nao guarda o recolhimento"

echo "$COMP" | grep -q 'CHAVE_RECOLHIDA'   && ok "numa constante so, e nao espalhado"   || nok "a chave nao esta centralizada"

# E o fio que importa: a Gestao carrega ESSE arquivo, e nao um proprio. Sem isso, "ha um dono"
# seria verdade dentro da Operacao e mentira no produto.
curl -s "$UNI/gestao/dashboard" > "$TMP/ge_dash.html"
ACHOU=nao
grep -q '/components/loop-sidebar.js' "$TMP/ge_dash.html" && ACHOU=sim
for f in $(grep -o '/gestao/_next/static/chunks/[^"]*.js' "$TMP/ge_dash.html" | head -25); do
  [ "$ACHOU" = "sim" ] && break
  curl -s "$UNI$f" | grep -q '/components/loop-sidebar.js' && ACHOU=sim
done
[ "$ACHOU" = "sim" ]   && ok "a Gestao carrega o MESMO arquivo -- a preferencia atravessa junto"   || nok "a Gestao nao aponta para o componente compartilhado"

echo
[ "$falhas" = "0" ] && echo "BARRA: uma lista so, e o mesmo estado nos dois" \
  || echo "BARRA: $falhas falha(s)"
exit $falhas
