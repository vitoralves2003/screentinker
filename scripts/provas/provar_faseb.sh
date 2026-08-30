#!/bin/sh
# Fase B — um endereco so.
#
# A pergunta que importa nao e "as paginas abrem?". E "TUDO esta na mesma origem?". Basta um
# endereco do menu apontar para outra porta para a travessia voltar a ser um login federado,
# com tela de "Entrando..." no meio do produto -- e o sintoma seria uma lentidao ocasional,
# nao um erro, entao ninguem descobriria olhando.
#
# O caso 6 e o unico aqui que derruba um container de proposito. Ele prova a defesa contra a
# falha classica deste tipo de proxy: `upstream` com nome de container e resolvido UMA VEZ,
# na partida, e passa a devolver 502 depois de qualquer rebuild -- uma falha que se le como
# "a Gestao caiu" quando a Gestao esta perfeitamente de pe.

UNI=http://127.0.0.1:3100
OP=http://127.0.0.1:3110
EMAIL=cliente@exemplo.invalid
SENHA='SenhaCliente#2026'

. "$(dirname "$0")/mfa_lib.sh"

falhas=0
ok()  { echo "  OK     $1"; }
nok() { echo "  FALHOU $1"; falhas=$((falhas+1)); }
http() { curl -s -o /dev/null -w '%{http_code}' "$1"; }

echo "=== 1. a Operacao continua na RAIZ ==="
# Nao e detalhe: as telas em campo apontam para a raiz. Se ela se mexesse, cada painel
# precisaria ser reconfigurado a mao, alguns pendurados em teto de padaria.
for p in /app /api/status; do
  C=$(http "$UNI$p")
  [ "$C" = "200" ] && ok "$p responde 200" || nok "$p respondeu $C"
done

echo "=== 2. a Gestao responde sob /gestao ==="
for p in /gestao /gestao/dashboard /gestao/clientes /gestao/contratos /gestao/financeiro; do
  C=$(http "$UNI$p")
  [ "$C" = "200" ] && ok "$p responde 200" || nok "$p respondeu $C"
done

echo "=== 3. a API da Gestao perde o prefixo antes de chegar nela ==="
# A API nao sabe que vive sob /gestao-api, e nao deveria saber. Se o prefixo passasse, ela
# responderia 404 em tudo -- entao um 401 aqui e a prova de que ela ENTENDEU a rota.
D=$(curl -s -X POST $UNI/gestao-api/auth/federated -H 'Content-Type: application/json' -d '{}')
echo "$D" | grep -q 'Unauthorized' \
  && ok "a API entendeu a rota (401 de autenticacao, nao 404 de caminho)" \
  || nok "resposta inesperada: $(echo "$D" | head -c 140)"

echo "=== 4. os estaticos do Next saem COM o prefixo, e respondem ==="
# Sem assetPrefix, os arquivos seriam pedidos em /_next/... na raiz -- territorio da
# Operacao, que responderia 404 em cada um. A pagina abriria sem estilo nenhum.
A=$(curl -s $UNI/gestao/entrar | grep -o '/gestao/_next/static[^"]*\.js' | head -1)
if [ -n "$A" ]; then
  ok "os estaticos vem prefixados ($A)"
  C=$(http "$UNI$A")
  [ "$C" = "200" ] && ok "e o arquivo responde 200" || nok "o estatico respondeu $C"
else
  nok "nao achei nenhum estatico com o prefixo -- assetPrefix nao pegou"
fi

echo "=== 5. TODO o menu vive numa origem so ==="
preparar_mfa "$EMAIL" "$SENHA"
S=$(entrar "$EMAIL" "$SENHA")
[ -n "$S" ] || { nok "nao autenticou"; echo; exit 1; }

