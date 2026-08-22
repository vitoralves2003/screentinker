# Ciclo das Telas — plano de implementação

Documento de plano. Nada implementado.

Cinco frentes na área de Telas, na ordem em que eu as faria. A medição de produção vem
primeiro, porque é ela que torna três delas baratas.

---

## O que está medido em produção

Consultado no banco da VPS em 22/08/2026.

| medida | valor | o que significa |
|---|---|---|
| itens de playlist com zona | **0** | o modelo antigo de zona nunca foi usado |
| telas usando layout | **1** | trocar o modelo não quebra ninguém |
| `playlist_item_schedules` | **0 linhas** | agendamento por item nunca foi usado |
| `schedules` (calendário) | **0 linhas** | idem; a rota `/api/schedules` nem está montada |
| `content.expires_at` preenchido | **0** | o campo já existe e está livre |
| telas em `tier 2` | **0** | nenhum aparelho é device owner |
| `accessibility_enabled` | **0 em todas** | o serviço de acessibilidade não está ligado em lugar nenhum |

Zonas e agendamento custam **zero de migração**. Não há dado a converter.

---

## 1. Substituir tela

O centro do plano, e o que hoje causa perda real de dado.

### O defeito, confirmado no código

O `fingerprint` do aparelho é um SHA-256 de `ANDROID_ID` + campos do `Build`.

| cenário | fingerprint | o que acontece hoje |
|---|---|---|
| reinstalar o APK (mesmo aparelho) | **igual** | reaproveita a linha — id, nome, histórico e licença ficam — mas **limpa playlist e layout** e pede código novo |
| **resetar de fábrica** | **muda** | **cria uma tela nova.** A antiga fica offline para sempre. Duplicata no painel e na fatura. |

O `ANDROID_ID` muda no reset, e um pedaço diferente muda o hash inteiro. Existe um
`hw_fingerprint` no servidor que sobreviveria, mas o APK não o envia — é um caminho só
para player web — e ele exige token válido, que um aparelho resetado não tem.

### Como fica

O botão mora **dentro da tela já cadastrada**, ao lado de Remover. Nunca em Adicionar
tela — Adicionar tela continua exatamente como está.

1. O cliente desinstala e reinstala o app. O aparelho mostra um código novo.
2. Quer manter as configurações → no painel, na tela existente, **Substituir tela** →
   digita o código → confirma.
3. Quer tudo novo → **Adicionar tela** com o código novo, e apaga a antiga se quiser.

### Servidor

`POST /api/devices/:id/replace` recebendo o código do aparelho novo, numa transação só.

**Transfere:** id da tela, nome, playlist, layout, zonas, orientação, som, grupos,
histórico e a licença.
**Renova:** `device_token`, fingerprint, IP.
**Aparelho antigo:** recebe `device:unpaired` e volta a exibir código de pareamento.

**A licença é o ponto que decide se isso é seguro.** Como a linha é *reaproveitada*, não
entra fatura nova — é a razão de todo o maquinário de fingerprint existir. Uma
implementação que criasse linha nova e apagasse a velha cobraria o cliente duas vezes.

**Travas:** o código precisa apontar para um aparelho não reivindicado, no mesmo
workspace, conectado agora e exibindo aquele código. Recusar um aparelho já reivindicado
— senão a operação rouba silenciosamente outra tela.

### O alerta na lista

Você pediu detecção de desinstalação. Sendo honesto: **desinstalar é indistinguível de
tirar da tomada** — nos dois casos o aparelho só para de conectar.

Mas há um caso que o servidor *sabe*: quando o fingerprint bate e a linha é reaberta para
pareamento, houve reinstalação com certeza. Hoje isso não aparece em lugar nenhum.

- estado novo **`aguardando novo aparelho`**, com faixa na linha e o botão ao lado
- para telas offline há muito tempo, um empurrão discreto sugerindo a troca — sugestão,
  não diagnóstico
- um contador agregado no topo, no espírito do `34 sem comunicação` do concorrente

### Por que isto não contradiz a correção anterior

Há duas semanas a queixa foi que um APK recém-instalado herdou a playlist sozinho, e a
correção fez o pareamento limpar `playlist_id` e `layout_id`.

Os dois convivem, e a diferença é quem decide: **automático e silencioso é o defeito;
explícito e comandado pelo operador é a funcionalidade.** A correção fica; o botão é o
caminho deliberado que faltava.

---

## 2. Zonas — uma lista por zona

Prometido no ciclo anterior e não feito.

Hoje a zona é coluna do **item** da playlist (`playlist_items.zone_id`): uma lista só, com
cada item carimbado. Não existe nada que diga "a zona de cima toca a lista A". Por isso
escolher um layout de várias zonas não mostra campo nenhum — não há o que mostrar.

