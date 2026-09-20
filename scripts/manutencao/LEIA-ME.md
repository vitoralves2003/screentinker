# Manutenção da máquina

Rotinas que cuidam da VPS em si — não do produto. O que cuida dos DADOS está em
`scripts/backup/`.

## `limpar-cache-docker.sh` — a faxina semanal

**Domingos, 05:00 UTC (02:00 em Brasília).** Instalada em `/etc/cron.d/limpeza-docker`,
registra em `/var/log/limpeza-docker.log`.

### Por que ela nasceu

Em 20/09 o disco estava em 78% e a leitura natural era "os dados cresceram". Não era: dos
302 GB ocupados, **283 GB eram cache de compilação do Docker** — passos de build guardados
para acelerar a próxima publicação, sem limite nenhum configurado. A primeira faxina
devolveu 60 GB de imediato e o resto ao longo dos minutos seguintes.

O risco nunca foi o cache ocupar espaço. Foi ele empurrar o disco para 100% numa noite
qualquer: com o disco cheio, o Postgres para de aceitar escrita, o backup das 03:00 não
consegue gravar o dump, e o painel devolve erro sem conseguir dizer por quê. Três falhas com
a mesma raiz e nenhuma delas se apresentando como "o disco encheu".

### O que ela apaga

| | |
|---|---|
| cache de compilação | só o que passa de 20 GB, o mais velho primeiro |
| camadas de imagem órfãs | as que sobram quando uma imagem é reconstruída |
| **volumes** | **nunca** — volume é dado (Postgres, uploads, SQLite da casa velha) |
| **imagem anterior da API** | **nunca** — é para onde se volta quando uma publicação dá errado |

A segunda e a quarta linha são a mesma decisão: `docker image prune` **sem** `-a`. Com `-a`
ele levaria toda imagem que nenhum contêiner está rodando agora — o que inclui a versão
anterior da API, justamente a que salva um retorno às pressas.

### O teto, em vez de apagar tudo

`--max-used-space=20GB` deixa o cache existir até um limite e descarta o excedente. Zerar
toda semana faria a primeira publicação de cada semana ser lenta à toa.

**Cuidado com a versão do Docker:** até a 28 a flag se chamava `--keep-storage`; aqui roda a
29, onde ela é `--max-used-space`. Se o comando passar a recusar a flag, é isso —
`docker builder prune --help` diz o nome atual.

### O que o log dela responde

Além do antes e depois, ele responde duas perguntas que o número sozinho não responde:

- **"e se não for mais cache?"** — se o disco continuar em 80% ou mais *depois* da faxina, o
  script avisa explicitamente e aponta onde olhar. Sem essa linha, uma faxina que não resolve
  mais nada continuaria rodando em silêncio, parecendo estar cuidando do problema.
- **"ela derrubou alguma coisa?"** — ele lista os contêineres de pé ao terminar. Isso permite
  afirmar que nada caiu olhando o log de um domingo qualquer, em vez de confiar na intenção
  do script.

### Se precisar rodar à mão

```bash
bash /opt/novo-operacao/scripts/manutencao/limpar-cache-docker.sh
```

É seguro a qualquer hora: se houver publicação em andamento, ela se adia sozinha e não apaga
nada.
