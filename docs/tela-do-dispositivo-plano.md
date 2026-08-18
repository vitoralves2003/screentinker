# A tela do dispositivo: o que está errado e o que eu faria

Documento de plano — nada implementado ainda.

Seis pontos levantados sobre a página de uma tela. Investiguei cada um; um deles não é problema
de interface, é um defeito que afeta **todo painel antigo em campo**, e por isso vem primeiro.

---

## 1. Notícias e loteria só "carregando" — a causa não é o servidor

**O servidor está saudável.** Busquei os dados que os widgets consomem:

| widget | resposta | conteúdo |
|---|---|---|
| Notícias | HTTP 200, 2.129 bytes | manchetes reais do G1, do dia |
| Clima | HTTP 200, 355 bytes | Montanha/ES, 23°C, previsão de 3 dias |

E o log do nginx mostra o painel baixando as imagens das notícias — `newsimg/0` a `newsimg/11`,
todas 200, entre 49 KB e 185 KB. **Os dados chegam.** O widget mostra `carregando…` até o
`data.json` responder, e ele responde.

**O problema é o navegador do painel.** O log entrega a assinatura dele:

```
Chrome/80.0.3987.149 (PROSK-1000, Android 10)
```

Chrome 80 é de **fevereiro de 2020**. E o CSS dos widgets usa recursos mais novos que ele:

