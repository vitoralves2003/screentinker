# Mapa da VPS — produção x ambiente novo

Escrito na Fase 1. Os nomes de pasta e de container NÃO batem entre si:
a pasta `loop-os` roda a Operação, e o container `loop-player` é a Operação.
Confira sempre nesta tabela antes de rodar qualquer comando.

## PRODUÇÃO — não tocar

| Sistema  | Pasta                  | Containers                                                   | Porta (127.0.0.1) | Domínio                                  |
|----------|------------------------|--------------------------------------------------------------|-------------------|------------------------------------------|
| Operação | `/opt/loop-os`         | `loop-player`                                                 | 3010              | player.loopplayer.com.br, app.loopplayer.com.br |
| Gestão   | `/opt/loop-os-app/repo`| `loop-os-web`, `loop-os-api`, `loop-os-postgres`, `loop-os-redis` | 4000, 4001    | os.loopplayer.com.br                     |
| (antigo) | `/opt/loop-player`     | —                                                             | —                 | —                                        |

## AMBIENTE NOVO — onde o trabalho acontece

| Serviço          | Pasta                 | Container              | Porta (127.0.0.1) |
|------------------|-----------------------|------------------------|-------------------|
| Operação         | `/opt/novo-operacao`  | `novo-operacao`        | 3110              |
| Gestão — web     | `/opt/novo-gestao`    | `novo-gestao-web`      | 3120              |
| Gestão — api     | `/opt/novo-gestao`    | `novo-gestao-api`      | 3121              |
| Gestão — worker  | `/opt/novo-gestao`    | `novo-gestao-worker`   | 3122              |
| PostgreSQL       | `/opt/novo-gestao`    | `novo-gestao-postgres` | 5442              |
| Redis            | `/opt/novo-gestao`    | `novo-gestao-redis`    | 6389              |

Sem domínio público de propósito: o acesso é por túnel SSH até haver o que mostrar.
  ssh -L 3110:127.0.0.1:3110 -L 3120:127.0.0.1:3120 loopos-deploy

## Regras deste ambiente

1. Tudo escuta em 127.0.0.1. Nunca 0.0.0.0.
2. Chave da Asaas: SANDBOX. A de produção não entra aqui até o dia da virada.
3. Nenhum envio real: e-mail, WhatsApp e cobrança desligados.
4. Nada aqui altera nginx, container ou banco de produção.

## Acesso (tunel SSH, a partir do seu computador)

    ssh -L 3110:127.0.0.1:3110 -L 3120:127.0.0.1:3120 -L 3121:127.0.0.1:3121 loopos-deploy

Depois, no navegador:
  - Operacao ......... http://localhost:3110
  - Gestao (web) ..... http://localhost:3120
  - Gestao (api) ..... http://localhost:3121

## Pendencias registradas na Fase 1

- Plano de licenca `PROVISORIO-SUBSTITUIR-NO-BLOCO-4` foi inserido a mao na
  Gestao: sem um plano ativo ela recusa qualquer cadastro. Substituir pelos
  planos reais no Bloco 4.
- Conta de teste `teste-ambiente-novo@exemplo.invalid` existe nos dois
  sistemas novos. Apagar quando nao for mais util.
- Operacao ainda traz os planos de fabrica free/premium/corporate.

## Fase 1 — o que foi feito e como foi conferido

### Os quatro planos
| plano  | preco                    | telas      | armazenamento              |
|--------|--------------------------|------------|----------------------------|
| free   | R$ 0                     | 1          | 150 MB                     |
| pro    | R$ 25 por tela/mes       | ilimitado  | 1 GB por tela              |
| master | R$ 400 por pacote de 20  | ilimitado  | 25 GB por pacote, ate 100 GB |
| gestao | R$ 249/mes fixo          | nenhuma    | 5 GB                       |

### Como cada um cobra (lib/tenant-billing.js, billingMode)
- package  Master  teto(telas_do_dia / 20) pacotes por dia; mes = media x R$ 400
- device   Pro     licenca-dia por tela; mes = media x R$ 25
- flat     Gestao  valor fixo, sem medir dia nenhum

