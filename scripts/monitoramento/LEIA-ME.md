# Monitoramento e página de status (Bloco A, 06/09)

Decisão do Vitor: monitoramento sim, sem custo. O que cabe no gratuito e o que cada coisa vigia.

## 1. Better Stack (Uptime) — a conta é do Vitor

Plano gratuito (setembro/2026): 10 monitores, verificação a cada 3 min, alertas por e-mail e
pelo aplicativo, 1 página de status. Criar em https://betterstack.com/uptime com o e-mail da
empresa, depois cadastrar os monitores abaixo **exatamente com estas URLs e expectativas**.

| # | Monitor | URL | Espera | Vigia |
|---|---------|-----|--------|-------|
| 1 | Operação (API) | `https://beta.loopplayer.com.br/api/health` | 200 e o texto `"ok":true` | o Node da casa velha e o SQLite |
| 2 | Gestão (API) | `https://beta.loopplayer.com.br/gestao-api/health` | 200 | o NestJS e o proxy `/gestao-api/` |
| 3 | Gestão (web) | `https://beta.loopplayer.com.br/gestao/entrar` | 200 e o texto `Entrar` | o Next e a porta do produto |
| 4 | Autenticação | `https://beta.loopplayer.com.br/api/auth/config` | 200 e o texto `providers` | quem deixa o cliente entrar |
| 5 | Planos | `https://beta.loopplayer.com.br/api/subscription/plans` | 200 e o texto `"id"` | leitura do banco pela rota pública |
| 6 | Tempo real (player) | `https://beta.loopplayer.com.br/socket.io/?EIO=4&transport=polling` | 200 e o texto `"sid"` | o socket que as TVs usam |
| 7 | Certificado TLS | `https://beta.loopplayer.com.br/` | aviso 14 dias antes de vencer | o Let's Encrypt renovando |
| 8 | Backup diário (heartbeat) | URL gerada pelo Better Stack | um toque por dia, tolerância 6 h | `scripts/backup.sh` (ver §3) |
| 9 | Ensaio de restauração (heartbeat) | URL gerada pelo Better Stack | um toque por mês, tolerância 3 dias | o ensaio mensal do backup |
| 10 | Fechamento de cobrança (heartbeat) | URL gerada pelo Better Stack | um toque por dia | `services/tenant-invoicing.js` (`tick`) |

Regras de alerta: "confirmar de 2 regiões antes de avisar" ligado (evita alarme por soluço de
rede); primeiro aviso por e-mail e pelo aplicativo; escalar por chamada só se o Vitor quiser
pagar. Aviso pelo WhatsApp vem na seção de Saúde da administração (Bloco B), pela nossa própria
Evolution — o Better Stack cobra por SMS/chamada.

## 2. Página de status

Criar em Better Stack → Status pages → "Loop Player". Colocar os monitores 1, 2, 3, 4 e 6 com os
nomes que o cliente entende: **Painel**, **Gestão**, **Entrar**, **Telas (tempo real)**, **Site**.
Os heartbeats e o certificado NÃO vão para a página (são internos).

Endereço: o gratuito vem como `loopplayer.betteruptime.com`. Para `status.loopplayer.com.br`,
o Vitor cria um CNAME no DNS apontando para o endereço que o Better Stack mostrar — e o link
entra na Ajuda e no rodapé da porta (uma linha em `app/ajuda/page.tsx` e em `app/entrar/page.tsx`).

## 3. Heartbeats: onde o toque acontece

- **Backup diário:** no fim de `scripts/backup/copiar.sh`, quando bancos e mídias subiram para o
  R2 sem erro. A URL fica em `/opt/backup/r2.env` como `BACKUP_HEARTBEAT_URL=`. Sem a variável,
  nada muda.
- **Ensaio mensal:** `scripts/backup/ensaiar-restauracao.sh` toca `ENSAIO_HEARTBEAT_URL` (mesmo
  arquivo) só quando o restore conferiu.
- **Fechamento de cobrança:** `tick()` em `services/tenant-invoicing.js` toca
  `COBRANCA_HEARTBEAT_URL` ao terminar sem exceção. Um dia sem toque = o fechamento não rodou.

A regra dos três: o toque acontece DEPOIS do sucesso, nunca antes — um heartbeat no início do
script diz que o script começou, não que o backup existe.

## 4. Erros: Sentry (a conta é do Vitor)

Plano Developer gratuito: 5 mil erros/mês, 1 usuário. Criar em https://sentry.io, um projeto
**Node.js** (Operação) e um **NestJS** (Gestão). Cada projeto dá um DSN.

- Operação: `SENTRY_DSN=` em `/opt/novo-operacao/repo/.env` (o `server/server.js` já inicializa
  quando a variável existe; sem ela, nada acontece).
- Gestão: `SENTRY_DSN=` em `/opt/novo-gestao/repo/.env` (o `apps/api/src/instrument.ts` idem).
- Depois de gravar: rodada normal (o container lê o `.env` ao subir).

Aviso do Sentry: por e-mail, "quando um erro novo aparece" e "quando um erro conhecido volta".
Sem regra de volume por enquanto.

## 5. O que NÃO é vigiado por nada disto

- **Disco da VPS** (81% em 06/09): a saída é o R2 para mídias (feito no código, esperando o
  token). Até lá, `df -h /` na mão. A Saúde da administração (Bloco B) passa a mostrar.
- **A TV que parou**: já existe o aviso por e-mail de tela offline (Conta → "Avisar por e-mail").
- **A Evolution (WhatsApp)**: é interna; se cair, a régua de cobrança e o segundo fator caem
  para o e-mail. Entra na Saúde do Bloco B.
