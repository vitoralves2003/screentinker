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

DEPOIS DA FASE B E UMA PORTA SO. Nao e comodidade: e o ponto da fase. Duas portas eram duas
origens, e duas origens eram dois produtos.

    ssh -L 3100:127.0.0.1:3100 loopos-deploy

Depois, no navegador, tudo em http://localhost:3100 :
  - Operacao ......... /            (e /app, /api, /player, /socket.io)
  - Gestao ........... /gestao
  - API da Gestao .... /gestao-api

As portas 3110 / 3120 / 3121 seguem publicadas em 127.0.0.1 e as provas batem nelas
diretamente, para conseguir isolar um lado quando algo quebra. Elas saem na virada.

    ssh -L 3110:127.0.0.1:3110 -L 3120:127.0.0.1:3120 -L 3121:127.0.0.1:3121 loopos-deploy

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

## Fase 2 — identidade unica (feita, 31/08)

A identidade vive na OPERACAO, nao na Gestao. Motivo: 25 rotas de autenticacao contra 2
(bloqueio por tentativa, recuperacao de senha, verificacao de e-mail, SSO por organizacao).

### Uma sessao so (Etapa 2b)

Fluxo hoje: entra na Operacao, e pronto. O token que ela emite E a sessao dos dois modulos.
Atravessar de um lado para o outro e um link.

Antes eram tres passos e duas sessoes: POST /api/auth/federation/gestao devolvia um token de
troca de 60 segundos, o navegador ia para /gestao/entrar com ele no fragmento da URL, e
POST /auth/federated trocava por uma sessao propria da Gestao. Isso existia porque "origens
diferentes nao compartilham sessao" -- verdade quando foi escrito, e falsa desde a Fase B, que
pos os dois atras de 127.0.0.1:3100.

O que sumiu: a rota de troca, /auth/federated, a pagina /entrar, frontend/js/atravessar.js,
FEDERATION_SECRET e federationTokenTtl.

O que entrou: OPERACAO_JWT_SECRET no .env da Gestao -- o MESMO valor do JWT_SECRET da
Operacao, byte a byte. Nao e um segredo novo; e o de la, lido aqui. O guarda da Gestao tenta o
segredo proprio primeiro (tokens antigos seguem valendo ate expirar) e depois este.

### O que o token carrega, e por que cada campo esta la

    organization_id     o mesmo uuid dos dois lados -- o vinculo e identidade, nao tradutor
    organization_name   para a Gestao nomear a conta sem ter de perguntar
    papel               TITULAR/OPERADOR, de canAdminWorkspace
    acting_as           quem chegou por ser admin de plataforma, nao por ser membro
    gestao_enabled      se o plano do cliente inclui a Gestao

O `gestao_enabled` e o campo que menos parece precisar existir e mais precisa. A trava do plano
vivia dentro da rota de troca -- era o unico lugar que decidia se a Gestao faz parte do plano.
Apagar a rota sem mover a trava entregaria clientes, contratos e financeiro a um plano Free, em
silencio: o menu ja esconde os itens, entao ninguem clicaria para descobrir.

Quem DECIDE continua sendo a Operacao (onde plano e cobranca moram). Quem RECUSA e o guarda da
Gestao, com 403 -- nao 401, porque a sessao e valida e mandar a pessoa fazer login de novo a
poria num laco.

### Regras que sobrevivem, e onde cada uma mora agora

- Papel desconhecido e RECUSA, nunca rebaixamento. Um token sem papel nao entra. Cair em
  OPERADOR "por seguranca" seria um rebaixamento silencioso: o titular perde o Financeiro sem
  erro e sem log. Ja aconteceu aqui, com um ternario.
- O `sub` do request e o User.id da GESTAO, resolvido pelo E-MAIL -- nao o id da Operacao.
  Ele vira chave estrangeira em dezenas de escritas de la; quem chegou por outro caminho
  (semente, autocadastro) tem id proprio, e cada escrita apontaria para uma linha inexistente.
- POST /auth/login da Gestao RECUSA enquanto OPERACAO_JWT_SECRET existir. A condicao
  perguntava por FEDERATION_SECRET, apagado nesta etapa -- apagar a variavel teria REABERTO a
  porta, sem erro nenhum. O Admin continua entrando por POST /platform/auth/login.