Conferido com oito casos num mes de 30 dias, todos ao centavo:
  Free 1 tela = nada . Pro 3 telas = 75,00 . Pro 3+1 por 10 dias = 83,33
  Master 20 = 400,00 . Master 41 = 1.200,00 . Master 20->21 no dia 21 = 533,33
  Master 21 do dia 8 = 706,67 . Gestao = 249,00

### Fugas fechadas no caminho
- billableWorkspaces so olhava price_per_device: Master e Gestao nunca seriam faturados.
- routes/auth.js gravava plan_id=corporate no primeiro usuario self-hosted: cadastro 500.
- Pro e Master ficaram sem armazenamento ate o teto passar a ser calculado por unidade.

### Nome do produto
config.productName e a unica fonte. PRODUCT_NAME=ZZZ-TESTE muda, junto: remetente de
e-mail, entrada no aplicativo autenticador e mensagem de diagnostico.

Continuam dizendo "ScreenTinker" DE PROPOSITO (nenhum e texto que o cliente le):
protocolo screentinker-preview/player, device_groups.sync_backend, WIDGET_NAME do Tizen
e landing.html (que nao e servida).

### Escopo
APENAS o app Android. Tizen, BrightSign e webOS estao fora. O que resta deles nao aparece
na interface: 4 rotas /api/brightsign/*, 3 rotas /tizen/*, 4 libs, e as pastas tizen/ e
brightsign/. Remover e limpeza para depois da cobranca e do login.

### Conferencias finais
- Nenhuma chave Asaas nos dois ambientes; ambos apontam para sandbox.
- Zero faturas geradas, zero cobrancas na Asaas.
- Producao intacta: 77 clientes, planos antigos, nenhum container reiniciado.

## Fase 2 — identidade unica (em andamento)

A identidade vive na OPERACAO, nao na Gestao. Motivo: 25 rotas de autenticacao contra 2
(TOTP, bloqueio por tentativa, recuperacao de senha, verificacao de e-mail, SSO por
organizacao). A Gestao ganha a segunda etapa por NAO ter login proprio.

Fluxo: entra na Operacao -> POST /api/auth/federation/gestao devolve token de troca de
60s (audience gestao, issuer operacao, segredo PROPRIO) -> POST /auth/federated na Gestao
troca por sessao dela e provisiona organizacao + usuario na primeira entrada.

- FEDERATION_SECRET e separado do JWT_SECRET dos dois. Vazio DESLIGA a federacao.
- Com federacao ligada, POST /auth/login da Gestao RECUSA. O Admin de plataforma continua
  entrando por POST /platform/auth/login (outro controlador, outro escopo).
- A entrada federada APAGA a senha que a conta tivesse antes.
- Papel: MASTER/STANDARD viraram TITULAR/OPERADOR (o nome colidia com o plano Master).
  TITULAR e derivado de canAdmin na Operacao -- uma definicao so de "quem manda".
- Papel desconhecido e RECUSA, nunca rebaixamento: um deploy fora de sincronia rebaixou um
  titular em silencio uma vez, e a verificacao agora acontece antes de qualquer escrita.

Prova: /tmp/provar_federacao.sh, 14 casos (6 do caminho feliz, 8 de recusa).

### Segunda etapa e acesso de suporte

MFA e exigido para ALCANCAR A GESTAO, nao para entrar na Operacao. Quem so troca o video
de uma tela nao e interrompido; a exigencia fica onde estao contratos, cobrancas e extrato.

- So para TITULAR (o OPERADOR nao ve o Financeiro).
- So para conta com SENHA: uma conta de SSO nao consegue cadastrar TOTP aqui, entao exigir
  dela seria tranca-la para fora para sempre. O provedor dela ja faz a segunda etapa.
- Vale tambem para quem da suporte -- quem tem mais alcance nao e isento.
- Recusa com code MFA_REQUIRED e o caminho para ativar.

ACESSO DE SUPORTE (dono da plataforma abrindo a Gestao de um cliente):
- Nao cria usuario nenhum na Gestao. O guarda de la monta o usuario a partir do TOKEN, sem
  consultar o banco, entao nao precisa existir linha -- e criar uma faria voce aparecer
  entre as pessoas do cliente e mudaria de organizacao a cada visita.
- A organizacao precisa JA existir; suporte nao cria conta pelas costas do cliente.
- Sessao de 30 minutos, nao uma hora.
- Registrado em AdminAuditLog com action gestao.acesso_suporte: quem, quando, qual cliente.

Provas: /tmp/provar_federacao.sh (14), /tmp/provar_suporte.sh (11), /tmp/provar_mfa.sh (9).
Ferramenta de teste: /tmp/mfa_lib.sh -- entrar() atravessa a segunda etapa.

## Casca unica — decisoes registradas (Fase 5)

DASHBOARD POR PLANO. Ao entrar, UM dashboard, escolhido pelo que o plano libera:
  - so Operacao ....... dashboard da Operacao
  - so Gestao ......... dashboard da Gestao
  - Master ............ um dashboard NOVO, desenhado para mostrar o conjunto
A barra lateral segue a mesma regra: mostra so o que o plano inclui.

SISTEMA DE CORES: o da OPERACAO. Nao por gosto -- por disciplina. Na Operacao o verde
aparece em UM lugar (ONLINE) e significa "esta no ar". Na Gestao ele e marca, sucesso,
fundo de painel e link ao mesmo tempo, e uma cor que significa quatro coisas nao significa
nenhuma. Fundo neutro, cor reservada para estado.

O que muda na Gestao: painel de configuracao vira card neutro; bloco de saldo neutro com
o valor em verde so se positivo; card "Continue firme" sai; verde fica na marca, nos links
e nos numeros genuinamente bons.

VOZ: a da Operacao (descritiva, seca). "Bom dia, Vitor!" e o card motivacional dao a Gestao
uma personalidade diferente, e personalidade diferente le como produto diferente.

CONVERGIR (diferencas que ninguem decidiu, sao resquicio de dois times):
  sair (rodape x item de menu) . ajuda (so na Operacao) . tema claro/escuro (so na Gestao)
  . recolher a barra (so na Gestao)

COLISAO DE PALAVRA: a Gestao diz "panorama da sua operacao hoje" enquanto Operacao e o nome
do outro modulo. Mesmo tipo do Master/master.

NO SENTIDO INVERSO: o estado vazio da Gestao e melhor. Ela recebe com "Vamos configurar sua
operacao, 0 de 4" e quatro caminhos; a Operacao mostra seis zeros e nenhum proximo passo.

### Painel do Master — layout decidido (Vitor, 29/08)

NAO e uma fila unica misturando os dois lados (proposta descartada). O layout mantem o
painel da Gestao como esta e divide a TERCEIRA coluna, no mesmo padrao que a segunda ja
usa (Contratos + Central de Mensagens):

  coluna 1 ....... Financeiro (como esta)
  coluna 2 ....... Contratos / Central de Mensagens (como esta)
  coluna 3 ....... Alertas prioritarios / TELAS  <- o cartao novo

Cartao Telas: total, no ar, fora do ar, quem precisa de atencao e por que, armazenamento
sobre o teto do plano, e "Abrir Operacao ->". Lista limitada a 3 telas + "mais N".

Cinco passos:
 1. Operacao ganha um resumo por ORGANIZACAO (os numeros ja existem; hoje sao por workspace)
 2. A Gestao pergunta servidor-com-servidor, reusando o FEDERATION_SECRET na direcao inversa
    -- sem segredo novo, sem token longo. Operacao fora do ar = so o cartao avisa; o painel
    carrega inteiro.
 3. Porta de plano: falta o espelho de gestao_enabled (o plano inclui a Operacao?). Master ve
    o cartao; Gestao avulsa NAO ve -- nem zerado.
 4. Barra lateral APROVADA: pilha unica "N coisas precisam de voce" contando os dois lados,
    secoes por plano, contagem por item (Telas 1, Contratos 12).
 5. Agrupar alertas repetidos. NAO e opcional: com a coluna dividida o painel de alertas fica
    com metade da altura, e hoje ele tem 19 itens sendo 5 a mesma frase.

Limpezas pendentes de decisao: cartoes "sem dados suficientes" (Renovacao/Churn), o bloco
"fila limpa"+"Tudo certo!", e o card motivacional "A Busca da Felicidade".

---

## C3 — o login cai onde o plano manda (feito, 29/08)

Um cliente Master acertava a senha e chegava numa pagina de telas que escondia 61 contratos
e o dinheiro do mes. O destino agora vem de `GET /api/menu`, campo `inicio` -- o MESMO
endpoint que monta a barra lateral. Um lugar so responde "o que este cliente ve", inclusive
por onde ele comeca; duas respostas para essa pergunta divergem no dia em que alguem mexe
numa delas.

  Free / Pro ......... {op}/app#/devices      -> caminho de sempre, sem travessia
  Master ............. {ge}/dashboard         -> atravessa via token de troca
  Gestao avulsa ...... {ge}/dashboard         -> idem

`onAuthSuccess` em `frontend/js/views/login.js` e o funil unico: senha, segunda etapa,
cadastro e SSO passam todos por ele. A regra vale para as quatro entradas sem repeticao.

FALHA CAI EM PE. Sem menu, sem `inicio`, sem token de troca ou com a rede fora, o caminho e
o de sempre (`#/`). Um login que nao termina em lugar nenhum e pior que um que termina no
lugar errado -- e o menu leva ao outro modulo em dois cliques.

Os controles do formulario sao travados durante a decisao: a pagina agora espera uma
resposta do servidor antes de sair, e uma tela parada convida a um segundo "Entrar".

Commit `d2b93e1`. Prova: `scripts/provas/provar_c3.sh`, 8 casos -- e o ultimo deles nao
para no "o menu respondeu?", vai ate "a sessao da Gestao abre o painel de destino".

## As provas sairam de /tmp (29/08)

As oito suites viviam em `/tmp` na VPS. Um reboot apagaria tudo. Estao em
`/opt/novo-operacao/scripts/provas/`, versionadas, com `LEIA-ME.md`. Commits `8f34cd4` e o
seguinte (`.gitattributes` fixando LF: editar no Windows e rodar no Linux produz `\r` no fim
da linha, e um script assim nao roda).

Rodar a suite DUAS VEZES seguidas encontrou dois defeitos nos proprios roteiros:

  - `provar_mfa.sh` ATIVA a segunda etapa, entao consumia a propria pre-condicao: passava
    uma vez e reprovava em todas as rodadas seguintes, num produto intacto. Cada prova agora
    prepara o proprio terreno e o resultado nao depende da ordem de execucao.
  - Tres checagens aprovavam lixo: `sed` que nao casa devolve a entrada inteira (entao
    `[ -n "$X" ]` aceitava uma mensagem de erro como token) e `grep -q ""` casa com qualquer
    coisa. E a federacao seguia rodando depois de um login falho, transformando uma causa em
    cinco falhas e enterrando a que importava.

Estado: 80 checagens, duas rodadas consecutivas limpas.

## Ainda em aberto

  C4 ...... filtrar a lista de telas na Operacao (`?f=` e `?id=`); hoje `dashboard.js` nao
            tem filtro nenhum. E o que faz o cartao de Telas virar link util.
  C5 ...... cartao de Telas clicavel, com as rotas vindo do servidor junto com os numeros.
  C6 ...... conferir na tela o alerta de telas na barra da Gestao (o codigo saiu no C2).
  Fase B .. Gestao sob /gestao no dominio da Operacao. Mexe em nginx compartilhado com sete
            pilhas de PRODUCAO -- e a primeira mudanca deste trabalho que pode derrubar o
            que esta no ar.
  Bloco 0 . NUNCA FEITO. Nao ha backup fora da VPS e a restauracao nunca foi testada. Os
            commits protegem contra erro de comando; nao protegem contra a maquina morrer.
            Vale fechar ANTES da Fase B.
  Relatorios abrangendo os dois modulos e FUNCIONALIDADE NOVA -- a Gestao nao tem pagina de
  relatorios. O item de menu aponta hoje para a pagina que a Operacao ja tem.
