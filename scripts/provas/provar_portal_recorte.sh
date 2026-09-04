#!/bin/sh
# O RECORTE DO PORTAL FILTRA? — a prova planta o próprio cenário e limpa no fim.
#
# `portal_do_anunciante.js`, ao lado desta, confere que as rotas subiram e que quem não tem
# vínculo é recusado. Ela NÃO responde a pergunta que importa num portal: um anunciante amarrado
# ao cliente A alcança o contrato do cliente B da MESMA organização? É o defeito clássico deste
# tipo de tela, e o único jeito honesto de verificá-lo é pedir o contrato do vizinho com a
# sessão dele — o que exige dois clientes com contrato ativo, que a prova precisa criar.
#
# ── por que ela planta em vez de usar o que já existe ───────────────────────────────────────
# Os contratos do staging estão numa organização cuja senha não temos. Depender de dado alheio
# faria a prova passar ou falhar por motivo que não é o dela — e uma prova que só roda quando o
# banco está de um certo jeito é uma prova que um dia para de rodar e ninguém nota.
#
# ── as três lições que estão escritas no código abaixo ──────────────────────────────────────
# 1. `psql -tAc` com RETURNING devolve o id E a linha "INSERT 0 1". A primeira versão guardou as
#    duas coisas numa variável, plantou lixo, e as asserções passaram POR VAZIO: `grep -q ""`
#    casa qualquer coisa. Agora o id sai de um SELECT depois do INSERT, e `exigir` PARA a prova
#    se ele vier vazio — falhar no plantio é diferente de reprovar o produto.
# 2. `Contract` exige templateId, templateVersionId e createdById. Um INSERT que falha em
#    silêncio deixa o cenário incompleto e a prova mede outra coisa.
# 3. `Client_organizationId_document_key` é ÚNICO: os dois clientes não podem repetir documento.
#    E a marca precisa ser DETERMINÍSTICA — com `$$` (o PID) a limpeza de uma execução nunca
#    alcança o que a anterior deixou, e a prova seguinte morre na duplicata.
#
# Uso:  BASE=https://beta.loopplayer.com.br TOKEN=<sessao> sh provar_portal_recorte.sh

PSQL="docker exec novo-gestao-postgres psql -U novo -d novo_gestao -tAc"
EMAIL=${EMAIL:-cliente@exemplo.invalid}
MARCA=${MARCA:-prova-portal}

falhas=0
ok()  { echo "  ok    $1"; }
nok() { echo "  FALHA $1"; falhas=$((falhas+1)); }
exigir() { [ -n "$2" ] || { echo "  O CENARIO NAO FOI CRIADO: $1 veio vazio"; exit 3; }; }

[ -n "$TOKEN" ] || { echo "SEM SESSAO: passe TOKEN=..."; exit 1; }

DADOS=$($PSQL "SELECT u.id || '|' || u.\"organizationId\" FROM \"User\" u WHERE u.email = '$EMAIL';")
UID_=$(echo "$DADOS" | cut -d'|' -f1)
ORG=$(echo "$DADOS" | cut -d'|' -f2)
exigir "usuario" "$UID_"
echo "== a pessoa e a organizacao dela =="
echo "  usuario=$UID_  org=$ORG"

# Limpa mesmo se algo abaixo falhar: um vínculo esquecido é uma porta aberta, e um contrato
# esquecido é ruído para sempre. A marca é fixa, então isto também recolhe o que sobrou de uma
# execução interrompida antes.
limpar() {
  $PSQL "DELETE FROM \"Acesso\" WHERE \"userId\" = '$UID_' AND funcao = 'ANUNCIANTE';" >/dev/null 2>&1
  $PSQL "DELETE FROM \"Contract\" WHERE number LIKE 'PROVA-%';" >/dev/null 2>&1
  $PSQL "DELETE FROM \"Client\" WHERE document LIKE '${MARCA}%';" >/dev/null 2>&1
  echo "  cenario removido"
}
trap limpar EXIT
limpar >/dev/null 2>&1

TPL=$($PSQL "SELECT id FROM \"ContractTemplate\" WHERE \"organizationId\" = '$ORG' LIMIT 1;")
TPLV=$($PSQL "SELECT id FROM \"ContractTemplateVersion\" WHERE \"templateId\" = '$TPL' LIMIT 1;")
exigir "template" "$TPL"
exigir "versao do template" "$TPLV"

echo "== plantando dois clientes e um contrato ativo para cada =="
$PSQL "INSERT INTO \"Client\" (id, \"organizationId\", name, document, email, whatsapp, \"postalCode\", street, number, neighborhood, city, state, status, \"createdAt\", \"updatedAt\")
  VALUES (gen_random_uuid()::text, '$ORG', 'Padaria da Prova', '${MARCA}-a', 'a@exemplo.invalid', '11999999999', '01000000', 'Rua A', '1', 'Centro', 'Sao Paulo', 'SP', 'ACTIVE', now(), now()),
         (gen_random_uuid()::text, '$ORG', 'Otica da Prova', '${MARCA}-b', 'b@exemplo.invalid', '11988888888', '01000000', 'Rua B', '2', 'Centro', 'Sao Paulo', 'SP', 'ACTIVE', now(), now());" >/dev/null
