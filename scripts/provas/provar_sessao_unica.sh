#!/bin/sh
# PROVA DA SESSAO UNICA -- e o que esta suite mede mudou de sinal.
#
# Ela se chamava provar_federacao.sh e tinha 14 casos garantindo que a travessia entre os dois
# modulos era SEGURA: o token de troca de 60 segundos nao servia como sessao, a sessao de um
# lado nao servia do outro, um token forjado era recusado.
#
# A travessia deixou de existir. Provar que ela e segura passou a ser provar coisa nenhuma --
# e uma suite que mede algo que sumiu fica verde para sempre, sem nunca mais olhar para o
# produto. Por isso a reescrita, e nao um remendo.
#
# ── O QUE ELA MEDE AGORA ─────────────────────────────────────────────────────────────────
# Duas perguntas, e a segunda e a que importa:
#
#   1. A sessao da Operacao alcanca a API da Gestao, direto, sem troca nenhuma?
#   2. TUDO O QUE MORAVA NA TRAVESSIA continua sendo feito em algum lugar?
#
# A segunda existe porque apagar uma ponte apaga junto o que estava pendurado nela, e nada
# disso da erro ao sumir. Tres coisas moravam ali: a trava do plano, o registro de acesso de
# suporte, e a resolucao de qual e o id da pessoa do lado da Gestao. As tres tem caso aqui.

OP=http://127.0.0.1:3110
GE=http://127.0.0.1:3121
PROXY=http://127.0.0.1:3100
EMAIL=cliente@exemplo.invalid
SENHA='SenhaCliente#2026'
SUP_EMAIL=suporte@loop.invalid
SUP_SENHA='SenhaSuporte#2026'

. /tmp/mfa_lib.sh

falhas=0
ok()  { echo "  OK     $1"; }
nok() { echo "  FALHOU $1"; falhas=$((falhas+1)); }
ejwt() { echo "$1" | grep -qE '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'; }

# Le um campo do corpo do JWT sem depender de biblioteca nenhuma.
claim() {
  echo "$1" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('$2',''))" 2>/dev/null
}

# Consultas ao banco da Operacao passam por /app/server/db/database, que e a MESMA conexao que
# o servidor usa. Abrir o arquivo .db por caminho funciona ate alguem move-lo, e ai a prova
# passa a medir um banco que ninguem le.
opdb() { docker exec novo-operacao node -e "$1" 2>/dev/null | tr -d '\r'; }

echo "=== 1. entrar na Operacao, uma vez ==="
SESSAO=$(entrar "$EMAIL" "$SENHA")
if ejwt "$SESSAO"; then ok "sessao obtida"; else
  nok "nao consegui entrar: $(echo "$SESSAO" | head -c 120)"
  echo "  (sem sessao os casos seguintes so repetiriam esta causa)"
  exit 1
fi

echo "=== 2. o token carrega o que a Gestao precisa saber ==="
for campo in organization_id papel gestao_enabled; do
  v=$(claim "$SESSAO" "$campo")
  [ -n "$v" ] && ok "$campo = $v" || nok "$campo AUSENTE no token"
done

echo "=== 3. a MESMA sessao alcanca a API da Gestao, sem troca ==="
for rota in /clients /contracts /users; do
  COD=$(curl -s -o /dev/null -w '%{http_code}' "$GE$rota" -H "Authorization: Bearer $SESSAO")
  [ "$COD" = "200" ] && ok "$COD  $rota" || nok "$COD  $rota (esperava 200)"
done

echo
echo "=== AS PONTES NAO EXISTEM MAIS ==="
# Nao basta "nao usamos mais": uma rota viva e uma rota que alguem alcanca. Enquanto o codigo
# estiver la, a trava do plano que saiu dela continua sendo contornavel por quem a chamar.

echo "--- 4. a rota de troca sumiu da Operacao ---"
COD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OP/api/auth/federation/gestao" -H "Authorization: Bearer $SESSAO")
[ "$COD" = "404" ] && ok "404 -- nao existe" || nok "ainda responde $COD"

echo "--- 5. a rota que trocava sumiu da Gestao ---"
COD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GE/auth/federated" -H 'Content-Type: application/json' -d '{"token":"x"}')
[ "$COD" = "404" ] && ok "404 -- nao existe" || nok "ainda responde $COD"

echo "--- 6. a pagina /entrar sumiu ---"
COD=$(curl -s -o /dev/null -w '%{http_code}' "$PROXY/gestao/entrar")
[ "$COD" = "404" ] && ok "404 -- nao existe" || nok "ainda responde $COD"

