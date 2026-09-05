#!/bin/sh
# A TELA DO PORTAL, num navegador de verdade — planta, mede duas vezes, e limpa.
#
# Ela roda `portal_na_tela.js` DUAS vezes contra o mesmo cenário, com o vínculo plantado no meio:
#
#   1ª  sem vínculo  a tela precisa DIZER que esta conta não tem portal
#   2ª  com vínculo  a tela precisa mostrar o contrato do cliente A, e só ele
#
# A primeira existe porque uma prova que só olha a tela com permissão aprovaria um portal que
# mostra tudo para todo mundo — e porque o "falha fechado" do servidor não vale nada se a tela
# não o traduzir em palavras.
#
# Uso:  TOKEN=<sessao> sh provar_portal_na_tela.sh

. "$(dirname "$0")/portal_cenario.sh"

[ -n "$TOKEN" ] || { echo "SEM SESSAO: passe TOKEN=..."; exit 1; }
UNI=${UNI:-https://beta.loopplayer.com.br/gestao}

cenario_quem
trap 'cenario_limpar; echo "  cenario removido"' EXIT
cenario_limpar

echo "== plantando dois clientes e um contrato ativo para cada =="
cenario_plantar
echo "  contrato A=$KA (cliente A)"
echo "  contrato B=$KB (o vizinho, que nao pode aparecer)"

# --user root porque a imagem roda como chrome e o volume vem do host; --network host para
# alcançar o proxy pelo mesmo endereço que um navegador de verdade usaria.
#
# O TOKEN vai como ARGUMENTO, e não da variável do ambiente: desde 05/09 as duas passagens usam
# sessões diferentes — a primeira, nenhuma; a segunda, a do portal, que só existe depois do
# vínculo. Uma variável só para as duas faria a primeira passagem levar a sessão da segunda.
rodar() {
  docker run --rm --network host --user root -v "$(cd "$(dirname "$0")" && pwd):/p" \
    -e TOKEN="$2" -e UNI="$UNI" -e FASE="$1" \
    -e NODE_PATH=/usr/src/app/node_modules \
    --entrypoint node zenika/alpine-chrome:with-puppeteer /p/portal_na_tela.js
}

falhas=0
echo ""
echo "======== 1ª passagem: SEM sessao de portal ========"
# Sem vínculo não há como obter sessão do portal — então a passagem roda SEM token, que é
# exatamente a situação de quem abre /portal sem ter entrado.
rodar sem "" || falhas=$((falhas+1))

echo ""
echo "== plantando o vinculo de ANUNCIANTE no cliente A =="
cenario_vincular
echo "  vinculos=$VINC"
cenario_sessao_do_portal

echo ""
echo "======== 2ª passagem: COM a sessao do portal ========"
rodar com "$TOKEN_PORTAL" || falhas=$((falhas+1))

echo ""
[ "$falhas" = "0" ] && echo "A TELA DO PORTAL PASSOU NAS DUAS PASSAGENS" || echo "$falhas PASSAGEM(NS) REPROVADA(S)"
exit $falhas
