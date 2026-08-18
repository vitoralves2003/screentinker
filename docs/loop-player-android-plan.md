# Publicando o app Loop Player para Android

**Situação: A, B, C e a assinatura aplicadas, e o APK está publicado em produção** (commits `8e628b2`, `8edc7ee`, `a1df2f2`). O app já se chama
Loop Player, usa o ícone próprio e traz o endereço do servidor gravado. Falta a variante de loja
(fase D), a navegação por controle remoto (E), a chave e a esteira (F) e o envio (G).

Objetivo: **Adicionar tela** oferece Android e mais nada; o app que o cliente instala se chama Loop
Player, tem o nosso ícone e já sabe o endereço do servidor, de modo que instalar uma tela é
"instalar, ler o código que aparece na tela, digitar no painel". O app é publicado na Google Play
e, depois, na Amazon Appstore.

---

## 1. Decisões já tomadas

| decisão | valor |
|---|---|
| Identificador do app | **`br.com.loopplayer.player`** — permanente após a primeira publicação |
| Ícone | eu faço a primeira versão a partir da marca que já está no painel |
| Ordem das lojas | **Google Play primeiro**, Amazon depois |
| Conta de desenvolvedor | já existe |
| Chave de assinatura | criada 18/08/2026, alias `loopplayer`, validade até 2053. Backups em OneDrive e disco D: |

Duas consequências do identificador novo que vale registrar agora:

- Para o Android, o Loop Player passa a ser um app **diferente** do atual. Os painéis que já rodam a
  versão antiga não se atualizam sozinhos: cada um precisa de uma reinstalação manual. Quanto antes
  isso acontecer, menos painéis serão.
