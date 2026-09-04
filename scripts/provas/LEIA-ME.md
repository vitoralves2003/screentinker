# Provas da unificação

As provas desta pasta rodam **contra a pilha viva** do ambiente novo, não contra mocks. Elas
existem porque a unificação atravessa dois sistemas, dois bancos e duas origens — e nada
disso aparece num teste unitário de qualquer um dos lados.

As oito da tabela abaixo são as da unificação em si. Depois delas vieram as das etapas, que
seguem a mesma regra e estão descritas no cabeçalho de cada arquivo.

Elas moram aqui, e não em `/tmp` na VPS, porque `/tmp` some num reboot e porque o combinado
é que o código nasce no GitHub e a VPS só o executa.

## Rodar

Na VPS, com os contêineres de pé:

```sh
cd /opt/novo-operacao/scripts/provas
for s in federacao mfa suporte plano menu resumo passo2 c3; do
  out=$(sh provar_$s.sh 2>&1)
  printf '%-10s %2s OK / %s FALHOU\n' $s \
    "$(echo "$out" | grep -c '  OK ')" "$(echo "$out" | grep -c 'FALHOU')"
done
```

Cada uma também roda sozinha e imprime o próprio veredito.

## O que cada uma prova

| Prova | Casos | Pergunta que ela responde |
|---|---|---|
| `federacao` | 14 | Entrar uma vez na Operação alcança a Gestão — e as recusas recusam. |
| `mfa` | 9 | O portão de segunda etapa **recusa e abre**. |
| `suporte` | 12 | O acesso de suporte a um workspace de cliente é registrado e limitado. |
| `plano` | 5 | O que o cliente vê vem do plano, decidido no servidor. |
| `menu` | 18 | Trocar o plano no banco muda o menu, sem tocar em código. |
| `resumo` | 7 | O cartão de Telas na Gestão diz o mesmo que a Operação. |
| `passo2` | 7 | Com a Operação fora do ar, o painel da Gestão continua de pé. |
| `c3` | 8 | O login cai onde o plano manda, e a travessia termina numa sessão válida. |

## O portal do anunciante (Etapa 10)

Duas provas, e elas respondem perguntas diferentes — por isso são duas:

| Prova | Pergunta que ela responde |
|---|---|
| `portal_do_anunciante.js` | As rotas subiram, e quem não tem vínculo é recusado sem que a recusa diga qual função falta. |
| `provar_portal_recorte.sh` | **O recorte filtra?** Um anunciante do cliente A não alcança o contrato do cliente B da mesma organização. |

A segunda planta dois clientes e dois contratos ativos, amarra o vínculo num deles, mede, e
apaga tudo no fim. Ela precisa plantar porque a pergunta exige **dois** clientes com contrato
ativo na organização de quem tem sessão, e o staging não os tem por acaso.

```sh
BASE=https://beta.loopplayer.com.br TOKEN=<sessao> sh provar_portal_recorte.sh
```

## Duas regras que estas provas aprenderam do jeito difícil

**Cada prova prepara o próprio terreno.** `provar_mfa.sh` *ativa* a segunda etapa — então
ele consumia a própria pré-condição: passava uma vez e reprovava em todas as rodadas
seguintes, num produto intacto. Hoje cada roteiro chama `zerar_mfa` ou `preparar_mfa` no
começo, e o resultado não depende mais da ordem de execução.

**Uma checagem tem de olhar a *forma* do que recebeu.** `sed` que não casa devolve a
entrada inteira, e `[ -n "$X" ]` aprova uma mensagem de erro como se fosse um token;
`grep -q ""` casa com qualquer coisa. As duas armadilhas já aprovaram lixo aqui. Por isso
existe `ejwt()`, e por isso o caso 1 da federação **aborta** quando o login falha: sem
sessão não há o que provar, e cinco falhas em cascata escondem a única que importa.

## A defesa que parece defeito

O TOTP recusa um código já usado dentro da mesma janela de 30 segundos. Um roteiro que
entra várias vezes seguidas bate nisso e lê `Invalid code` como se fosse bug. `mfa_lib.sh`
espera a janela virar e tenta uma vez mais — isso não contorna a defesa, apenas para de
pedir a ela justamente o que ela existe para negar. Cinco códigos errados seguidos
bloqueiam a conta por 15 minutos (`server/lib/totp-lockout.js`, em memória: reiniciar o
contêiner limpa).
