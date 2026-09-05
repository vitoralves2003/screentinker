#!/bin/sh
# O RECORTE DO PORTAL FILTRA? — contra o servidor de verdade.
#
# `portal_do_anunciante.js`, ao lado desta, confere que as rotas subiram e que quem não tem
# vínculo é recusado. Ela NÃO responde a pergunta que importa num portal: um anunciante amarrado
# ao cliente A alcança o contrato do cliente B da MESMA organização? É o defeito clássico deste
# tipo de tela, e o único jeito honesto de verificá-lo é pedir o contrato do vizinho com a
# sessão dele — o que exige dois clientes com contrato ativo, que o staging não tem por acaso.
#
# O cenário é plantado por `portal_cenario.sh`, compartilhado com a prova de navegador. As
# armadilhas do plantio estão documentadas lá.
#
# Uso:  BASE=https://beta.loopplayer.com.br TOKEN=<sessao> sh provar_portal_recorte.sh

. "$(dirname "$0")/portal_cenario.sh"

falhas=0
ok()  { echo "  ok    $1"; }
nok() { echo "  FALHA $1"; falhas=$((falhas+1)); }

[ -n "$TOKEN" ] || { echo "SEM SESSAO: passe TOKEN=..."; exit 1; }
BASE=${BASE:-https://beta.loopplayer.com.br}

# ── a guarda de alcance, e por que ela existe ───────────────────────────────────────────────
# Sem BASE definido, o curl chamava "/api/portal/contratos" sem servidor nenhum e devolvia o
# código 000 — que não é 200 nem 403 nem 404, então TODAS as comparações reprovavam. A prova
# acusou sete falhas num produto intacto, e "7 FALHA(S) no portal" é indistinguível de um portal
# quebrado. Uma prova que não alcança o servidor não reprova: ela PARA.
ALCANCE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/portal/contratos")
[ "$ALCANCE" = "000" ] && { echo "SEM SERVIDOR EM $BASE (curl devolveu 000) -- a prova nao mede nada assim"; exit 4; }

cenario_quem
echo "== a pessoa e a organizacao dela =="
echo "  usuario=$UID_  org=$ORG"

# Limpa mesmo se algo abaixo falhar: um vínculo esquecido é uma porta aberta, e um contrato
# esquecido é ruído para sempre.
trap 'cenario_limpar; echo "  cenario removido"' EXIT
cenario_limpar

echo "== plantando dois clientes e um contrato ativo para cada =="
cenario_plantar
echo "  contrato A=$KA"
echo "  contrato B=$KB"

echo ""
echo "== antes do vinculo, a PORTA recusa =="
# Esta medição tem de vir ANTES do vínculo existir. Um portal que responde a todo mundo passaria
# por pronto se a prova só olhasse depois de amarrar a permissão.
#
# O QUE MUDOU EM 05/09: o portal ganhou porta própria. Até ontem esta linha pedia
# `/api/portal/contratos` com a sessão do assinante e media o 403 do FuncaoGuard; hoje o
# `PortalAuthGuard` recusa aquele token antes de chegar lá, e a recusa por FALTA DE VÍNCULO
# passou a morar na entrada. Medir a rota aqui daria 401 sempre — inclusive com vínculo — e a
# asserção viraria decoração: verde sem tocar no mecanismo que ela nomeia.
COD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/portal/entrar" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"senha\":\"${SENHA_DO_PORTAL:-SenhaCliente#2026}\"}")
[ "$COD" = "401" ] && ok "sem vinculo de anunciante, a porta nao abre: 401" || nok "sem vinculo a porta respondeu $COD"

echo ""
echo "== plantando o vinculo de ANUNCIANTE no cliente A =="
cenario_vincular
[ "$VINC" = "1" ] && ok "vinculo plantado" || nok "esperava 1 vinculo, achei $VINC"
cenario_sessao_do_portal

echo ""
echo "== o portal, com o vinculo =="
R=$(curl -s "$BASE/api/portal/contratos" -H "$PAUTH")
echo "  resposta: $(echo "$R" | head -c 260)"
echo "$R" | grep -q "PROVA-A" && ok "o contrato do cliente A aparece" || nok "o contrato do cliente A NAO aparece"
echo "$R" | grep -q "PROVA-B" && nok "o do cliente B VAZOU para o portal" || ok "o do cliente B nao aparece"
# O portal existe para o anunciante mandar mídia, não para auditar quem o atende. Valor e parcela
# são a relação comercial do assinante, e o servidor não os devolve — isto prova que continua assim.
echo "$R" | grep -qiE '"totalValue"|"installment"|"downPayment"' && nok "dinheiro vazou na resposta" || ok "nenhum campo de dinheiro na resposta"
echo "$R" | grep -q '"limiteDeMidias":3' && ok "o limite de midias viaja" || nok "o limite de midias nao veio"

echo ""
echo "== pedindo o contrato do vizinho pelo id =="
# 404 e não 403 de propósito: "existe mas não é seu" já entrega que existe.
COD=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/portal/contratos/$KB" -H "$PAUTH")
[ "$COD" = "404" ] && ok "404, e nao 403" || nok "respondeu $COD"
COD=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/portal/contratos/$KB/midias" -H "$PAUTH")
[ "$COD" = "404" ] && ok "as midias do vizinho tambem: 404" || nok "midias do vizinho responderam $COD"

echo ""
echo "== e o proprio contrato abre =="
COD=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/portal/contratos/$KA" -H "$PAUTH")
[ "$COD" = "200" ] && ok "o contrato dele responde 200" || nok "o proprio contrato respondeu $COD"
COD=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/portal/contratos/$KA/midias" -H "$PAUTH")
[ "$COD" = "200" ] && ok "e as midias dele tambem" || nok "as midias dele responderam $COD"

echo ""
echo "== e tirar o vinculo derruba a sessao que ja estava aberta =="
# A pergunta que a porta própria abriu, e que a prova anterior não tinha como fazer.
#
# O token do portal vale 12h. Se o guarda confiasse nele, revogar o acesso de um anunciante só
# valeria no dia seguinte — e "tirei o acesso dele" seria mentira durante meio dia, sem nada na
# tela dizendo isso. O `FuncaoGuard` relê o vínculo a cada requisição justamente para que a
# revogação valha agora; esta linha é o que impede alguém de "otimizar" essa leitura um dia.
$PSQL "DELETE FROM \"Acesso\" WHERE \"userId\" = '$UID_' AND funcao = 'ANUNCIANTE';" >/dev/null
COD=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/portal/contratos" -H "$PAUTH")
[ "$COD" = "403" ] && ok "vinculo revogado, o token de 12h nao vale mais ($COD)" || nok "o token sobreviveu a revogacao ($COD)"

echo ""
[ "$falhas" = "0" ] && echo "O RECORTE DO PORTAL FILTRA" || echo "$falhas FALHA(S) no portal"
exit $falhas
