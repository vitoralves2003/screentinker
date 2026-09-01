# Cópia fora da máquina

Três arquivos, e uma ordem que importa.

## O que roda

    copiar.sh                a passagem diária
    ensaiar-restauracao.sh   a única pergunta que importa: isto volta?
    /opt/backup/r2.env       as credenciais -- NÃO versionado, mora só na VPS

## Por que o SQLite não é copiado com `cp`

O banco da Operação está em modo WAL. Copiar `remote_display.db` sozinho produz um arquivo que
**abre normalmente e está sem as gravações recentes** -- uma cópia que parece boa e chegou
incompleta. `copiar.sh` usa o backup online do próprio SQLite, que atravessa o WAL.

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