- tabela nova `device_zone_playlists (device_id, zone_id, playlist_id)` — o mapa mora na
  tela, então o mesmo layout serve várias telas com conteúdos diferentes
- ao escolher um layout, a página consulta as zonas dele e desenha **um campo por zona**,
  com o nome da zona ao lado
- o snapshot passa a compor as atribuições a partir de N listas
- `playlist_items.zone_id` fica onde está, sem uso, por um ciclo — apagar coluna é
  irreversível e não custa nada mantê-la

---

## 3. Volume, brilho e relógio saem

O brilho do sistema dependia de `WRITE_SETTINGS`, que já foi removida da versão de loja —
na Play aquele controle seria um botão que não faz nada. E brilho de TV é ajuste do
aparelho, não do painel.

Volume tem uma distinção que vale manter: **o nível é do usuário na TV, mas se sai som ou
não é decisão do negócio.** Recepção de consultório não pode falar; loja de eletrônicos
deve.

- remover os dois deslizantes e o card do relógio do dispositivo
- campo novo `audio_enabled` na tela; desligado, o player silencia tudo
- o `muted` por item continua servindo para "este vídeo é mudo" dentro de uma tela que
  pode falar
- os campos de fuso ficam no banco — o agendamento por horário depende deles

---

## 4. Os comandos

### O que funciona hoje

Lido no `onCommand` do app e cruzado com o estado da frota (`tier 0`, sem acessibilidade):

| comando | o que tenta fazer | funciona? |
|---|---|---|
| Ligar tela | wake lock + dispensar bloqueio | **sim** |
| Reiniciar app | `startActivity` | **sim** |
| Verificar atualização | OTA forçado | **sim** (some no build de loja) |
| Desligar tela | `lockNow()` → device admin; senão acessibilidade | **não** |
| Reiniciar | `reboot()` → device owner; senão acessibilidade | **não** |
| Desligar | idem | **não** |

Os três de baixo caem num `Log.w("unsupported on this panel")`. O painel diz "comando
enviado" e nada acontece. Não é que serviam para o player antigo — nunca funcionaram sem
device owner, que ficou fora de escopo.

**O concorrente oferece exatamente três comandos: captura de tela, reiniciar aplicativo e
limpar cache.** É a mesma conclusão, tomada por quem já passou por isso.

### O que fazer

Remover os três mortos do menu em lote e escondê-los por tela, exceto em `tier 2`. Um
botão que mente é pior que um botão ausente.

### CEC, como investigação separada

Desligar a tela de verdade não se faz pelo Android: faz-se por **HDMI-CEC**, o box mandando
o comando pelo próprio cabo. É o que Xibo, OptiSigns e ScreenCloud fazem.

Num box genérico não é garantido — depende do fabricante expor o CEC, e Amlogic e Rockchip
expõem de jeitos diferentes. **Teste isolado no Pro Eletronic antes de prometer qualquer
coisa.** Se responder, viram comandos de verdade; se não, aquele modelo não desliga tela e
isso vira critério de compra do próximo.

O projeto já tem CEC, mas só para BrightSign. Para Android, zero.

---

## 5. Agendamento pertence ao arquivo

Decisão nova, e ela cai bem porque as duas tabelas de agendamento estão vazias.

Hoje a regra de exibição é do **item da playlist**: o mesmo arquivo em duas listas precisa
ser configurado duas vezes, e quem sobe o arquivo não é quem monta a lista.

- tabela `content_schedules (content_id, active_days, start_time, end_time, start_date,
  end_date)` — mesma forma da atual, outro dono
- o editor de blocos sai do item da playlist e vai para o arquivo
- `expires_at` continua como validade dura, somada aos blocos
- widgets precisam do equivalente, ou a tabela aceita `content_id` **ou** `widget_id`
  como o `playlist_items` já faz

**Isto não exige APK.** O servidor resolve o agendamento do arquivo e o carimba na
atribuição, no mesmo campo `schedules` que o payload já envia. O player lê exatamente o
que lia antes e não sabe que a origem mudou.

---

## Ordem de execução

| | frente | depende de | precisa de APK? |
|---|---|---|---|
| 1 | Volume, brilho e relógio | — | não |
| 2 | Substituir tela + alerta | — | não |
| 3 | Zonas com uma lista cada | — | não |
| 4 | Limpar os comandos mortos | decisão sua | não |
| 5 | Agendamento no arquivo | — | não |
| 6 | Teste de CEC | 4 | sim |

As cinco primeiras são servidor e painel. A sexta é investigação, não entrega — pode dar
em nada, e é por isso que fica por último.

Começo pela 1 porque é pequena e isolada, e pela 2 logo em seguida porque é a única que
hoje faz o cliente perder informação.