| recurso | exige | onde |
|---|---|---|
| `inset:` | Chrome **87** | [widget-kit.js:93,110,159,236](../server/lib/widget-kit.js#L93) — o **kit compartilhado**, mais 2 na loteria |
| `gap:` em flex | Chrome **84** | 26 ocorrências |
| `aspect-ratio` | Chrome **88** | 1 ocorrência |

O `inset:0` é o que faz uma camada absoluta preencher o container. No Chrome 80 a linha é
simplesmente ignorada: o fundo não preenche, os slides não se posicionam, e o que sobra na tela é
o `carregando…`. É exatamente o sintoma.

**Isso não é um problema desse painel.** O kit é compartilhado, então atinge **todos os widgets em
todo aparelho com WebView antigo** — que é a maior parte do hardware de sinalização, porque
painel comercial e box barato quase nunca recebem atualização do WebView.

**O que eu faria:** trocar as três construções por equivalentes que funcionam desde sempre —
`inset:0` vira `top:0;right:0;bottom:0;left:0`, `gap` em flex vira margem nos filhos,
`aspect-ratio` vira o truque do padding percentual. Não se perde nada visualmente; é a mesma
aparência escrita numa sintaxe mais antiga.

E, para não repetir: **um teste que falha se o CSS dos widgets voltar a usar sintaxe acima do
Chrome 80**, que é o piso real da frota. Hoje nada impede que a próxima edição reintroduza isso, e
o defeito só aparece na parede de um cliente.

**Prioridade: esta é a primeira coisa a fazer.** As outras cinco são melhorias de interface; esta é
conteúdo que não aparece.

---

## 2. Volume e brilho saem; entra "esta tela pode ter som"

Concordo, e o motivo é mais forte do que parece. O brilho do sistema dependia da permissão
`WRITE_SETTINGS`, que **já removi da versão de loja** — então na Play aquele controle seria um
botão que não faz nada. E brilho de TV é ajuste do aparelho, não do painel.

Volume tem uma diferença que vale separar, e você já a fez: **o nível é do usuário na TV, mas se
sai som ou não é decisão do negócio.** Uma tela em recepção de consultório não pode falar; a mesma
tela numa loja de eletrônicos deve. Isso é configuração da tela, não do volume.

Hoje o banco tem `media_volume`, `system_brightness` e `window_brightness` na tela, e `muted` por
item de playlist. **Falta o mudo por tela** — que é justamente o que você pediu.

**O que eu faria:** remover os dois deslizantes, criar um campo `audio_enabled` na tela, e o player
respeita: desligado, silencia tudo independentemente do que o item disser. O `muted` por item
continua servindo para "este vídeo específico é mudo" dentro de uma tela que pode falar.

---

## 3. Zonas: hoje a zona é do item, não da tela

Este é o achado estrutural. Hoje a zona é uma coluna do **item da playlist**
(`playlist_items.zone_id`): uma lista só, com cada item carimbado para uma zona. Não existe nada
que diga "a zona de cima toca a lista A e a de baixo toca a lista B".

Por isso escolher um layout de várias zonas não mostra campo nenhum — não há o que mostrar.

**A boa notícia, e ela é grande:** medi na produção. **Zero** itens de playlist têm zona definida, e
só **uma** tela usa layout. Ou seja, o modelo antigo nunca foi usado de verdade — dá para trocar
sem migração e sem quebrar nada de ninguém.

**O que eu faria**, que é o que você descreveu:

- uma tabela nova, `device_zone_playlists (device_id, zone_id, playlist_id)` — o mapa mora na
  tela, como tem que ser: o mesmo layout serve várias telas, cada uma com conteúdo diferente
- ao escolher um layout, a página consulta as zonas dele e desenha **um campo por zona**, com o
  nome da zona ao lado
- o snapshot passa a compor as atribuições a partir de N listas em vez de uma
- `playlist_items.zone_id` fica onde está, sem uso, até termos certeza — apagar coluna é
  irreversível e não custa nada mantê-la um ciclo

---

## 4. O relógio do dispositivo sai

Concordo, sem ressalva. O card mostra fuso e horário reportados pelo painel — dado de diagnóstico,
não configuração. Some da tela; os campos continuam no banco, porque o agendamento por horário
depende deles.

---

## 5. Salvar tem que significar salvar

Você está certo, e o problema é maior do que a playlist. Hoje a página tem **dois modelos de
interação misturados**:

| aplica na hora | espera o botão Salvar |
|---|---|
| playlist, layout, volume, brilho, tempo de suspensão | notas, orientação, conteúdo padrão, OTA, reinício agendado |

O botão salva cinco campos; os outros cinco já foram aplicados antes de você chegar nele. Ninguém
consegue prever qual é qual — e o pior caso é o seu: trocar a lista para conferir e a tela do
cliente mudar na mesma hora.

**A regra que eu proporia, e é simples de explicar:** **campo espera o Salvar; botão age na hora.**

"Captura", "Iniciar player", "Forçar atualização", "Limpar cache" são ações — o usuário aperta
esperando que aconteça agora, e devem continuar imediatas. Playlist, layout, zonas, orientação,
som, OTA são configuração — mudam o estado da tela e devem esperar a confirmação.

Com um detalhe que faz diferença na prática: **avisar que há mudança não salva.** Um rótulo
discreto perto do botão e um aviso ao sair da página. Sem isso, trocar "espera o salvar" por
"aplica na hora" só troca um jeito de errar por outro — a pessoa configura, sai, e nada aconteceu.

---

## 6. A ordem da tela

Concordo, e ela decorre naturalmente do item 3. A ordem que faz sentido é a da decisão real:

```
1. Layout          →  Tela cheia (padrão) ▾
2. Playlist        →  [lista]  ▾            ← se o layout tem 1 zona
   ou, se o layout tem várias zonas:
   Zona "Topo"     →  [lista]  ▾
   Zona "Principal"→  [lista]  ▾
   Zona "Rodapé"   →  [lista]  ▾
3. Orientação
4. Som desta tela  →  [ ] pode emitir som
5. [Salvar configurações]
```

Primeiro se decide **o formato**, porque é ele que determina quantas listas serão pedidas. Hoje é
o contrário, e é por isso que a pergunta "qual lista vai em qual zona" não tinha onde aparecer.

---

## Ordem de execução que eu proponho

| | o quê | por quê nessa ordem |
|---|---|---|
| 1 | Compatibilidade do CSS dos widgets | é conteúdo que não aparece hoje, em toda a frota antiga |
| 2 | Som por tela; fora volume, brilho e relógio | pequeno, independente, e tira da tela o que a loja já não permite |
| 3 | Zonas com uma lista cada | é o que destrava os layouts, e a migração custa zero |
| 4 | Reordenar a tela e fazer o Salvar valer | depende do 3, porque a ordem nova só existe com os campos de zona |

Os itens 2, 3 e 4 mexem na mesma tela — dá para fazer numa sequência só, mas em commits separados,
porque se algo quebrar quero saber qual dos três foi.

O item 1 é independente e deveria sair antes de qualquer coisa.