- A conta na Gestao nasce e permanece SEM senha.
- No navegador, quem e a pessoa vem do TOKEN, nao de um objeto guardado ao lado. A pagina
  /entrar era quem escrevia 'loop_os_user'; sem ela, quatro telas que so perguntam se o papel
  e TITULAR leriam null e todo titular perderia o Financeiro em silencio.

### Acesso de suporte (dono da plataforma abrindo a conta de um cliente)

- Nao cria usuario nenhum na Gestao. O guarda monta o usuario a partir do TOKEN, sem consultar
  o banco -- e criar uma linha faria voce aparecer entre as pessoas do cliente e, como o e-mail
  e unico la, mudaria de organizacao a cada visita.
- A organizacao precisa JA existir; suporte nao cria conta pelas costas do cliente.
- Sessao de 30 MINUTOS, nao os sete dias de config.jwtExpiry. A regra vinha da rota de troca e
  teria sumido com ela; agora mora em generateToken, e por isso vale para os DOIS modulos --
  antes ver as telas de outra empresa ficava aberto a semana inteira.
- Registrado no activity_log da Operacao, action `suporte:entrou_na_conta`, escrito em
  POST /api/auth/switch-workspace. Antes so registrava quem atravessasse para a Gestao; agora
  registra a ENTRADA na conta, que e o momento que importa: ver as telas de outra empresa
  tambem e acesso a dados dela.

### Segunda etapa: nao existe mais

Removida a pedido do Vitor. Nao ha TOTP, nem exigencia para alcancar a Gestao. O que era
`preparar_mfa` nas provas virou funcao vazia, e `entrar()` e POST /login e pegar o token.

### Provas

    /tmp/provar_sessao_unica.sh   15 casos -- reescrita de provar_federacao.sh
    /tmp/provar_plano.sh           7 casos -- os quatro planos contra a API da Gestao
    /tmp/provar_suporte.sh        12 casos
    /tmp/provar_resumo.sh          7 casos
    /tmp/provar_mfa.sh            13 casos -- prova a REMOCAO da segunda etapa

Ferramenta: /tmp/mfa_lib.sh. A funcao `entrar()` so repete em 429 (o limite e 10 logins por
minuto por IP); repetir em 401 mediria a senha errada quatro vezes.

DUAS SUITES MEDIAM ROTAS QUE NAO EXISTIAM MAIS, e uma delas ha duas etapas: provar_resumo.sh
apontava para /api/federation/telas, apagada na Etapa 1, e devolvia 404 em tudo -- inclusive
nas quatro recusas, que "passavam" por motivo nenhum. Um 404 nao e uma recusa; e a ausencia de
qualquer opiniao. Ao apagar uma rota, procure quem a media.

CUIDADO COM CORTE POR ANCORA. Ao remover a federacao do server/config.js, o corte foi "do
comentario ate o ultimo campo dela" -- e config.gestaoUrl morava no meio. Saiu junto, node
--check passou, o servidor subiu, e o menu e a fileira de configuracoes simplesmente pararam
de mostrar a Gestao, porque os dois tratam vazio como "nao ha Gestao neste servidor".


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

### Fase D — uma so aparencia (Vitor reafirmou em 29/08, olhando os dois paineis)

"A sidebar diverge uma da outra ainda, mesmo contendo a maioria dos itens iguais. Precisamos
definir um unico esquema de cores e estilos de letras."