MENU=$(curl -s $OP/api/menu -H "Authorization: Bearer $S")
FORA=$(echo "$MENU" | python3 -c "
import json,sys
m=json.load(sys.stdin)
alvos=[i['href'] for s in m['secoes'] for i in s['itens']]
alvos+=[i['href'] for i in m.get('transversais',[])]
alvos.append(m['inicio'])
print('\n'.join(h for h in alvos if not h.startswith('http://localhost:3100')))
" 2>/dev/null)

if [ -z "$FORA" ]; then
  ok "todos os destinos do menu, e o inicio, saem de http://localhost:3100"
else
  nok "estes ainda apontam para fora da origem unica:"
  echo "$FORA" | sed 's/^/           /'
fi

echo "=== 6. a travessia monta o endereco FINAL certo (prefixo uma vez so) ==="
# O caso que faltava, e que deixou um 404 passar ate a tela do cliente.
#
# Os casos acima conferem URLs soltas com curl, e todas respondiam 200. O defeito nascia na
# COMPOSICAO: a Operacao tira o caminho de uma URL do menu (/gestao/dashboard) e manda em
# &d=; o router do Next trabalha em coordenadas relativas ao basePath e acrescenta /gestao
# outra vez. Resultado: /gestao/gestao/dashboard -- um 404 que so aparece DEPOIS do login,
# quando a pessoa ja digitou senha e segunda etapa.
#
# Aqui a composicao inteira e refeita: o que a Operacao manda, o que a Gestao remove, o que
# o Next acrescenta. E o endereco final tem de existir.
BASE=/gestao
ORIGEM=$(echo "$MENU" | python3 -c "
import json,sys
m=json.load(sys.stdin)
alvos=[i['href'] for s in m['secoes'] for i in s['itens'] if i.get('modulo')=='gestao']
alvos.append(m['inicio'])
print(' '.join(alvos))
" 2>/dev/null)

[ -n "$ORIGEM" ] || nok "nao consegui ler os destinos da Gestao no menu"

for H in $ORIGEM; do
  # 1. o que a Operacao poe em &d= (o pathname da URL do menu)
  D=$(python3 -c "import sys;from urllib.parse import urlparse;print(urlparse(sys.argv[1]).path)" "$H")
  # 2. o que a pagina /entrar remove (o proprio basePath, se vier junto)
  case "$D" in
    "$BASE")   REL=/ ;;
    "$BASE"/*) REL="${D#$BASE}" ;;
    *)         REL="$D" ;;
  esac
  # 3. o que o router do Next acrescenta de volta
  FINAL="$BASE$REL"
  FINAL=$(echo "$FINAL" | sed 's#//*#/#g')
  C=$(http "$UNI$FINAL")
  if [ "$C" = "200" ]; then
    ok "$D -> $FINAL (200)"
  else
    nok "$D -> $FINAL respondeu $C -- o prefixo entrou errado"
  fi
done

echo "=== 7. as imagens de public/ saem COM o prefixo, e sao imagens ==="
# O caso que faltava, e que deixou toda a identidade visual quebrada em silencio.
#
# O next/image nao aplica o basePath ao src de um arquivo de public/, entao o navegador pedia
# /loop-player-logo.png -- que na raiz e territorio da OPERACAO. E ela respondia 200 COM HTML,
# a pagina dela, pelo roteamento de aplicacao de pagina unica.
#
# POR ISSO ESTE CASO OLHA O TIPO, E NAO O STATUS. Qualquer checagem de codigo HTTP passa nesse
# defeito com louvor: o servidor entregou algo, com sucesso. O que se rompeu foi o Content-Type.
IMGS=$(curl -s "$UNI/gestao" | grep -o 'src="/[^"]*\.png"' | sed 's/src="//;s/"//' | sort -u)
[ -n "$IMGS" ] || nok "a pagina de entrada nao referencia imagem nenhuma"

for I in $IMGS; do
  case "$I" in
    /gestao/*) ok "$I vem prefixada" ;;
    *) nok "$I SEM prefixo -- cai na Operacao e volta HTML"; continue ;;
  esac
  T=$(curl -s -o /dev/null -w '%{content_type}' "$UNI$I")
  case "$T" in
    image/*) ok "$I entrega $T" ;;
    *) nok "$I entrega $T, nao uma imagem" ;;
  esac
done

echo "=== 8. reconstruir um container NAO derruba o proxy ==="
# A falha que o `resolver` existe para impedir. Sem ele o nginx guarda o IP antigo e devolve
# 502 para um servico que esta de pe.
docker restart novo-gestao-web >/dev/null 2>&1
until [ "$(http $UNI/gestao)" != "000" ]; do sleep 2; done
i=0
while [ "$(http $UNI/gestao)" = "502" ] && [ $i -lt 15 ]; do sleep 2; i=$((i+1)); done
C=$(http "$UNI/gestao")
[ "$C" = "200" ] \
  && ok "a Gestao voltou pelo proxy sem reiniciar o proxy (HTTP $C)" \
  || nok "o proxy ficou preso no IP antigo (HTTP $C) -- o resolver nao esta valendo"

echo
[ "$falhas" = "0" ] && echo "FASE B: um endereco so, e ele e o mesmo para tudo" || echo "FASE B: $falhas falha(s)"
exit $falhas
