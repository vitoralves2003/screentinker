# Arquivos no R2 — mídias e documentos

Decisão do Vitor em 06/09: tudo que é arquivo mora no Cloudflare R2; o disco da VPS vira cache.
O código já está preparado nas duas partes da API da Gestão e fica **desligado** até as
variáveis existirem — é o que permite subir o código, copiar os arquivos e só então ligar.

## O que precisa existir antes

Dois buckets na conta do R2 e um token com **Object Read & Write** nos dois:

| Bucket | O que guarda |
|---|---|
| `loop-player-midias` | as mídias das telas (chave `content/<arquivo>`), miniaturas e legendas |
| `loop-player-documentos` | contratos emitidos e assinados, recibos (chaves `contracts/...`), logomarcas (`organizations/...`) |

O token do backup (`/opt/backup/r2.env`) NÃO serve: ele só enxerga o bucket de backup.
As credenciais novas vão para `/opt/backup/r2-arquivos.env`, no mesmo formato:

```sh
R2_ACCOUNT_ID=...
R2_ARQUIVOS_ACCESS_KEY_ID=...
R2_ARQUIVOS_SECRET_ACCESS_KEY=...
```

## A migração, nesta ordem

```sh
sh /opt/novo-operacao/scripts/r2/migrar.sh conferir   # lista o que vai subir, sem subir nada
sh /opt/novo-operacao/scripts/r2/migrar.sh copiar     # rclone copy (nunca sync): mídias e documentos
sh /opt/novo-operacao/scripts/r2/migrar.sh conferir   # de novo: o R2 tem de dizer o mesmo tamanho
```

Depois, no `.env` da Gestão (`/opt/novo-gestao/repo/.env`):

```sh
STORAGE_PROVIDER=S3
STORAGE_BUCKET=loop-player-documentos
STORAGE_ENDPOINT=https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com
STORAGE_REGION=auto
STORAGE_ACCESS_KEY=<R2_ARQUIVOS_ACCESS_KEY_ID>
STORAGE_SECRET_KEY=<R2_ARQUIVOS_SECRET_ACCESS_KEY>
MIDIAS_NO_R2=1
MIDIAS_BUCKET=loop-player-midias
MIDIAS_CACHE_GB=20
```

E `docker compose -p novo-gestao-app -f docker-compose.novo.yml up -d api`. A partir daí:

- upload novo grava no disco, processa, e sobe para o R2;
- pedido de arquivo que não está no disco baixa do R2 uma vez e serve do disco;
- de hora em hora o cache é varrido: do mais antigo para o mais novo, até caber em `MIDIAS_CACHE_GB`, e só o que já está no R2.

## O que NÃO mudou

O player, as rotas, os cabeçalhos e a regra de quem pode baixar. O `express.static` e o
`sendFile` continuam servindo do disco; o armazém só garante que o arquivo esteja lá antes.

## A prova

`provar_midias_no_r2.sh` (a escrever quando as credenciais existirem): sobe uma mídia, apaga a
cópia local, pede pelo player e pela prévia, e confere que voltou do R2; varre o cache com teto
baixo e confere que só o que está no R2 saiu do disco.