MEDIDO NO CODIGO, nao a olho. As barras ja tem os MESMOS itens, a mesma largura (232px) e o
mesmo desenho de secoes -- isso saiu no C2. O que sobra:

  1. COR DA BARRA -- FEITO EM 29/08. A Gestao definia os tokens duas vezes: no tema ESCURO
     ja usava #031525/#94A3B8, identicos aos da Operacao; no CLARO usava #061C2C/#CBD5E1.
     Como o claro e o padrao, as duas barras eram dois azuis diferentes lado a lado, e a
     causa era um bloco de tema, nao uma decisao. Igualados aos da Operacao.

  2. TIPOGRAFIA -- EM ABERTO, e a unica peca onde "o esquema da Operacao vence" nao se
     aplica sozinha. A Operacao NAO escolheu uma fonte: usa a pilha do sistema
     (-apple-system, Segoe UI, Roboto...), o que no Windows vira Segoe UI. A Gestao carrega
     Geist, que E uma escolha. Adotar a pilha do sistema em tudo unifica para baixo -- troca
     uma tipografia escolhida por nenhuma. RECOMENDACAO: Geist nos dois. Precisa da palavra
     do Vitor, porque contraria a regra geral que ele deu.

  3. MARCA. "Loop Player" na Operacao e "Loop OS" na Gestao, dois logotipos diferentes na
     mesma sessao. E a divergencia que mais grita "sao dois produtos", e nao e CSS: sao
     arquivos de imagem e uma decisao de nome.

  4. RODAPE DA BARRA. Operacao: bloco do workspace no topo, avatar + nome + sair no rodape,
     e Ajuda. Gestao: nada disso, "Sair" como item de menu, e um botao de recolher.

  5. ICONES. Os mesmos itens usam desenhos diferentes nos dois lados (Telas e uma grade la e
     um documento aqui). Mesmo nome, mesmo destino, simbolo diferente.

  6. O CONTEUDO das paginas (cards, tabelas, escala de texto) segue divergente. E o maior
     volume de trabalho e nao e o que o cliente reclamou -- fica para depois de 1 a 5.

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
 2. [SUPERADO NA ETAPA 1] Era "a Gestao pergunta servidor-com-servidor, reusando o
    FEDERATION_SECRET na direcao inversa". Nao foi assim: o NAVEGADOR pergunta direto, em
    GET /api/resumo/telas, com a sessao que ja tem -- os dois modulos estao na mesma origem
    desde a Fase B, entao nao ha segredo nem salto entre servidores. Operacao fora do ar = so
    o cartao avisa; o painel carrega inteiro.
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

## C4 + C5 — o cartao de Telas aponta para as telas que conta (feito, 29/08)

O cartao dizia "2 precisam de atencao" e nao levava a lugar nenhum; a linha da barra lateral
dizia o mesmo e levava a uma pagina com a frota inteira. Agora cada numero e um link para o
recorte que ele conta.

CORRECAO DE UM REGISTRO ANTERIOR: este documento dizia que `dashboard.js` nao tinha filtro
nenhum. Tinha -- busca por nome e um seletor de estado, aplicados sobre as linhas ja
desenhadas. O que faltava era um filtro que viesse da ROTA, para que um numero mostrado em
outro lugar pudesse apontar para ele.

  #/devices?f=atencao      as que o SERVIDOR diz que precisam de atencao
  #/devices?f=fora-do-ar   as que ele conta como fora do ar
  #/devices?f=no-ar        as que ele conta como no ar
  #/devices?id=<id>        uma tela em particular

QUEM DECIDE E O SERVIDOR. `f=atencao` nao recalcula nada no navegador: pergunta a
/api/devices/overview e usa os ids que vierem. `server/lib/fleet-attention.js` existe porque
essa conta ja foi feita em dois lugares e os dois discordaram -- o navegador contava tudo que
estivesse offline, sem saber que horario de funcionamento existe, e acendia o alerta toda
noite para uma padaria que so tinha fechado. Refazer a regra no filtro recriaria esse bug de
cabeca para baixo, com o agravante de que agora o alerta e um link.

A VISTA FILTRADA E PLANA, sem grupos e sem walls. Nao e simplificacao: uma tela dentro de um
video wall NAO tem linha propria na lista normal (o card do wall a representa), mas ELA
APARECE na lista de atencao do servidor. Filtrar dentro do layout normal esconderia
exatamente a tela que o alerta mandou olhar.

OS LINKS SAO MONTADOS PELA OPERACAO, junto com os numeros (`links` em
/api/federation/telas). Se a Gestao os montasse, passaria a conhecer a estrutura de rotas do
outro sistema, e mudar uma rota la quebraria o cartao sem nada acusar naquele repositorio.
Sem os links, o cartao continua legivel e apenas nao clicavel -- nada inventa endereco de
reserva.

A VOLTA NAO PRECISA DE FEDERACAO. Gestao -> Operacao sao `<a href>` comuns: o navegador ja
tem a sessao da Operacao naquela origem, porque e por la que se entra. A federacao existe no
sentido Operacao -> Gestao porque o login proprio da Gestao esta fechado.

Commits `01a8cf8` (Operacao) e `7a42f2c` (Gestao). Prova: `scripts/provas/provar_c4c5.sh`,
11 casos. Ela compara o NUMERO DO CARTAO com o TAMANHO DO RECORTE que o link abre -- e o
dado de teste foi ajustado para que `atencao` (2) DIFIRA de `fora do ar` (1), com uma tela no
ar e sem playlist. Sem essa diferenca a prova passaria mesmo se as duas regras tivessem sido
trocadas uma pela outra.

