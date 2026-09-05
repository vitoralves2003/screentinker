#!/bin/sh
# EMITIR O CONTRATO JÁ BASTA PARA COBRAR — contra o servidor de verdade.
#
# Pedido do Vitor em 05/09: "após gerar o contrato eu já consiga criar as cobranças, sem a
# necessidade da assinatura".
#
# ── por que uma prova de servidor, e não só testes de unidade ───────────────────────────────
# A trava era uma linha (`status !== 'ACTIVE'`), e uma linha se conserta com um teste de unidade.
# O que um teste de unidade NÃO responde é se o caminho inteiro atravessa: a rota, o guarda, o
# escopo do tenant, a conexão com o provedor financeiro e a escrita das parcelas. Um contrato
# emitido que passa na trava e morre três camadas adiante continua sendo "não consigo cobrar"
# para quem está na tela.
#
# ── e por que ela é segura de rodar ─────────────────────────────────────────────────────────
# As duas conexões Asaas do staging são SANDBOX (medido antes de escrever isto). Gerar cobrança
# aqui cria cobrança no ambiente de teste do provedor, não no dinheiro de ninguém. Se um dia uma
# conexão de PRODUÇÃO aparecer neste banco, esta prova para — a guarda abaixo existe para isso.
#
# Uso:  BASE=https://beta.loopplayer.com.br TOKEN=<sessao> sh provar_cobrar_sem_assinatura.sh

. "$(dirname "$0")/portal_cenario.sh"

falhas=0
ok()  { echo "  ok    $1"; }
nok() { echo "  FALHA $1"; falhas=$((falhas+1)); }

[ -n "$TOKEN" ] || { echo "SEM SESSAO: passe TOKEN=..."; exit 1; }
BASE=${BASE:-https://beta.loopplayer.com.br}
AUTH="Authorization: Bearer $TOKEN"

ALCANCE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/gestao-api/contracts" -H "$AUTH")
[ "$ALCANCE" = "000" ] && { echo "SEM SERVIDOR EM $BASE -- a prova nao mede nada assim"; exit 4; }

cenario_quem

# ── A GUARDA DE DINHEIRO ─────────────────────────────────────────────────────────────────────
# Esta prova EMITE cobrança de verdade pela rota de verdade. Num ambiente ligado à produção do
# provedor, isso é um boleto na mão de alguém. A prova só roda se a conexão desta organização for
# de sandbox — e PARA, em vez de reprovar, porque não achar sandbox não é defeito do produto.
AMBIENTE=$($PSQL "SELECT environment FROM \"FinancialProviderConnection\" WHERE \"organizationId\" = '$ORG' AND status = 'ACTIVE' LIMIT 1;")
case "$AMBIENTE" in
  SANDBOX) echo "  conexao financeira: SANDBOX (seguro emitir)" ;;
  "")      echo "SEM CONEXAO FINANCEIRA ATIVA nesta organizacao -- a prova nao tem o que exercitar"; exit 4 ;;
  *)       echo "A CONEXAO E '$AMBIENTE', E NAO SANDBOX -- esta prova NAO roda contra dinheiro de verdade"; exit 4 ;;
esac

limpar_tudo() {
  $PSQL "DELETE FROM \"ContractCharge\" WHERE \"contractId\" IN (SELECT id FROM \"Contract\" WHERE number LIKE 'PROVA-%');" >/dev/null 2>&1
  $PSQL "DELETE FROM \"ContractEvent\" WHERE \"contractId\" IN (SELECT id FROM \"Contract\" WHERE number LIKE 'PROVA-%');" >/dev/null 2>&1
  $PSQL "DELETE FROM playlists WHERE contrato_id IN (SELECT id FROM \"Contract\" WHERE number LIKE 'PROVA-%');" >/dev/null 2>&1
  cenario_limpar
  echo "  cenario removido"
}
trap limpar_tudo EXIT
limpar_tudo >/dev/null 2>&1

echo ""
echo "== plantando um contrato com valores =="
cenario_plantar
# `cenario_plantar` deixa os dois contratos ACTIVE. Aqui o que se mede é o estado EMITIDO, então
# o contrato A desce para ISSUED e ganha o plano financeiro que a geração vai ler.
#
# Os valores são plantados por SQL de propósito: o que esta prova persegue é a trava de ESTADO, e
# passar pela tela de valores mediria a tela de valores.
$PSQL "UPDATE \"Contract\" SET status = 'ISSUED', \"totalValue\" = 900, \"downPaymentValue\" = 300,
       \"regularInstallmentCount\" = 2, \"regularInstallmentValue\" = 300, \"finalInstallmentAdjustment\" = 0
       WHERE id = '$KA';" >/dev/null
