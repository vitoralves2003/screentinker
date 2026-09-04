# O CENÁRIO DO PORTAL — plantado por duas provas, escrito uma vez.
#
# `provar_portal_recorte.sh` (o servidor) e `provar_portal_na_tela.sh` (o navegador) precisam do
# MESMO cenário: dois clientes com contrato ativo na organização de quem tem sessão, e um vínculo
# de ANUNCIANTE amarrado a um deles. Duas cópias do plantio divergiriam no dia em que uma coluna
# obrigatória nascesse — e a prova que ficasse para trás falharia por motivo que não é o dela.
#
# Não é executável: carregue com `. ./portal_cenario.sh`.
#
# ── as três armadilhas que já aprovaram lixo aqui ───────────────────────────────────────────
# 1. `psql -tAc` com RETURNING devolve o id E a linha "INSERT 0 1". Guardar as duas coisas numa
#    variável planta lixo, e as asserções passam POR VAZIO: `grep -q ""` casa qualquer coisa. Por
#    isso o id sai de um SELECT depois do INSERT, e `exigir` PARA a prova quando ele vem vazio —
#    falhar no plantio é diferente de reprovar o produto.
# 2. `Contract` exige templateId, templateVersionId e createdById. Um INSERT que falha em silêncio
#    deixa o cenário incompleto e a prova mede outra coisa.
# 3. `Client_organizationId_document_key` é ÚNICO: os dois clientes não podem repetir documento. E
#    a marca precisa ser DETERMINÍSTICA — com `$$` (o PID) a limpeza de uma execução nunca alcança
#    o que a anterior deixou, e a prova seguinte morre na duplicata.

PSQL="docker exec novo-gestao-postgres psql -U novo -d novo_gestao -tAc"
EMAIL=${EMAIL:-cliente@exemplo.invalid}
MARCA=${MARCA:-prova-portal}

exigir() { [ -n "$2" ] || { echo "  O CENARIO NAO FOI CRIADO: $1 veio vazio"; exit 3; }; }

# Apaga o que esta biblioteca cria, e só isso. Roda no começo também: a marca é fixa, então isto
# recolhe o que sobrou de uma execução interrompida antes de chegar ao fim.
cenario_limpar() {
  $PSQL "DELETE FROM \"Acesso\" WHERE \"userId\" = '$UID_' AND funcao = 'ANUNCIANTE';" >/dev/null 2>&1
  $PSQL "DELETE FROM \"Contract\" WHERE number LIKE 'PROVA-%';" >/dev/null 2>&1
  $PSQL "DELETE FROM \"Client\" WHERE document LIKE '${MARCA}%';" >/dev/null 2>&1
}

# Descobre a pessoa e a organização dela. Separado do plantio porque `cenario_limpar` precisa do
# UID_ antes de qualquer coisa ser criada.
cenario_quem() {
  DADOS=$($PSQL "SELECT u.id || '|' || u.\"organizationId\" FROM \"User\" u WHERE u.email = '$EMAIL';")
  UID_=$(echo "$DADOS" | cut -d'|' -f1)
  ORG=$(echo "$DADOS" | cut -d'|' -f2)
  exigir "usuario" "$UID_"
}

# Deixa de pé: CA e CB (clientes), KA e KB (contratos ativos, 3 mídias, 30s). NÃO cria o vínculo —
# quem o cria é `cenario_vincular`, porque a prova do servidor mede a recusa ANTES dele existir.
cenario_plantar() {
  TPL=$($PSQL "SELECT id FROM \"ContractTemplate\" WHERE \"organizationId\" = '$ORG' LIMIT 1;")
  TPLV=$($PSQL "SELECT id FROM \"ContractTemplateVersion\" WHERE \"templateId\" = '$TPL' LIMIT 1;")
  exigir "template" "$TPL"
  exigir "versao do template" "$TPLV"

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
}

# O WORKSPACE DA SESSÃO, que NÃO é a organização — e confundir os dois custou uma prova.
#
# `Organization` e `workspaces` são o mesmo tenant no discurso, mas não têm o mesmo id nesta
# conta: a organização é 812341ca… e a workspace da sessão é 26d19a10…. As rotas da Operação
# (playlists, conteúdo, telas) escopam por WORKSPACE, e uma lista plantada com o id da
# organização existe no banco e responde 403 no publish — "Access denied" sobre uma lista que
# está ali, o que parece defeito de permissão e é endereço errado.
#
# A fonte da verdade é o próprio token, e não uma consulta que adivinhe: é ele que a sessão
# apresenta. `current_workspace_id` viaja no payload, que é base64url — daí o tr e o padding.
cenario_workspace() {
  PAYLOAD=$(echo "$TOKEN" | cut -d. -f2 | tr '_-' '/+')
  WS=$(printf '%s==' "$PAYLOAD" | base64 -d 2>/dev/null | sed -n 's/.*"current_workspace_id":"\([^"]*\)".*/\1/p')
  exigir "workspace da sessao" "$WS"
}

# Amarra a sessão ao cliente A. O portal é do ANUNCIANTE: sem isto, a conta de teste é titular e
# o portal recusa — que é exatamente o que a prova do servidor mede antes de chamar isto.
cenario_vincular() {
  $PSQL "INSERT INTO \"Acesso\" (id, \"userId\", \"organizationId\", funcao, \"clientId\", \"criadoEm\")
         VALUES (gen_random_uuid()::text, '$UID_', '$ORG', 'ANUNCIANTE', '$CA', CURRENT_TIMESTAMP);" >/dev/null
  VINC=$($PSQL "SELECT count(*) FROM \"Acesso\" WHERE \"userId\" = '$UID_' AND funcao = 'ANUNCIANTE';")
  exigir "vinculo" "$VINC"
}