## Fase B — um endereco so (feita, 29/08)

    http://localhost:3100/          Operacao (e /app, /api, /player, /socket.io)
    http://localhost:3100/gestao    Gestao
    http://localhost:3100/gestao-api  API da Gestao

Mesma origem significa mesmo localStorage: as duas sessoes convivem, e clicar em "Contratos"
deixa de ser um login federado com tela de "Entrando..." no meio. A federacao continua
existindo e continua necessaria -- e ela que provisiona a conta e carrega o papel na
primeira entrada. So deixou de aparecer.

QUEM SE MOVEU FOI A GESTAO. A Operacao nao podia: as telas em campo apontam para a raiz, e
move-la exigiria reconfigurar painel por painel, alguns em teto de padaria. A Gestao e Next
e tem basePath, entao o custo caiu inteiro do lado que podia pagar.

CORRECAO DE UM RISCO QUE EU DESCREVI ERRADO, duas vezes, aqui e em conversa: eu disse que a
Fase B "mexe em nginx compartilhado com sete pilhas de producao". Nao mexe. O /etc/nginx
desta maquina tem um ARQUIVO POR SITE (oito), e nenhum deles aponta para o ambiente novo --
producao e app->3010 e os->4000/4001; o ambiente novo so existe por tunel. Compartilhado e
o PROCESSO, e um config quebrado e pego pelo `nginx -t` antes de qualquer reload.

Mesmo assim o proxy virou um CONTAINER PROPRIO (novo-proxy, 127.0.0.1:3100) e nao um arquivo
no nginx do sistema: sem backup fora da maquina, um reload evitavel e um risco que nao
precisa ser corrido. O deploy/nginx-unificado.conf e exatamente o que entra em producao na
virada, entao isto e ensaio e nao maquete.

DUAS ARMADILHAS QUE O CONFIG DESVIA, e ambas estao comentadas nele:
  - SEM bloco `upstream`. Um upstream com nome de container e resolvido UMA VEZ, na partida:
    depois de qualquer rebuild o nginx guarda o IP velho e devolve 502 para um servico que
    esta de pe. Le-se como "a Gestao caiu". Destino em variavel + resolver 127.0.0.11 resolve
    por requisicao. O caso 6 da prova derruba um container so para verificar isso.
  - /gestao-api perde o prefixo (rewrite) e /gestao NAO perde. A API nao sabe que vive sob um
    prefixo; o Next foi COMPILADO sabendo. Trocar os dois quebra os dois.

/gestao esta livre: as 16 rotas de topo da Operacao foram conferidas no codigo, nenhuma
comeca com "gestao". REGRA PARA O FUTURO: antes de criar rota de topo nova na Operacao,
conferir esta lista.

Commits: `deploy/nginx-unificado.conf` + compose (Operacao), basePath/assetPrefix + Dockerfile
+ compose (Gestao). Prova: `scripts/provas/provar_faseb.sh`, 12 casos. O caso 5 e o que
resume a fase: le o menu inteiro e reprova se UM destino sequer sair de outra origem.

O QUE FALTA DA FASE B PARA A VIRADA (nao vale no ambiente novo, so em producao):
  - arquivo em /etc/nginx/sites-enabled para o dominio real, com certificado;
  - os.loopplayer.com.br com redirecionamento permanente para /gestao, para nao quebrar o
    que estiver salvo no navegador de alguem;
  - despublicar 3110/3120/3121.

## Ainda em aberto

  C6 ...... conferir na tela o alerta de telas na barra da Gestao (o codigo saiu no C2).
  Fase B .. Gestao sob /gestao no dominio da Operacao. Mexe em nginx compartilhado com sete
            pilhas de PRODUCAO -- e a primeira mudanca deste trabalho que pode derrubar o
            que esta no ar.
  Bloco 0 . NUNCA FEITO. Nao ha backup fora da VPS e a restauracao nunca foi testada. Os
            commits protegem contra erro de comando; nao protegem contra a maquina morrer.
            Vale fechar ANTES da Fase B.
  Relatorios abrangendo os dois modulos e FUNCIONALIDADE NOVA -- a Gestao nao tem pagina de
  relatorios. O item de menu aponta hoje para a pagina que a Operacao ja tem.