echo "--- 7. o modulo js/atravessar.js sumiu ---"
# NAO se pergunta o codigo aqui, e isto ja custou uma rodada: este servidor e um SPA e devolve
# 200 com o index.html para QUALQUER caminho que nao reconheca. Um arquivo apagado responde
# 200, e um arquivo presente tambem -- o codigo nao distingue os dois.
#
# O que distingue e o tipo: JavaScript de verdade vem como application/javascript.
TIPO=$(curl -s -o /tmp/_atr.txt -w '%{content_type}' "$OP/js/atravessar.js")
if echo "$TIPO" | grep -qi javascript; then
  nok "ainda e servido como JavaScript ($TIPO)"
elif grep -q 'atravessarParaGestao' /tmp/_atr.txt; then
  nok "o corpo ainda contem a funcao da travessia"
else
  ok "nao e mais servido (veio $TIPO, o fallback do SPA)"
fi

echo
echo "=== O QUE MORAVA NA TRAVESSIA E TINHA DE SOBREVIVER ==="

echo "--- 8. A TRAVA DO PLANO: quem nao tem Gestao no plano e recusado ---"
# A rota apagada era o unico lugar que decidia isto. Sem esta checagem, perder a trava nao
# apareceria em teste nenhum -- o menu ja esconde os itens, entao ninguem clicaria.
WS=$(claim "$SESSAO" current_workspace_id)

plano_ler() {
  opdb "
const {db}=require('/app/server/db/database');
const r=db.prepare('SELECT plan_id FROM workspaces WHERE id = ?').get('$WS');
console.log(r && r.plan_id ? r.plan_id : '');
"
}
plano_escrever() {
  opdb "
const {db}=require('/app/server/db/database');
db.prepare('UPDATE workspaces SET plan_id = ? WHERE id = ?').run('$1' || null, '$WS');
" >/dev/null
}

PLANO_ANTES=$(plano_ler)

if [ -z "$WS" ]; then
  nok "sem current_workspace_id no token -- nao da para testar o plano"
elif [ -z "$PLANO_ANTES" ]; then
  nok "nao consegui ler o plano do workspace -- nao mexo no que nao sei devolver"
else
  plano_escrever free
  SESSAO_FREE=$(entrar "$EMAIL" "$SENHA")
  GE_ENABLED=$(claim "$SESSAO_FREE" gestao_enabled)
  COD=$(curl -s -o /dev/null -w '%{http_code}' "$GE/clients" -H "Authorization: Bearer $SESSAO_FREE")

  if [ "$GE_ENABLED" = "False" ] && [ "$COD" = "403" ]; then
    ok "plano free -> gestao_enabled false -> 403 na API da Gestao"
  else
    nok "plano free deveria dar 403; gestao_enabled=$GE_ENABLED codigo=$COD"
  fi

  # DEVOLVER O PLANO E PARTE DA PROVA, nao limpeza depois dela.
  #
  # A primeira versao disto tinha uma expansao de shell malformada, falhava calada (o erro ia
  # para /dev/null) e deixou a conta de teste no plano free. O caso seguinte quebrou por causa
  # disso, e eu fui procurar o defeito no produto.
  #
  # Agora ele confere o que escreveu e grita quando nao bate. Uma prova que estraga o ambiente
  # e pior que uma prova que falha: a proxima pessoa herda o estrago sem saber de onde veio.
  plano_escrever "$PLANO_ANTES"
  PLANO_DEPOIS=$(plano_ler)

  if [ "$PLANO_DEPOIS" != "$PLANO_ANTES" ]; then
    nok "NAO DEVOLVI O PLANO: era '$PLANO_ANTES', ficou '$PLANO_DEPOIS' -- conserte antes de seguir"
  else
    SESSAO=$(entrar "$EMAIL" "$SENHA")
    COD=$(curl -s -o /dev/null -w '%{http_code}' "$GE/clients" -H "Authorization: Bearer $SESSAO")
    [ "$COD" = "200" ] && ok "plano devolvido ('$PLANO_ANTES') -- voltou a 200" \
      || nok "plano devolvido mas a API responde $COD"
  fi
fi

