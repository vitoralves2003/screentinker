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

echo "=== 4. recolher existe nos DOIS, com o mesmo estado ==="
# A chave e a mesma de proposito: depois da Fase B os dois modulos vivem na mesma origem e
# dividem o localStorage, entao recolher num recolhe no outro. Se as chaves divergirem, a
# preferencia se perde ao atravessar -- e volta a haver duas barras parecidas em vez de uma.
grep -q 'sidebarRecolher' "$TMP/app.html" \
  && ok "a Operacao tem o botao de recolher" || nok "a Operacao nao tem o botao"

curl -s "$UNI/css/main.css" | grep -q 'sidebar-recolhida' \
  && ok "e o CSS do estado recolhido" || nok "sem CSS do estado recolhido"

CHAVE_OP=$(curl -s "$UNI/js/app.js" | grep -o "loop_os_sidebar_collapsed" | head -1)
CHAVE_GE=nao
for f in $(curl -s "$UNI/gestao/dashboard" | grep -o '/gestao/_next/static/chunks/[^"]*\.js' | head -25); do
  curl -s "$UNI$f" | grep -q 'loop_os_sidebar_collapsed' && { CHAVE_GE=loop_os_sidebar_collapsed; break; }
done
if [ "$CHAVE_OP" = "$CHAVE_GE" ] && [ -n "$CHAVE_OP" ]; then
  ok "as duas guardam o estado na MESMA chave ($CHAVE_OP)"
else
  nok "chaves diferentes: Operacao='$CHAVE_OP' Gestao='$CHAVE_GE' -- a preferencia se perde ao atravessar"
fi

echo
[ "$falhas" = "0" ] && echo "BARRA: uma lista so, e o mesmo estado nos dois" \
  || echo "BARRA: $falhas falha(s)"
exit $falhas