CA=$($PSQL "SELECT id FROM \"Client\" WHERE document = '${MARCA}-a';")
CB=$($PSQL "SELECT id FROM \"Client\" WHERE document = '${MARCA}-b';")
exigir "cliente A" "$CA"
exigir "cliente B" "$CB"

$PSQL "INSERT INTO \"Contract\" (id, \"organizationId\", \"clientId\", \"templateId\", \"templateVersionId\", \"createdById\", number, status, \"startDate\", \"mediaLimit\", \"mediaMaxSeconds\", \"createdAt\", \"updatedAt\")
  VALUES (gen_random_uuid()::text, '$ORG', '$CA', '$TPL', '$TPLV', '$UID_', 'PROVA-A', 'ACTIVE', now(), 3, 30, now(), now()),
         (gen_random_uuid()::text, '$ORG', '$CB', '$TPL', '$TPLV', '$UID_', 'PROVA-B', 'ACTIVE', now(), 3, 30, now(), now());" >/dev/null
KA=$($PSQL "SELECT id FROM \"Contract\" WHERE number = 'PROVA-A';")
KB=$($PSQL "SELECT id FROM \"Contract\" WHERE number = 'PROVA-B';")
exigir "contrato A" "$KA"
exigir "contrato B" "$KB"
echo "  contrato A=$KA"
echo "  contrato B=$KB"

echo ""
echo "== antes do vinculo, o portal recusa =="
COD=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/portal/contratos" -H "Authorization: Bearer $TOKEN")
[ "$COD" = "403" ] && ok "sem vinculo de anunciante: 403" || nok "sem vinculo respondeu $COD"

echo ""
echo "== plantando o vinculo de ANUNCIANTE no cliente A =="
$PSQL "INSERT INTO \"Acesso\" (id, \"userId\", \"organizationId\", funcao, \"clientId\", \"criadoEm\")
       VALUES (gen_random_uuid()::text, '$UID_', '$ORG', 'ANUNCIANTE', '$CA', CURRENT_TIMESTAMP);" >/dev/null
VINC=$($PSQL "SELECT count(*) FROM \"Acesso\" WHERE \"userId\" = '$UID_' AND funcao = 'ANUNCIANTE';")
[ "$VINC" = "1" ] && ok "vinculo plantado" || nok "esperava 1 vinculo, achei $VINC"

echo ""
echo "== o portal, com o vinculo =="
R=$(curl -s "$BASE/api/portal/contratos" -H "Authorization: Bearer $TOKEN")
echo "  resposta: $(echo "$R" | head -c 260)"
echo "$R" | grep -q "PROVA-A" && ok "o contrato do cliente A aparece" || nok "o contrato do cliente A NAO aparece"
echo "$R" | grep -q "PROVA-B" && nok "o do cliente B VAZOU para o portal" || ok "o do cliente B nao aparece"
# O portal existe para o anunciante mandar mídia, não para auditar quem o atende. Valor e parcela
# são a relação comercial do assinante, e o servidor não os devolve -- isto prova que continua assim.
echo "$R" | grep -qiE '"totalValue"|"installment"|"downPayment"' && nok "dinheiro vazou na resposta" || ok "nenhum campo de dinheiro na resposta"
echo "$R" | grep -q '"limiteDeMidias":3' && ok "o limite de midias viaja" || nok "o limite de midias nao veio"

echo ""
echo "== pedindo o contrato do vizinho pelo id =="
# 404 e não 403 de propósito: "existe mas não é seu" já entrega que existe.
COD=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/portal/contratos/$KB" -H "Authorization: Bearer $TOKEN")
[ "$COD" = "404" ] && ok "404, e nao 403" || nok "respondeu $COD"
COD=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/portal/contratos/$KB/midias" -H "Authorization: Bearer $TOKEN")
[ "$COD" = "404" ] && ok "as midias do vizinho tambem: 404" || nok "midias do vizinho responderam $COD"

echo ""
echo "== e o proprio contrato abre =="
COD=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/portal/contratos/$KA" -H "Authorization: Bearer $TOKEN")
[ "$COD" = "200" ] && ok "o contrato dele responde 200" || nok "o proprio contrato respondeu $COD"
COD=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/portal/contratos/$KA/midias" -H "Authorization: Bearer $TOKEN")
[ "$COD" = "200" ] && ok "e as midias dele tambem" || nok "as midias dele responderam $COD"

echo ""
[ "$falhas" = "0" ] && echo "O RECORTE DO PORTAL FILTRA" || echo "$falhas FALHA(S) no portal"
exit $falhas
