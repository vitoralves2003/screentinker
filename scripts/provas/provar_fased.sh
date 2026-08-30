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

echo
[ "$falhas" = "0" ] && echo "FASE D: a mesma letra nos dois, e ela e a que aparece" || echo "FASE D: $falhas falha(s)"
exit $falhas
