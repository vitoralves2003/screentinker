#!/bin/sh
# O SEGUNDO FATOR (06/09), contra o servidor de verdade, de dentro do container da Operação.
# Ver scripts/provas/segundo_fator.js. Roda na VPS, de qualquer diretório.
AQUI=$(cd "$(dirname "$0")" && pwd)
CONT="${CONT:-novo-operacao}"
docker cp "$AQUI/segundo_fator.js" "$CONT:/app/server/prova-segundo-fator.js" || { echo "nao copiou a prova para o container"; exit 1; }
docker exec "$CONT" node /app/server/prova-segundo-fator.js
cod=$?
docker exec "$CONT" rm -f /app/server/prova-segundo-fator.js
exit $cod