echo "--- 9. O REGISTRO DE SUPORTE: entrar na conta de um cliente deixa rastro ---"
# Isto vivia na rota de troca e responde a unica pergunta que alguem faz depois: quem da
# plataforma abriu o financeiro de qual cliente, e quando.
conta_suporte() {
  opdb "
const {db}=require('/app/server/db/database');
console.log(db.prepare(\"SELECT COUNT(*) c FROM activity_log WHERE action = 'suporte:entrou_na_conta'\").get().c);
"
}

SUP=$(entrar "$SUP_EMAIL" "$SUP_SENHA")
if ejwt "$SUP"; then
  ANTES=$(conta_suporte)
  curl -s -o /dev/null -X POST "$OP/api/auth/switch-workspace" \
    -H "Authorization: Bearer $SUP" -H 'Content-Type: application/json' \
    -d "{\"workspace_id\":\"$WS\"}"
  DEPOIS=$(conta_suporte)

  if [ -n "$ANTES" ] && [ "$DEPOIS" -gt "$ANTES" ] 2>/dev/null; then
    ok "registrado ($ANTES -> $DEPOIS)"
  else
    nok "entrar na conta do cliente nao deixou rastro ($ANTES -> $DEPOIS)"
  fi
else
  nok "nao consegui entrar como suporte"
fi

echo "--- 10. O ID DA PESSOA: o sub do request e o User.id da Gestao ---"
# Se estes dois divergirem, cada escrita da Gestao que guarda "quem fez" aponta para uma linha
# que nao existe. O federated() resolvia isso sem alarde, assinando com o id DAQUI.
ID_TOKEN=$(claim "$SESSAO" id)
ID_GESTAO=$(docker exec novo-gestao-postgres psql -U novo -d novo_gestao -tAc \
  "select id from \"User\" where email = '$EMAIL';" 2>/dev/null | tr -d ' \r')
if [ -z "$ID_GESTAO" ]; then
  nok "a Gestao nao tem linha para $EMAIL -- o provisionamento nao rodou"
elif [ "$ID_TOKEN" = "$ID_GESTAO" ]; then
  ok "mesmo id nos dois lados ($ID_GESTAO)"
else
  # Divergir NAO e falha por si: a resolucao por e-mail existe justamente para isso. O que ela
  # nao pode e deixar a escrita quebrar, e quem mede isso e o caso 11.
  ok "ids divergem (token $ID_TOKEN, Gestao $ID_GESTAO) -- e o caso 11 que decide"
fi

echo "--- 10b. e a linha da Gestao se corrige quando fica para tras ---"
# A COLUNA E LIDA, e por isso nao pode envelhecer.
#
# UsersService.findOne(id, organizationId) exige que User.organizationId bata com a organizacao
# do request: defasada, um usuario que existe responde "User not found" sobre si mesmo. findAll
# lista pela coluna, entao a pessoa aparece na empresa errada. E a regra que impede deixar o
# tenant sem nenhum titular conta pela coluna.
#
# Eu quase decidi NAO sincronizar, com o argumento de que o papel ja vem no token a cada
# requisicao e gravar seria uma segunda copia mais velha. A primeira metade e verdade; a
# conclusao nao: a copia existe de qualquer forma -- e uma coluna -- e nao gravar nao a apaga,
# so a deixa velha.
#
# A prova estraga a linha de proposito e confere que a requisicao seguinte a conserta.
gesql() { docker exec novo-gestao-postgres psql -U novo -d novo_gestao -tAc "$1" | tr -d " "; }
ORG_COL="\"organizationId\""

ORG_CERTA=$(gesql "select $ORG_COL from \"User\" where email = '$EMAIL';")
if [ -z "$ORG_CERTA" ]; then
  nok "sem linha na Gestao para estragar -- nada a provar aqui"
else
  gesql "update \"User\" set $ORG_COL = (select id from \"Organization\" where id <> '$ORG_CERTA' limit 1) where email = '$EMAIL';" >/dev/null
  ESTRAGADA=$(gesql "select $ORG_COL from \"User\" where email = '$EMAIL';")

  if [ "$ESTRAGADA" = "$ORG_CERTA" ]; then
    echo "  (nao ha outra organizacao para apontar -- caso nao aplicavel)"
  else
    curl -s -o /dev/null "$GE/clients" -H "Authorization: Bearer $SESSAO"
    DEPOIS_SYNC=$(gesql "select $ORG_COL from \"User\" where email = '$EMAIL';")
    if [ "$DEPOIS_SYNC" = "$ORG_CERTA" ]; then
      ok "a linha voltou para a organizacao do token"
    else
      nok "continuou em $DEPOIS_SYNC, deveria ser $ORG_CERTA"
      gesql "update \"User\" set $ORG_COL = '$ORG_CERTA' where email = '$EMAIL';" >/dev/null
      echo "          (a prova devolveu a linha a mao)"
    fi
  fi
fi
echo "--- 11. e o que a Gestao grava como \"quem fez\" aponta para gente que existe ---"
# NAO HA CHAVE ESTRANGEIRA AQUI, e foi isso que me fez reescrever este caso.
#
# A versao anterior criava um cliente e chamava o 201 de prova de integridade referencial.
# Mas Client nao guarda quem criou, e -- olhando o schema -- a UNICA chave estrangeira para
# User em todo o banco e AccountActivationToken.userId. Contract.createdById, cancelledById,
# endedById e responsibleUserId sao colunas String soltas.
#
# Ou seja: um `sub` errado NAO estoura. Ele grava uma referencia pendurada, em silencio, que
# so aparece quando alguem abre o historico de um contrato e nao ha nome nenhum. E um modo de
# falhar pior que o erro, nao melhor -- por isso o caso mede a consequencia, e nao o codigo
# HTTP de uma escrita.
PENDURADAS=$(gesql "
  select
    (select count(*) from \"Contract\" c left join \"User\" u on u.id = c.\"createdById\" where u.id is null)
  + (select count(*) from \"Contract\" c left join \"User\" u on u.id = c.\"cancelledById\" where c.\"cancelledById\" is not null and u.id is null)
  + (select count(*) from \"Contract\" c left join \"User\" u on u.id = c.\"endedById\" where c.\"endedById\" is not null and u.id is null)
  + (select count(*) from \"Contract\" c left join \"User\" u on u.id = c.\"responsibleUserId\" where c.\"responsibleUserId\" is not null and u.id is null);")
TOTAL_CONTRATOS=$(gesql "select count(*) from \"Contract\";")

if [ -z "$TOTAL_CONTRATOS" ] || [ "$TOTAL_CONTRATOS" = "0" ]; then
  echo "  (nao ha contratos gravados -- caso ainda nao aplicavel)"
elif [ "$PENDURADAS" = "0" ]; then
  ok "$TOTAL_CONTRATOS contrato(s), nenhuma referencia a usuario pendurada"
else
  nok "$PENDURADAS referencia(s) apontam para usuario que nao existe"
fi

echo "--- 11b. e a sessao consegue escrever de verdade ---"
COD=$(curl -s -o /tmp/_esc.json -w '%{http_code}' -X POST "$GE/clients" \
  -H "Authorization: Bearer $SESSAO" -H 'Content-Type: application/json' \
  -d '{"name":"Prova Sessao Unica","email":"prova-sessao@exemplo.invalid","document":"11222333000181","whatsapp":"(11) 98888-7777","postalCode":"01310-100","street":"Avenida Paulista","number":"1000","neighborhood":"Bela Vista","city":"Sao Paulo","state":"SP"}')
case "$COD" in
  200|201) ok "escrita aceita ($COD)" ;;
  409) ok "ja existia de uma rodada anterior ($COD)" ;;
  *) nok "escrita recusada com $COD: $(head -c 200 /tmp/_esc.json)" ;;
esac

# LIMPA PELO BANCO, porque nao existe DELETE /clients nesta API -- descoberto tentando: a rota
# responde 404. Uma prova que deixa lixo faz a proxima rodada medir um ambiente diferente.
gesql "delete from \"Client\" where email = 'prova-sessao@exemplo.invalid';" >/dev/null
SOBROU=$(gesql "select count(*) from \"Client\" where email = 'prova-sessao@exemplo.invalid';")
[ "$SOBROU" = "0" ] && ok "limpou o cliente de teste" || nok "sobrou cliente de teste no banco"
echo
echo "=== AS RECUSAS QUE CONTINUAM VALENDO ==="

echo "--- 12. sem token, recusa ---"
COD=$(curl -s -o /dev/null -w '%{http_code}' "$GE/clients")
[ "$COD" = "401" ] && ok "401" || nok "aceitou sem Authorization: $COD"

echo "--- 13. token assinado com outro segredo e recusado ---"
ORG=$(claim "$SESSAO" organization_id)
FORJADO=$(docker exec novo-gestao-api node -e "
const {sign}=require('jsonwebtoken');
console.log(sign({id:'x',email:'invasor@x.com',papel:'TITULAR',organization_id:'$ORG',gestao_enabled:true},'segredo-errado',{expiresIn:'60s'}));
" 2>/dev/null | tr -d '\r')
COD=$(curl -s -o /dev/null -w '%{http_code}' "$GE/clients" -H "Authorization: Bearer $FORJADO")
[ "$COD" = "401" ] && ok "401" || nok "aceitou token forjado: $COD"

echo "--- 14. o login proprio da Gestao continua fechado ---"
# A trava perguntava por FEDERATION_SECRET, apagado nesta etapa. Passou a perguntar por
# OPERACAO_JWT_SECRET -- e se alguem trocar a condicao de volta, este caso acusa.
COD=$(curl -s -o /tmp/_login2.json -w '%{http_code}' -X POST "$GE/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$SENHA\"}")
[ "$COD" = "401" ] && ok "401: $(sed -E 's/.*"message":"([^"]*)".*/\1/' /tmp/_login2.json | head -c 70)" \
  || nok "o login proprio voltou a aceitar senha: $COD"

echo "--- 15. o admin de plataforma continua tendo porta ---"
COD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GE/platform/auth/login" -H 'Content-Type: application/json' -d '{"email":"x@x.com","password":"y"}')
[ "$COD" != "404" ] && ok "existe (respondeu $COD)" || nok "a porta do Admin sumiu"

echo
[ "$falhas" = "0" ] && echo "TODOS OS CASOS DA SESSAO UNICA FECHARAM" || echo "$falhas CASO(S) FALHARAM"
exit $falhas
