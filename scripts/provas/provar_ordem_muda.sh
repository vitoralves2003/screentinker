#!/bin/sh
# A ORDEM DE EXIBIÇÃO MUDA — na tela, e o BANCO confirma.
#
# A prova de navegador move uma linha e confere que a tela obedece. Mas a lista muda ANTES da
# resposta do servidor, de propósito — então uma prova que só olhasse a tela aprovaria uma
# interface que reordena bonito e nunca grava. Quem desmente isso é o `sort_order`.
#
# Ela escolhe uma tela com pelo menos dois itens, guarda a ordem gravada, roda o navegador, e
# compara o banco antes e depois. No fim a prova devolve a ordem original — a de dentro do
# navegador também devolve, e esta confere que voltou de verdade.
#
# Uso:  TOKEN=<sessao> sh provar_ordem_muda.sh

PSQL="docker exec novo-gestao-postgres psql -U novo -d novo_gestao -tAc"

falhas=0
ok()  { echo "  ok    $1"; }
nok() { echo "  FALHA $1"; falhas=$((falhas+1)); }

[ -n "$TOKEN" ] || { echo "SEM SESSAO: passe TOKEN=..."; exit 1; }
UNI=${UNI:-https://beta.loopplayer.com.br/gestao}

echo "== achando uma tela com pelo menos dois itens =="
# A tela precisa ter lista PRÓPRIA com dois itens: sem dois, não há ordem que mude, e a prova
# passaria por vácuo dizendo que "a ordem está certa".
TELA=$($PSQL "SELECT d.id
  FROM devices d
  JOIN playlist_items pi ON pi.playlist_id = d.playlist_id
 WHERE d.playlist_id IS NOT NULL
 GROUP BY d.id
HAVING count(pi.id) >= 2
 LIMIT 1;")
[ -n "$TELA" ] || { echo "  SEM CENARIO: nenhuma tela tem dois itens -- nada a reordenar"; exit 3; }

NOME=$($PSQL "SELECT name FROM devices WHERE id = '$TELA';")
LISTA=$($PSQL "SELECT playlist_id FROM devices WHERE id = '$TELA';")
echo "  tela=$NOME"

# A ORDEM DOS ITENS QUE ESTA PROVA CONHECE, e não a da lista inteira.
#
# Ela roda contra uma tela DE VERDADE, do produto em uso. Na primeira execução o Vitor adicionou
# uma lista à mesma tela enquanto a prova rodava, e a comparação da lista inteira reprovou:
# "o banco ficou diferente" — um veredito assustador para o dono do produto usando o produto.
#
# Uma prova que roda contra dado vivo mede só o que ela mexe. Itens que apareçam no meio são
# alguém trabalhando, e não uma regressão.
ordem_dos_conhecidos() {
  if [ -z "$1" ]; then
    $PSQL "SELECT string_agg(id::text, ',' ORDER BY sort_order, id) FROM playlist_items WHERE playlist_id = '$LISTA';"
  else
    $PSQL "SELECT string_agg(id::text, ',' ORDER BY sort_order, id) FROM playlist_items WHERE playlist_id = '$LISTA' AND id IN ($1);"
  fi
}

ANTES=$(ordem_dos_conhecidos "")
echo "  ordem gravada antes: $ANTES"
[ -n "$ANTES" ] || { echo "  SEM CENARIO: a lista da tela veio vazia"; exit 3; }

echo ""
echo "======== a tela, num navegador ========"
docker run --rm --network host --user root -v "$(cd "$(dirname "$0")" && pwd):/p" \
  -e TOKEN="$TOKEN" -e UNI="$UNI" -e TELA="$TELA" \
  -e NODE_PATH=/usr/src/app/node_modules \
  --entrypoint node zenika/alpine-chrome:with-puppeteer /p/a_ordem_muda.js
saida=$?
[ "$saida" = "0" ] || { echo ""; echo "a prova de navegador reprovou"; exit $saida; }

echo ""
echo "== e o banco, que e quem manda =="
DEPOIS=$(ordem_dos_conhecidos "$ANTES")
echo "  ordem gravada depois: $DEPOIS"

# A prova de navegador termina devolvendo a ordem original. Então o banco tem de estar IGUAL ao
# começo -- e ter passado por uma mudança no meio, que a prova de dentro já verificou. Se ele
# nunca tivesse sido tocado, a asserção aqui também passaria: por isso a de dentro confere a
# troca, e esta confere a volta.
[ "$DEPOIS" = "$ANTES" ] && ok "a ordem gravada voltou ao original" || nok "o banco ficou diferente: $ANTES -> $DEPOIS"

# E o snapshot: a rota aplica no aparelho ao reordenar, então a lista publicada tem de conter os
# mesmos itens. Uma reordenação que grava e nao republica deixa a parede na ordem velha.
PUBLICADO=$($PSQL "SELECT CASE WHEN published_snapshot IS NULL THEN 'nulo' ELSE 'escrito' END FROM playlists WHERE id = '$LISTA';")
[ "$PUBLICADO" = "escrito" ] && ok "a lista continua publicada" || nok "o snapshot ficou $PUBLICADO"

echo ""
[ "$falhas" = "0" ] && echo "A ORDEM MUDA NA TELA E NO BANCO" || echo "$falhas FALHA(S)"
exit $falhas
