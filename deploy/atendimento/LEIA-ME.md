# O atendimento do Loop Player

Chatwoot no nosso servidor, para **nós atendermos os assinantes**. Não confundir com a
Evolution que já roda aqui: aquela é dos tenants, para cada tenant falar com os anunciantes
dele. Esta é a nossa.

## Etapa 1 — subir e provar de pé

```bash
# 1. a casa
mkdir -p /opt/atendimento && cd /opt/atendimento
cp /opt/novo-operacao/deploy/atendimento/docker-compose.atendimento.yml .
cp /opt/novo-operacao/deploy/atendimento/env.template .env
chmod 600 .env

# 2. os segredos -- nascem aqui, nunca no git
openssl rand -hex 64   # -> SECRET_KEY_BASE
openssl rand -hex 24   # -> POSTGRES_PASSWORD
openssl rand -hex 24   # -> REDIS_PASSWORD  (repetir dentro de REDIS_URL)

# 3. preparar o banco -- só na primeira vez
docker compose -p atendimento -f docker-compose.atendimento.yml \
  run --rm rails bundle exec rails db:chatwoot_prepare

# 4. subir
docker compose -p atendimento -f docker-compose.atendimento.yml up -d

# 5. o primeiro atendente (o e-mail ainda não sai, então é por aqui)
docker compose -p atendimento -f docker-compose.atendimento.yml \
  exec rails bundle exec rails c
```

**A prova da etapa 1** é o endereço responder e o painel abrir num navegador de verdade — e
o painel do Loop Player e as telas continuarem respondendo igual.

## O que ficou decidido, e por quê

### Casa separada, não o banco do produto

Banco e cache próprios. O Chatwoot roda migrações no banco dele a cada atualização; dividir
o Postgres do produto faria uma atualização do **atendimento** poder travar a tabela onde
moram contratos e cobranças. O atendimento pode cair sem derrubar o produto — essa é a única
garantia que importa aqui.

Pela mesma razão a rede é própria: o atendimento não alcança o banco do produto, e nem deve.
Ele é um sistema de fora que por acaso mora na mesma máquina.

### Versão presa, não `latest`

`latest` num serviço que atende cliente significa que um `pull` numa terça-feira qualquer
troca a versão sem ninguém decidir. Está na **v4.17.1** (27/08) — quase um mês no ar, e já é
a correção de uma v4.17.0. A v4.18.0 existe e tem dois dias: tempo de menos para ter
revelado problema.

### `pgvector`, e não o postgres comum

O Chatwoot 4.x guarda busca por significado numa extensão chamada `pgvector`. Subir com o
postgres comum funciona até o dia em que uma migração pede a extensão e não a encontra — e
aí o banco já tem conversa dentro, o que torna a troca muito mais cara do que escolher certo
agora.

### Cadastro público fechado

`ENABLE_ACCOUNT_SIGNUP=false`. Sem isso, qualquer pessoa que alcance o endereço abre uma
conta de atendente **dentro do nosso sistema de suporte**.

### Teto de processador e memória

A máquina é compartilhada com o produto. Sem teto, um pico do atendimento disputa processador
com quem está entregando mídia para as telas em campo — e a tela na parede de uma padaria é o
que o cliente paga.

## Armadilhas já conhecidas

**O cifrão no `.env`.** O docker compose interpola o `env_file`: uma senha contendo `$` vira
variável vazia e o serviço sobe sem senha nenhuma, calado. Por isso os segredos são gerados
em hexadecimal, que não tem `$`.

**O `FRONTEND_URL` errado não aparece na tela.** É de lá que saem os links dos e-mails e o
endereço do balão de conversa. Errado, tudo funciona no painel e os links que o cliente recebe
apontam para o lugar errado — uma falha que só aparece do lado de quem recebeu.

**Sem o `sidekiq`, o Chatwoot abre e nada acontece.** Ele é quem manda e-mail, processa anexo
e fala com os canais. A falha se apresenta como "está lento", não como "caiu".

## O que ainda não está aqui

| | |
|---|---|
| WhatsApp | instância **nossa** na Evolution, com número do SaaS — etapa 2 |
| e-mail | enquanto o SMTP está vazio, nada é enviado (nem convite de atendente) |
| anexos no R2 | hoje no volume da máquina; o disco tem folga |
| backup | o volume `atendimento_postgres` precisa entrar na cópia diária |