ESTADO=$($PSQL "SELECT status FROM \"Contract\" WHERE id = '$KA';")
[ "$ESTADO" = "ISSUED" ] || { echo "  O CENARIO NAO FOI CRIADO: o contrato ficou '$ESTADO'"; exit 3; }
echo "  contrato A=$KA em ISSUED, 300 de entrada + 2x300"

echo ""
echo "== antes, ele nao tem cobranca nenhuma =="
# A guarda que faz a asserção seguinte significar alguma coisa: com cobranças já ali, "as
# cobranças nasceram" passaria sem a rota ter feito nada.
QUANTAS=$($PSQL "SELECT count(*) FROM \"ContractCharge\" WHERE \"contractId\" = '$KA';")
[ "$QUANTAS" = "0" ] && ok "nenhuma cobranca ainda" || nok "ja havia $QUANTAS -- a prova nao mede a criacao"

echo ""
echo "== EMITIDO cobra, sem passar pela assinatura =="
RESP=$(curl -s -w '\n%{http_code}' -X POST "$BASE/gestao-api/contracts/$KA/charges/generate" \
  -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"downPaymentDueDate":"2026-10-05","firstInstallmentDueDate":"2026-11-05"}')
COD=$(echo "$RESP" | tail -1)
CORPO=$(echo "$RESP" | head -n -1)
echo "  HTTP $COD  $(echo "$CORPO" | head -c 200)"
case "$COD" in
  200|201) ok "a rota aceitou um contrato EMITIDO" ;;
  *)       nok "a rota respondeu $COD num contrato emitido" ;;
esac

# O banco é quem confirma. Uma rota que responde 200 e não grava é o defeito que este módulo já
# teve — marcar sem republicar, na Etapa 6.
NASCERAM=$($PSQL "SELECT count(*) FROM \"ContractCharge\" WHERE \"contractId\" = '$KA';")
[ "$NASCERAM" = "3" ] && ok "nasceram as 3 (entrada + 2 parcelas)" || nok "esperava 3 cobrancas, achei $NASCERAM"

# E o contrato NÃO foi ativado de carona: cobrar não é assinar, e um estado que muda sozinho aqui
# faria o painel dizer que o papel voltou assinado quando ele não voltou.
DEPOIS=$($PSQL "SELECT status FROM \"Contract\" WHERE id = '$KA';")
[ "$DEPOIS" = "ISSUED" ] && ok "e o contrato continua EMITIDO" || nok "o contrato virou '$DEPOIS' ao cobrar"

echo ""
echo "== o RASCUNHO nao cobra, e a recusa manda EMITIR =="
# A outra metade da trava. Sem ela, "agora cobra" poderia significar "cobra sempre" — e um boleto
# emitido a partir de um rascunho é de um documento que ainda está sendo escrito.
$PSQL "UPDATE \"Contract\" SET status = 'DRAFT' WHERE id = '$KB';" >/dev/null
$PSQL "UPDATE \"Contract\" SET \"totalValue\" = 600, \"regularInstallmentCount\" = 2,
       \"regularInstallmentValue\" = 300 WHERE id = '$KB';" >/dev/null
RESP=$(curl -s -w '\n%{http_code}' -X POST "$BASE/gestao-api/contracts/$KB/charges/generate" \
  -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"firstInstallmentDueDate":"2026-11-05"}')
COD=$(echo "$RESP" | tail -1)
CORPO=$(echo "$RESP" | head -n -1)
echo "  HTTP $COD  $(echo "$CORPO" | head -c 200)"
[ "$COD" = "400" ] && ok "o rascunho e recusado (400)" || nok "o rascunho respondeu $COD"
# A FRASE, e não só o código. A antiga dizia "Contract must be ACTIVE", que manda esperar a
# assinatura — exatamente a espera que esta mudança tirou. Quem esbarra aqui hoje precisa ouvir
# qual é o passo que falta, e ele é emitir.
echo "$CORPO" | grep -qi "Emita o contrato" && ok "e ela manda EMITIR, nao esperar assinatura" \
  || nok "a recusa nao diz o passo que falta: $CORPO"

NADA=$($PSQL "SELECT count(*) FROM \"ContractCharge\" WHERE \"contractId\" = '$KB';")
[ "$NADA" = "0" ] && ok "e nao gravou nada no rascunho" || nok "o rascunho ficou com $NADA cobranca(s)"

echo ""
[ "$falhas" = "0" ] && echo "EMITIR JA BASTA PARA COBRAR, E O RASCUNHO CONTINUA RECUSADO" || echo "$falhas FALHA(S)"
exit $falhas
