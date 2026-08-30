#!/bin/sh
# Fase D — uma aparencia so.
#
# A pergunta que importa nao e "a fonte foi carregada?". E "a fonte carregada e a fonte
# USADA?". A Gestao passou o projeto inteiro baixando onze arquivos do Geist a cada visita e
# renderizando em Arial, porque o body ainda tinha o padrao do create-next-app. Ninguem
# percebeu: a pagina carregava, o texto aparecia, e a conta de banda nao reclama.
#
# Uma checagem que so olha se o arquivo existe teria passado nesse bug com louvor.

UNI=http://127.0.0.1:3100

falhas=0
ok()  { echo "  OK     $1"; }
nok() { echo "  FALHOU $1"; falhas=$((falhas+1)); }

echo "=== 1. a Operacao serve a fonte ela mesma ==="
for f in /assets/fonts/geist-latin.woff2 /assets/fonts/geist-latin-ext.woff2; do
  C=$(curl -s -o /dev/null -w '%{http_code}' "$UNI$f")
  T=$(curl -s -o /dev/null -w '%{content_type}' "$UNI$f")
  if [ "$C" = "200" ] && [ "$T" = "font/woff2" ]; then ok "$f (200, font/woff2)"
  else nok "$f respondeu $C / $T"; fi
done

echo "=== 2. e nao busca de fora ==="
# Uma rede de cliente que so libera o nosso dominio transformaria isto numa tela sem
# tipografia -- e a falha e silenciosa, porque a pagina carrega assim mesmo.
H=$(curl -s $UNI/app)
echo "$H" | grep -q 'fonts.googleapis.com\|fonts.gstatic.com' \
  && nok "a pagina ainda busca fonte no Google" \
  || ok "nenhuma requisicao de fonte a terceiros"

echo "=== 3. o CSS PEDE a fonte, e nao so a declara ==="
# O bug da Gestao em miniatura: declarar @font-face e nao usar a familia em lugar nenhum.
curl -s $UNI/css/fonts.css | grep -q "@font-face" && ok "fonts.css declara a familia" || nok "sem @font-face"
curl -s $UNI/css/reset.css | grep -q "font-family: 'Geist'" \
  && ok "reset.css usa Geist no corpo da pagina" \
  || nok "a familia e declarada e nunca usada -- exatamente o bug que isto existe para pegar"

echo "=== 4. a reserva existe ==="
# Sem ela, um woff2 que nao chegue derruba o texto para a fonte serifada do navegador.
curl -s $UNI/css/reset.css | grep -q "'Geist', -apple-system" \
  && ok "a pilha do sistema fica atras como reserva" \
  || nok "sem reserva: uma falha de rede viraria Times New Roman"

echo "=== 5. a Gestao renderiza EM Geist, nao so o baixa ==="
CSS=$(curl -s $UNI/gestao/entrar | grep -o '/gestao/_next/static/chunks/[^"]*\.css' | head -5)
[ -n "$CSS" ] || nok "nao encontrei o CSS da Gestao"
ACHOU_ARIAL=0; ACHOU_GEIST=0
for f in $CSS; do
  C=$(curl -s "$UNI$f")
  echo "$C" | grep -q 'font-family:Arial' && ACHOU_ARIAL=1
  echo "$C" | grep -q 'font-family:var(--font-geist-sans)' && ACHOU_GEIST=1
done
[ "$ACHOU_GEIST" = "1" ] && ok "o corpo da Gestao pede Geist" || nok "o corpo da Gestao nao pede Geist"
[ "$ACHOU_ARIAL" = "0" ] && ok "e Arial nao voltou" || nok "Arial voltou ao corpo -- a fonte esta sendo baixada a toa de novo"

echo "=== 6. todo item do menu tem desenho, e desenhos DIFERENTES ==="
# As duas metades do bug de icones, cada uma com sua checagem.
#
# Faltar icone era o que acontecia na Gestao: o mapa dela so cobria os itens dela, e Telas,
# Arquivos, Playlists e Relatorios caiam todos num icone de documento -- tres coisas
# diferentes com o mesmo desenho, o que e pior que nenhum desenho, porque parece intencional.
#
# Desenhos repetidos e a mesma doenca vista pelo outro lado, e nao da para pegar contando:
# so comparando o traco de cada um com o de todos os outros.
. "$(dirname "$0")/mfa_lib.sh"
preparar_mfa cliente@exemplo.invalid 'SenhaCliente#2026' >/dev/null 2>&1
SS=$(entrar cliente@exemplo.invalid 'SenhaCliente#2026')

if ! echo "$SS" | grep -qE '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.'; then
  nok "nao autenticei para ler o menu"
else
  R=$(curl -s http://127.0.0.1:3110/api/menu -H "Authorization: Bearer $SS" | python3 -c '
import json,sys,hashlib
m=json.load(sys.stdin)
itens=[i for s in m["secoes"] for i in s["itens"]]+m.get("transversais",[])
sem=[i["rotulo"] for i in itens if not i.get("icone")]
por={}
for i in itens:
    if i.get("icone"):
        por.setdefault(hashlib.md5(i["icone"].encode()).hexdigest(),[]).append(i["rotulo"])
rep=[v for v in por.values() if len(v)>1]
print(len(itens), "|", ",".join(sem), "|", ";".join(",".join(v) for v in rep))
' 2>/dev/null)

  N=$(echo "$R" | cut -d'|' -f1 | tr -d ' ')
  SEM=$(echo "$R" | cut -d'|' -f2 | tr -d ' ')
  REP=$(echo "$R" | cut -d'|' -f3 | tr -d ' ')

  [ -n "$N" ] && [ "$N" -gt 0 ] 2>/dev/null \
    && ok "o menu trouxe $N itens" || nok "nao consegui ler os itens do menu"
  [ -z "$SEM" ] && ok "nenhum item sem desenho" || nok "sem desenho: $SEM"
  [ -z "$REP" ] && ok "nenhum desenho repetido entre itens" || nok "mesmo desenho em: $REP"
fi

echo "=== 7. um nome so: Loop Player ==="
# Dois nomes na mesma sessao e a divergencia que mais grita "sao dois produtos", e nenhuma
# quantidade de cor, letra e icone compartilhados desfaz isso enquanto os nomes discordam.
#
# O titulo da aba entra aqui de proposito: os dois modulos ficam abertos lado a lado, e a aba
# e a unica coisa que os distingue quando estao minimizados.
for p in /gestao /gestao/dashboard; do
  curl -s "$UNI$p" > /tmp/fased_pagina.html
  T=$(grep -o '<title>[^<]*</title>' /tmp/fased_pagina.html | head -1 | sed 's/<[^>]*>//g')
  case "$T" in
    *"Loop Player"*) ok "$p: a aba diz '$T'" ;;
    *) nok "$p: a aba diz '$T'" ;;
  esac
  N=$(grep -c 'Loop OS' /tmp/fased_pagina.html)
  [ "$N" = "0" ] && ok "$p: nenhum 'Loop OS' sobrou" || nok "$p: ainda tem $N 'Loop OS'"
done

# O logotipo tem de ser o arquivo da Operacao, e nao um segundo desenho com o nome novo.
C=$(curl -s -o /dev/null -w '%{http_code}' "$UNI/gestao/loop-player-logo.png")
[ "$C" = "200" ] && ok "o logotipo do Loop Player e servido pela Gestao" || nok "logotipo respondeu $C"

echo
[ "$falhas" = "0" ] && echo "FASE D: a mesma letra, os mesmos icones e um nome so" || echo "FASE D: $falhas falha(s)"
exit $falhas