- O identificador aparece em lugares fora do app: em [server.js:1311](../server/server.js#L1311)
  (`DEVICE_ADMIN_COMPONENT`, que monta o QR de proprietário e o comando ADB), no teste
  `server/test/device-owner-qr.test.js`, que compara a string exata, e em
  [docs/device-owner-provisioning.md](device-owner-provisioning.md). Os três mudam junto.

---

## 2. Como as coisas estão hoje

**O modal** ([frontend/index.html:225-250](../frontend/index.html#L225-L250)) oferece quatro
players (APK Android, Player web, Raspberry Pi, Windows), uma linha de instrução para Smart TVs e um
bloco "Endereço do servidor" mandando o cliente digitar aquele endereço no app. O botão do QR de
proprietário fica logo abaixo.

**O app ainda não é nosso.**

| | hoje | precisa ser |
|---|---|---|
| identificador | `com.remotedisplay.player` | `br.com.loopplayer.player` |
| nome no Android | `RemoteDisplay` | Loop Player |
| ícone | `@android:drawable/ic_media_play` — um ícone **do sistema Android** | ícone adaptativo próprio |
| arquivos de ícone | nenhum (não existe nenhuma pasta `mipmap-*`) | jogo completo de densidades + 512px da Play + banner de TV |
| textos | `ScreenTinker` aparece no `strings.xml` e nas traduções | Loop Player |
| declarações de TV | tem `LEANBACK_LAUNCHER`, mas falta `android:banner` e `uses-feature` | obrigatórias para listar como app de TV |

**O endereço do servidor é digitado à mão.** A
[ProvisioningActivity.kt:90-115](../android/app/src/main/java/com/remotedisplay/player/ProvisioningActivity.kt#L90-L115)
mostra primeiro um campo de URL e só depois o código de pareamento. Mas o caminho automático que
precisamos **já existe e já roda em produção**: `ServerConfig.consumePendingAutoConnect()` pula a
entrada de URL e vai direto para o registro, e o QR de proprietário já usa isso
([ProvisioningExtras.kt](../android/app/src/main/java/com/remotedisplay/player/admin/ProvisioningExtras.kt)).
Gravar o endereço no APK é ligar um valor padrão a um caminho que já está pronto e testado.

**Ferramental.** Gradle 8.5, AGP 8.2.0, Kotlin 1.9.20, `compileSdk`/`targetSdk` 34, `minSdk` 24. O
CI já instala Java 17 e o SDK do Android para rodar os testes Kotlin
([ci.yml:66-92](../.github/workflows/ci.yml#L66-L92)), então ele também consegue gerar os arquivos
das lojas. **O Java e o SDK do Android já estão instalados aqui** (seção 7.5); o que ainda não existe é a chave de
assinatura (`android/release-key.jks` não está aqui, e está no `.gitignore`).

**Como os lançamentos funcionam hoje:** o [scripts/finalize-release.sh](../scripts/finalize-release.sh)
compila localmente e sobe para o GitHub Releases; o servidor entrega em `/download/apk` o APK que
encontrar. Quando não encontra nenhum, ele mostra uma página de erro escrita **"APK Not Available —
ScreenTinker"** com link para `github.com/screentinker/screentinker`
([server.js:1458](../server/server.js#L1458)) — uma página que o cliente vê, anunciando o projeto de
onde este código veio.

---

## 3. Fase A — o modal ✅ feito

Um commit, pequeno, independente de todo o resto.

- Remover os botões Player web, Raspberry Pi e Windows, e a linha das Smart TVs.
- Remover o bloco "Endereço do servidor": com o endereço embutido, ele instrui algo que ninguém
  precisa fazer.
- Trocar o link único do APK pelo link da loja, mais um APK direto para painéis sem loja.
- Manter o QR de proprietário — ele é específico de Android e é o que destrava a atualização
  silenciosa.
- Remover as chaves `add_display.*` que ficam órfãs nos cinco arquivos de tradução.
- Reescrever a página de erro do `/download/apk` com as palavras do Loop Player, sem link para o
  projeto de origem.

Nada mais quebra: `/player`, o script do Raspberry Pi e o do Windows continuam acessíveis para quem
tiver o endereço; apenas deixam de ser anunciados.

---

## 4. Fase B — a identidade Loop Player ✅ feito

**O pacote Kotlin continua sendo** `com.remotedisplay.player`; muda só o identificador do app. O
nome do pacote é interno e invisível para o usuário; renomear umas quarenta fontes não traz ganho
nenhum e traz risco.

**O ícone.** A marca já está no painel: `frontend/assets/loop-player-icon.png` (180×180) e
`loop-player-symbol.png` — o laço/infinito em verde `#20DF91`, o mesmo `--sidebar-brand` do painel.
O desenho é geometria simples, então a primeira versão será **redesenhada como vetor**, e não
ampliada a partir do PNG de 180px — assim sai nítida em qualquer tamanho. Dela saem:

- ícone adaptativo: camada de frente (o laço), camada de fundo (verde ou escuro), e a camada
  monocromática que o Android 13+ usa nos ícones temáticos
- as densidades antigas, de `mipmap-mdpi` a `mipmap-xxxhdpi`
- banner de TV, 320×180
- ícone da listagem na Play, 512×512, e a imagem de destaque, 1024×500

Enquanto estivermos nisso: `frontend/assets/icon-192.png` e `icon-512.png` — os ícones que o painel
usa quando é instalado como aplicativo no celular — **ainda são o ícone azul do ScreenTinker**, uma
TV com um botão de play. O cliente vê isso na tela inicial do próprio telefone.

**Textos:** `app_name`, as descrições do serviço de acessibilidade e do administrador de
dispositivo, e cada ocorrência de `ScreenTinker` em `values/` e `values-de|es|fr|hi|pt/`.

---

## 5. Fase C — o endereço do servidor gravado no app ✅ feito

Usando **product flavors** do Gradle, para que um mesmo código gere o nosso app e o de quem hospeda
por conta própria:

| variante | endereço embutido | primeira execução |
|---|---|---|
| `loop` | `https://player.loopplayer.com.br` | vai direto ao código de pareamento |
| `selfhosted` | vazio | pede a URL, como hoje |

Na prática: um `buildConfigField` por variante (o AGP 8 exige
`buildFeatures { buildConfig = true }`), e na primeira execução — dentro do
`RemoteDisplayApp.onCreate`, para que todo caminho de entrada passe por lá — se o endereço guardado
estiver vazio e o embutido não estiver, grava o embutido e chama `setPendingAutoConnect(true)`. A
`ProvisioningActivity` já faz o resto sozinha.

Resultado: instalar → assistente de permissões → código de seis dígitos na tela. Sem digitar nada,
sem configurar nada.

O "Alterar URL do servidor" continua no menu escondido atrás do PIN. É o único jeito de mover um
painel para outra instalação, e já está protegido por um PIN diferente em cada aparelho.

Testes: uma instalação nova da variante `loop`, sem rede, chega na tela de pareamento em vez do
campo de URL; uma instalação nova da `selfhosted` continua pedindo a URL.

---

## 6. Fase D — o que a Google Play aceita e o que ela não aceita ⬜ próxima

Esta é a parte que determina o prazo, e vale ser direto: **o app do jeito que está hoje muito
provavelmente seria recusado.** São quatro motivos, todos contornáveis.

1. **O serviço de acessibilidade.** O `PowerAccessibilityService` existe para controle remoto de
   energia e navegação do sistema. A Play exige que APIs de acessibilidade sirvam à acessibilidade.
   É uma das políticas mais fiscalizadas que existem.
2. **A auto-atualização.** O `UpdateChecker` baixa um APK do nosso servidor e o instala
   (`REQUEST_INSTALL_PACKAGES`). Para um app distribuído pela Play, isso é violação de "Device and
   Network Abuse" — quem instalou pela Play é atualizado pela Play.
3. **Localização só para ler o nome do Wi-Fi.** A permissão `ACCESS_FINE_LOCATION` é pedida apenas
   para a página do dispositivo mostrar em que rede o painel está. Ela arrasta junto uma exigência
   de aviso destacado ao usuário, por um campo cosmético.
4. **`targetSdk` 34** está abaixo do que a Play exige de apps novos. O piso precisa ser confirmado
   no Play Console — ele sobe todo mês de agosto — e subir esse número exige testar de novo os
   serviços em primeiro plano e o acesso a arquivos em painel real.

**Por isso, três variantes em vez de duas:**

| variante | destino | acessibilidade | auto-atualização | localização | proprietário do dispositivo |
|---|---|---|---|---|---|
| `loop` | `/download/apk`, instalação direta nos painéis | sim | sim | opcional | sim |
| `loopStore` | Google Play e Amazon | **não** | **não** — quem atualiza é a loja | **não** | sim |
| `selfhosted` | quem hospeda por conta própria | sim | sim | opcional | sim |

A variante de loja remove essas permissões por um manifesto próprio
(`src/loopStore/AndroidManifest.xml`, com `tools:node="remove"`) e não compila o atualizador. É um
app genuinamente menor, e a descrição na loja fala do que ele faz, não do que a versão de painel faz.

De qualquer forma precisa ser declarado na Play: a captura de tela (`MediaProjection`, usada nas
capturas remotas — ela já pede consentimento), os serviços em primeiro plano e seus tipos, o
comportamento de lançador (HOME) e o receptor de administrador de dispositivo. A Play aceita apps de
quiosque e de sinalização digital; ela quer que sejam descritos honestamente.

Além disso: a Play exige um **AAB**, e o Play App Signing reassina esse arquivo. Qualquer código que
compare a assinatura em execução com uma assinatura conhecida não pode rodar na variante de loja —
mais um motivo para o atualizador não existir nela.

---

## 7. Fase E — televisão ⬜ parcial

As declarações já entraram junto com o ícone: `touchscreen` e `leanback` estão marcadas como não
obrigatórias, e o banner 320×180 existe e é gerado pelo mesmo script dos ícones. **Falta a parte que
só se resolve em aparelho:**

- **Navegação pelo controle remoto nas telas de configuração.** O player em si é tela cheia e não
  tem problema; o assistente de permissões e a tela de pareamento precisam funcionar só com o
  direcional do controle. Isso se testa em aparelho real, não em emulador.

---

## 7.5. Compilando nesta máquina ✅ pronto

Gradle e Kotlin não se instalam: o `gradlew` do projeto baixa o Gradle 8.5 e o plugin do Kotlin
sozinho. O que faltava era o Java e o SDK do Android, e os dois estão instalados **no perfil do
usuário, sem exigir administrador**:

| | onde | estado |
|---|---|---|
| JDK 17 (Temurin) | `C:/dev/jdk17` | `JAVA_HOME` já apontado |
| Android SDK | `C:/dev/android-sdk` | `ANDROID_HOME` já apontado; plataforma 34, build-tools 34.0.0, platform-tools |

Instalados fora da pasta do usuário de propósito: o caminho do perfil tem um espaço no nome, e o
SDK do Android tropeça nisso.

`android/local.properties` aponta o SDK com **barras normais**. É um arquivo de propriedades Java,
onde a contrabarra vale como escape — com ela, o caminho chega ao Gradle sem as pastas e o build
morre em "a sintaxe do nome do arquivo está incorreta".

Para compilar:

```bash
cd android
./gradlew :app:testLoopDebugUnitTest      # testes do avaliador de agenda
./gradlew :app:assembleLoopDebug          # APK instalável, assinado com a chave de debug
./gradlew :app:assembleLoopRelease        # exige a chave de release
```

O APK sai em `android/app/build/outputs/apk/loop/debug/app-loop-debug.apk`. Para instalar num
painel ligado por USB: `adb install -r <caminho do apk>`.

---

## 8. Fase F — assinatura e esteira de compilação ◐ chave feita, esteira pendente

**Sobre a chave, que você deixou para depois: para publicar na Play ela é o primeiro passo, não o
último** — o arquivo enviado tem que estar assinado. A boa notícia é que a Play muda o risco a
nosso favor: com o **Play App Signing**, o Google guarda a chave definitiva do app e a nossa serve
só para enviar (chave de envio). Se ela for perdida, o Google emite outra e a publicação continua.
Na Amazon não existe essa rede de proteção — perder a chave lá significa nunca mais atualizar
aquela listagem. Como a Play vem primeiro, dá para começar com uma chave de envio e tratar a
custódia com calma antes da Amazon.

Criar a chave é um comando (`keytool`, RSA 2048, validade de 25 anos ou mais). A senha vai para um
gerenciador de senhas e o arquivo `.jks` para dois backups separados. Nunca para dentro do
repositório.

**Compilar no CI, não no notebook.** O CI já tem Java 17 e o SDK do Android. Um job disparado por
tag, lendo a chave de um secret, produz:

- `loopStoreRelease` → o `.aab` da Play e um `.apk` para a Amazon
- `loopRelease` → o APK assinado dos painéis, que o `/download/apk` entrega

O `versionCode` precisa aumentar a cada envio; o mecanismo já existe (`VERSION_CODE` em
[app/build.gradle.kts](../android/app/build.gradle.kts)) e o `scripts/bump-version.sh` já o
sincroniza. A Play recusa um número repetido.

É isso também que dispensa você de instalar o Android Studio: cria-se uma tag, baixam-se os arquivos
prontos e sobem-se no console.

---

## 8.5. O APK publicado na instalação ✅ feito

O botão **Loop Player para Android** do modal entrega um APK de verdade:

- assinado com a chave de release, verificado nos três esquemas (v1, v2 e v3)
- 8,7 MB, servido por `https://player.loopplayer.com.br/download/apk`
- o arquivo mora em `/data/LoopPlayer.apk` dentro do volume `st-data` do container

Para trocar de versão: compile o `assembleLoopRelease`, copie para o servidor e substitua o
arquivo. O servidor reexamina a pasta a cada 60 segundos — não precisa reiniciar nada.

```bash
scp android/app/build/outputs/apk/loop/release/app-loop-release.apk loopos-deploy:/tmp/LoopPlayer.apk
ssh loopos-deploy "docker cp /tmp/LoopPlayer.apk loop-player:/data/LoopPlayer.apk && rm /tmp/LoopPlayer.apk"
```

Backups do banco antes de cada migração ficam em `/opt/loop-os-backups/` no servidor.

---

## 9. Fase G — o envio para a loja (a sua parte, no navegador) ⬜ pendente

**Google Play** — a conta já existe, então:

1. Criar o app no console e preencher a ficha: nome, descrição curta e completa, ícone 512×512,
   imagem de destaque 1024×500, capturas de tela de celular e, se houver listagem de TV, de TV.
2. Endereço da política de privacidade — já publicamos uma em `/legal/privacy.html`.
3. Formulário de segurança de dados: declarar a captura de tela, os identificadores de dispositivo e
   o que mais a variante de loja ainda coletar.
4. Questionário de classificação indicativa; público-alvo (não infantil).
5. Enviar o `.aab` primeiro para **teste interno**, instalar num painel real pelo link da Play, e só
   então promover para produção.
6. Reservar de uma a três semanas para a primeira análise.

**Amazon Appstore** — depois da Play:

1. Criar a conta (gratuita).
2. Enviar o **APK** — o suporte da Amazon a AAB é limitado.
3. Declarar compatibilidade com Fire TV / tablets Fire e enviar as capturas nos tamanhos deles.
4. A análise costuma ser mais rápida e as políticas são mais permissivas que as da Play.

---

## 10. Ordem e custo de cada fase

| fase | trabalho | depende de |
|---|---|---|
| A — modal | ✅ feito | — |
| B — identidade e ícone | ✅ feito | — |
| C — endereço embutido | ✅ feito | — |
| D — variantes e políticas | 1 a 2 dias | decidir o conjunto de recursos da versão de loja |
| E — televisão | testes | um Fire TV / Android TV de verdade |
| F — esteira | meio dia | a chave de envio |
| G — loja | seu tempo | a análise da Google |

A é independente de tudo: o modal pode sair hoje, porque ele só deixa de anunciar coisas.

---

## 11. Riscos que vale nomear agora

- **O identificador novo deixa as instalações atuais para trás.** Cada painel que já roda o app
  precisa de uma reinstalação manual. Barato agora, caro depois.
- **A aprovação na Play não é garantida.** A variante `loopStore` é desenhada para passar, mas a
  primeira submissão ainda pode voltar com perguntas sobre o quiosque e o administrador de
  dispositivo.
- **Subir o `targetSdk` é a mudança com maior chance de quebrar a reprodução.** Serviços em primeiro
  plano e acesso a arquivos mudaram desde a API 34. Testar no painel mais antigo que suportamos
  (Android 7, `minSdk` 24) e num atual.
- **Painéis instalados pela loja perdem a atualização silenciosa.** A maior parte do hardware de
  sinalização não tem Play Store, e é por isso que a variante `loop` continua sendo a distribuição
  principal e as lojas atendem boxes e sticks de consumo.
