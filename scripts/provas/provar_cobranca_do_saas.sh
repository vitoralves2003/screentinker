#!/bin/sh
# A COBRANÇA DO SAAS DE PONTA A PONTA (06/09): plano pago -> fechamento do mês -> cobrança no Asaas
# (SANDBOX) -> webhook de pagamento -> fatura paga; fatura vencida -> painel suspenso (403 na
# escrita, leitura segue) -> pagamento -> acesso de volta. Tudo desfeito no fim.
#
# Roda na VPS, de qualquer diretório. Recusa-se a rodar se o Asaas do container não for sandbox.
AQUI=$(cd "$(dirname "$0")" && pwd)
CONT="${CONT:-novo-operacao}"
docker cp "$AQUI/cobranca_do_saas.js" "$CONT:/app/server/prova-cobranca.js" || { echo "nao copiou a prova para o container"; exit 1; }
docker exec "$CONT" node /app/server/prova-cobranca.js
cod=$?
docker exec "$CONT" rm -f /app/server/prova-cobranca.js
exit $cod
