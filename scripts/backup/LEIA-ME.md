# Cópia fora da máquina

Três arquivos, e uma ordem que importa.

## O que roda

    copiar.sh                  a passagem diária, 3h
    ensaiar-restauracao.sh     a única pergunta que importa: isto volta?
    /opt/backup/r2.env         as credenciais -- NÃO versionado, mora só na VPS
    /opt/backup/ultimo-sucesso a data da última cópia que chegou ao R2, escrita só no fim

## O que a cópia contém (desde 13/09)

    producao-gestao.sql.gz.enc   o Postgres novo-gestao-postgres: o produto inteiro
    operacao-velha.db.gz.enc     o SQLite da Operação antiga, enquanto o volume existir
    ambiente.tar.gz.enc          os .env da Gestão e da Operação, e o r2-arquivos.env
    midias/                      as mídias, incrementais e em claro

## O que aconteceu em 13/09, para não repetir

O script nasceu com dois Postgres: o antigo (loop-os-postgres) e o novo. O antigo foi
removido em 7/09 e o script continuou pedindo o dump dele. Como o script para na primeira
falha, NADA depois rodou por seis noites -- e o log dizia "No such container" para quem
olhasse, mas ninguém olhava.

Duas defesas nasceram disso:

- `copiar.sh` confere que o contêiner do banco existe ANTES de qualquer trabalho, e o nome
  dele está em uma variável no topo, com a mensagem de erro dizendo qual é.
- `ensaiar-restauracao.sh` recusa cópia com mais de dois dias. O ensaio mensal só rodaria no
  dia 1; com a idade máxima, ele acusa o backup parado no dia em que parou.

A terceira defesa é o monitoramento (etapa 4 da Virada de Outubro): o heartbeat que toca
DEPOIS do sucesso, e um alerta se ele não tocar. Sem ele, o arquivo `ultimo-sucesso` é o que
se olha.

## Por que o SQLite não é copiado com `cp` -- e quando é

Com o contêiner da Operação RODANDO, o banco está em modo WAL, e copiar `remote_display.db`
sozinho produz um arquivo que abre e está sem as gravações recentes. Aí `copiar.sh` usa o
backup online do próprio SQLite.

Com o contêiner PARADO (o caso desde 12/09), o diário foi consolidado e o arquivo sozinho é
consistente. O script confere que não há diário com conteúdo antes de copiar; se houver, ele
para e explica em vez de subir uma cópia incompleta.

## Por que `copy` e nunca `sync`

`sync` apaga no destino o que sumiu na origem, que é o oposto de um backup. O token do R2
também não tem permissão de exclusão -- mas a intenção precisa estar no script, e não só na
permissão. Duas travas, e a de cima é a que se lê.

## Por que os `.env` entram

Sem eles um banco restaurado não decifra os tokens guardados. É o erro clássico: restaura-se
tudo e descobre-se que as integrações estão mortas.

## A senha da cifra mora em DOIS lugares

Em `/opt/backup/r2.env` e com o Vitor. Uma cópia cifrada cuja única chave morreu junto com o
servidor é uma cópia que não existe.

## Como ligar

    # na VPS, uma vez:
    mkdir -p /opt/backup
    # criar /opt/backup/r2.env com R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
    # R2_SECRET_ACCESS_KEY, R2_BUCKET e BACKUP_SENHA
    chmod 600 /opt/backup/r2.env

    # o cron, 3h da manhã:
    0 3 * * * /opt/novo-operacao/scripts/backup/copiar.sh >> /var/log/backup.log 2>&1

    # o ensaio, mensal -- e à mão sempre que alguém quiser dormir melhor:
    0 4 1 * * /opt/novo-operacao/scripts/backup/ensaiar-restauracao.sh >> /var/log/backup.log 2>&1

## Como saber se está funcionando, em dez segundos

    cat /opt/backup/ultimo-sucesso     # a data tem de ser de hoje ou de ontem
    tail -3 /var/log/backup.log        # a última linha tem de ser "pronto: bancos/..."
