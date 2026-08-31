#!/bin/sh
# CONTRATO SUSPENSO PARA DE EXIBIR -- e voltar a exibir é desmarcar.
#
# ── AS DUAS INADIMPLÊNCIAS NÃO SE PARECEM ────────────────────────────────────────────────
#   ASSINANTE não paga o Loop Player   dunningGate: painel bloqueado, TELAS SEGUEM EXIBINDO
#   ANUNCIANTE não paga o assinante    isto aqui: a mídia dele para, o assinante não é bloqueado
#
# ── O CASO QUE JUSTIFICA A COLUNA EXISTIR ────────────────────────────────────────────────
# A autoridade é o ARQUIVO (content.contrato_id), não a playlist do contrato. O caso 3 é o que
# prova por quê: um arquivo do contrato posto SOLTO numa tela, fora da lista dele. Se a suspensão
# removesse só a lista, esse arquivo continuaria no ar -- e o anunciante inadimplente ganharia
# veiculação de graça, sem nada parecer errado em tela nenhuma.
#
# ── E REPUBLICAR É PARTE DA SUSPENSÃO ────────────────────────────────────────────────────
# O que a tela exibe é o published_snapshot, montado na publicação. Marcar o contrato sem
# republicar deixaria a marca certa no banco e a mídia no ar. Por isso a prova mede o SNAPSHOT,
# que é o que o aparelho lê, e não a tabela de marcas.

OP=http://127.0.0.1:3110
EMAIL=cliente@exemplo.invalid
SENHA='SenhaCliente#2026'

. /tmp/mfa_lib.sh

falhas=0
ok()  { echo "  OK     $1"; }
nok() { echo "  FALHOU $1"; falhas=$((falhas+1)); }

opdb() { docker exec novo-operacao node -e "$1" 2>/dev/null | tr -d '\r'; }

# Rebaixa e devolve a PRÓPRIA conta -- mesmo idioma de provar_configuracoes.sh. As duas
# filiações sempre juntas: o papel efetivo é um OU das duas, e mexer numa só deixa a conta num
# estado que não existe no produto.
por_papel() {
  opdb "
const {db}=require('/app/server/db/database');
const u=db.prepare('SELECT id FROM users WHERE email=?').get('$EMAIL');
const w=db.prepare('SELECT id,organization_id FROM workspaces WHERE created_by=?').get(u.id);
db.prepare('UPDATE organization_members SET role=? WHERE organization_id=? AND user_id=?').run('$1',w.organization_id,u.id);
db.prepare('UPDATE workspace_members SET role=? WHERE workspace_id=? AND user_id=?').run('$2',w.id,u.id);
console.log('ok');" >/dev/null
}

claim() {
  echo "$1" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('$2',''))" 2>/dev/null
}

S=$(entrar "$EMAIL" "$SENHA")
if [ -z "$S" ]; then echo "  FALHOU nao consegui entrar"; exit 1; fi
WS=$(claim "$S" current_workspace_id)
CONTRATO="contrato-de-prova-5b6"

echo "== CONTRATO SUSPENSO =="
echo

# ── o cenario ───────────────────────────────────────────────────────────────────────────
# Duas listas publicadas, cada uma com um arquivo do MESMO contrato. Uma representa a lista do
# contrato; a outra, uma tela onde o arquivo foi posto solto. As duas tem de parar juntas.
echo "=== 0. montando o cenario ==="
IDS=$(opdb "
const {db}=require('/app/server/db/database');
const ws='$WS';
const u=db.prepare('SELECT user_id FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id WHERE w.id=? LIMIT 1').get(ws)
       || db.prepare('SELECT id as user_id FROM users LIMIT 1').get();
const mk=(id,nome,contrato)=>{
  db.prepare('INSERT OR REPLACE INTO content (id,user_id,workspace_id,filename,filepath,mime_type,duration_sec,contrato_id) VALUES (?,?,?,?,?,?,?,?)')
    .run(id,u.user_id,ws,nome,'/tmp/'+nome,'image/png',10,contrato);
};
mk('c6-do-contrato','do-contrato.png','$CONTRATO');
mk('c6-solto','solto-na-tela.png','$CONTRATO');
mk('c6-livre','sem-contrato.png',null);

const mkpl=(id,nome,itens)=>{
  db.prepare('INSERT OR REPLACE INTO playlists (id,user_id,workspace_id,name,status) VALUES (?,?,?,?,?)')
    .run(id,u.user_id,ws,nome,'draft');
  db.prepare('DELETE FROM playlist_items WHERE playlist_id=?').run(id);
  itens.forEach((c,i)=>db.prepare('INSERT INTO playlist_items (playlist_id,content_id,sort_order,duration_sec) VALUES (?,?,?,10)').run(id,c,i));
};
mkpl('pl6-contrato','Lista do contrato (prova)',['c6-do-contrato']);
mkpl('pl6-tela','Espaco de tela (prova)',['c6-solto','c6-livre']);
console.log(u.user_id);
")
[ -n "$IDS" ] && ok "cenario montado" || nok "nao consegui montar o cenario"

# Publica as duas pela rota real: publicar por SQL mediria o SQL, nao o produto.
for PL in pl6-contrato pl6-tela; do
  curl -s -o /dev/null -X POST -H "Authorization: Bearer $S" "$OP/api/playlists/$PL/publish"
done

itens_no_snapshot() {
  opdb "
const {db}=require('/app/server/db/database');
const p=db.prepare('SELECT published_snapshot FROM playlists WHERE id=?').get('$1');
let n=[];
try { n=JSON.parse(p.published_snapshot||'[]').map(i=>i.content_id).filter(Boolean); } catch(e){}
console.log(n.join(','));"
}

A=$(itens_no_snapshot pl6-contrato)
B=$(itens_no_snapshot pl6-tela)
echo "$A" | grep -q "c6-do-contrato" && ok "antes: a lista do contrato exibe a midia dele" \
  || nok "antes: a lista do contrato ja nao exibia ($A)"
echo "$B" | grep -q "c6-solto" && ok "antes: a tela exibe o arquivo solto do contrato" \
  || nok "antes: o arquivo solto ja nao aparecia ($B)"

echo
echo "=== 1. suspender para as duas, e a Gestao sabe quantas listas mudaram ==="
R=$(curl -s -X POST -H "Authorization: Bearer $S" -H 'Content-Type: application/json' \
      -d '{"motivo":"prova"}' "$OP/api/contratos/$CONTRATO/suspender")
echo "$R" | grep -q '"suspenso":true' && ok "a marca foi aceita" || nok "resposta inesperada: $R"
N=$(echo "$R" | python3 -c "import json,sys; print(json.load(sys.stdin).get('listas_republicadas',0))" 2>/dev/null)
[ "$N" = "2" ] && ok "republicou as DUAS listas afetadas" || nok "republicou $N listas, esperava 2"

A=$(itens_no_snapshot pl6-contrato)
B=$(itens_no_snapshot pl6-tela)
echo "$A" | grep -q "c6-do-contrato" && nok "A MIDIA DO CONTRATO CONTINUA NO AR ($A)" \
  || ok "a lista do contrato parou de exibir"

echo
echo "=== 2. o arquivo SOLTO na tela parou junto -- e o resto da tela nao ==="
# Este e o caso que justifica a autoridade ser o arquivo. Se a suspensao mirasse a playlist do
# contrato, este arquivo seguiria no ar: ele nao esta nela.
echo "$B" | grep -q "c6-solto" && nok "O ARQUIVO SOLTO CONTINUA NO AR -- a suspensao mirou a lista, nao o arquivo ($B)" \
  || ok "o arquivo solto do contrato parou tambem"
echo "$B" | grep -q "c6-livre" && ok "e o arquivo sem contrato continua exibindo" \
  || nok "SUSPENDEU DEMAIS: levou junto midia que nao e do contrato ($B)"

echo
echo "=== 3. suspender de novo e a mesma coisa que suspender uma vez ==="
# Quem chama e outro sistema, e um sistema repete: retentativa, webhook em duplicata, clique
# duplo. Se a repeticao desse erro, a segunda tentativa pareceria falha.
R2=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $S" \
       -H 'Content-Type: application/json' -d '{}' "$OP/api/contratos/$CONTRATO/suspender")
[ "$R2" = "200" ] && ok "repetir responde 200" || nok "repetir respondeu $R2"

echo
echo "=== 4. voltar a exibir e desmarcar ==="
R3=$(curl -s -X DELETE -H "Authorization: Bearer $S" "$OP/api/contratos/$CONTRATO/suspender")
echo "$R3" | grep -q '"suspenso":false' && ok "a marca foi retirada" || nok "resposta inesperada: $R3"

A=$(itens_no_snapshot pl6-contrato)
B=$(itens_no_snapshot pl6-tela)
echo "$A" | grep -q "c6-do-contrato" && ok "a lista do contrato voltou a exibir" \
  || nok "a midia NAO voltou -- a suspensao apagou em vez de marcar ($A)"
echo "$B" | grep -q "c6-solto" && ok "o arquivo solto voltou tambem" \
  || nok "o arquivo solto nao voltou ($B)"

echo
echo "=== 5. um OPERADOR nao suspende ninguem ==="
# Suspender e dinheiro, e dinheiro e fronteira de TITULAR -- o mesmo criterio das abas marcadas
# `titular: true`. Um operador opera as telas; nao decide quem para de veicular.
por_papel org_member editor
S_OP=$(entrar "$EMAIL" "$SENHA")
if [ -z "$S_OP" ]; then
  nok "nao consegui uma sessao de OPERADOR"
else
  C=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $S_OP" \
        -H 'Content-Type: application/json' -d '{}' "$OP/api/contratos/$CONTRATO/suspender")
  [ "$C" = "403" ] && ok "operador recusado (403)" || nok "operador respondeu $C -- deveria ser 403"

  # E LIBERAR TAMBEM. Uma trava so na suspensao seria um cadeado ao lado de uma janela aberta:
  # quem pode liberar pode desfazer toda suspensao que o titular fez.
  C=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer $S_OP" \
        "$OP/api/contratos/$CONTRATO/suspender")
  [ "$C" = "403" ] && ok "e nao libera tambem (403)" || nok "operador LIBEROU um contrato ($C)"
fi

# Devolver faz parte da prova, e conferir a devolucao tambem: um vermelho na proxima suite por
# causa desta seria um defeito procurado no lugar errado.
por_papel org_owner workspace_admin
S=$(entrar "$EMAIL" "$SENHA")
VOLTOU=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer $S" \
           "$OP/api/contratos/$CONTRATO/suspender")
[ "$VOLTOU" = "200" ] && ok "o titular foi devolvido ao papel dele" \
  || nok "A CONTA FICOU REBAIXADA -- respondeu $VOLTOU ao voltar"

echo
echo "=== 6. sem sessao, ninguem para a exibicao de ninguem ==="
C=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OP/api/contratos/$CONTRATO/suspender")
[ "$C" = "401" ] && ok "sem sessao e recusado (401)" || nok "sem sessao respondeu $C"

echo
echo "=== 6a. a porta de sistema abre so o que deve ==="
# A regua de cobranca roda num cron as 8h, sem navegador -- e nao ha terceira saida: ou a Gestao
# fala com a Operacao de servidor para servidor, ou a suspensao automatica so chega quando alguem
# abrir uma tela. Esta secao guarda o tamanho dessa porta.

# Os tokens sao cunhados DENTRO do conteiner, com o mesmo segredo que a API usa. Cunhar aqui fora
# exigiria copiar o segredo para um shell -- e um segredo que passa por linha de comando fica no
# historico.
cunhar() {
  opdb "
const jwt=require('/app/server/node_modules/jsonwebtoken');
const config=require('/app/server/config');
const agora=Math.floor(Date.now()/1000);
console.log(jwt.sign($1, config.jwtSecret, { algorithm: 'HS256' }));"
}

ORG=$(opdb "
const {db}=require('/app/server/db/database');
const w=db.prepare('SELECT organization_id FROM workspaces WHERE id=?').get('$WS');
console.log(w ? w.organization_id : '');")

if [ -z "$ORG" ]; then
  nok "nao achei a organizacao do workspace de teste"
else
  T_SIS=$(cunhar "{ sistema:'gestao', organization_id:'$ORG', iat: agora, exp: agora + 120 }")

  C=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $T_SIS" \
        -H 'Content-Type: application/json' -d '{"motivo":"regua"}' \
        "$OP/api/sistema/contratos/$CONTRATO/suspender")
  [ "$C" = "200" ] && ok "o token de sistema abre a porta de sistema" \
    || nok "a ponte NAO funciona: respondeu $C"

  # E A CHAVE NAO E MESTRA. Ele nao tem um usuario real por tras, entao as rotas normais o
  # recusam -- e isso e propriedade do desenho, nao coincidencia feliz. Por isso e medido.
  C=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $T_SIS" \
        -H 'Content-Type: application/json' -d '{}' "$OP/api/contratos/$CONTRATO/suspender")
  [ "$C" = "401" ] && ok "e NAO abre a porta de gente (401)" \
    || nok "O TOKEN DE SISTEMA ABRIU UMA ROTA NORMAL ($C) -- e uma chave mestra"
  C=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T_SIS" "$OP/api/devices")
  [ "$C" = "401" ] && ok "nem a lista de telas (401)" \
    || nok "O TOKEN DE SISTEMA LEU AS TELAS ($C)"

  # O caminho inverso: uma sessao de pessoa nao vira ponte por apontar para o outro endereco.
  C=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $S" \
        -H 'Content-Type: application/json' -d '{}' "$OP/api/sistema/contratos/$CONTRATO/suspender")
  [ "$C" = "403" ] && ok "um token de PESSOA nao abre a porta de sistema (403)" \
    || nok "uma sessao comum entrou pela ponte ($C)"

  # Validade longa recusada: um token esquecido num log e uma chave permanente.
  T_LONGO=$(cunhar "{ sistema:'gestao', organization_id:'$ORG', iat: agora, exp: agora + 86400 }")
  C=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $T_LONGO" \
        -H 'Content-Type: application/json' -d '{}' "$OP/api/sistema/contratos/$CONTRATO/suspender")
  [ "$C" = "403" ] && ok "validade longa e recusada (403)" \
    || nok "um token de 24h foi aceito ($C)"

  # E O ALCANCE E DECIDIDO DESTE LADO. Se viesse do token, o id de um contrato de um cliente
  # pararia a midia de outro -- na parede de uma loja que nao tem nada a ver com a cobranca.
  T_OUTRA=$(cunhar "{ sistema:'gestao', organization_id:'organizacao-que-nao-existe', iat: agora, exp: agora + 120 }")
  C=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $T_OUTRA" \
        -H 'Content-Type: application/json' -d '{}' "$OP/api/sistema/contratos/$CONTRATO/suspender")
  [ "$C" = "404" ] && ok "organizacao desconhecida nao alcanca workspace nenhum (404)" \
    || nok "uma organizacao inexistente respondeu $C"

  # Limpa a marca que a chamada de sistema deixou, para o caso 7 conferir o ambiente limpo.
  curl -s -o /dev/null -X DELETE -H "Authorization: Bearer $S" "$OP/api/contratos/$CONTRATO/suspender"
fi

echo
echo "=== 6b. o pacote servido da Gestao alcanca a rota ==="
# O aviso sai do NAVEGADOR, entao o que vale e o que foi para o build -- nao o que esta no
# repositorio. Um import descartado pelo bundler ou um caminho renomeado nao daria erro em lugar
# nenhum, e o sintoma seria contrato cancelado com a tela exibindo.
UNI=${UNI:-http://127.0.0.1:3100}
CHUNKS=$(curl -s "$UNI/gestao/contratos" | grep -oE '/gestao/_next/static/chunks/[a-zA-Z0-9._/-]+\.js' | sort -u)
if [ -z "$CHUNKS" ]; then
  nok "nao consegui listar os chunks da pagina de contratos"
else
  ACHOU=0
  for c in $CHUNKS; do
    if curl -s "$UNI$c" | grep -q '/api/contratos/'; then ACHOU=1; break; fi
  done
  [ "$ACHOU" = "1" ] && ok "a pagina de contratos servida chama /api/contratos/" \
    || nok "O PACOTE SERVIDO NAO CHAMA /api/contratos/ -- cancelar nao vai parar a midia"
fi

echo
echo "=== 7. limpando o cenario ==="
# Uma prova que deixa o ambiente sujo faz a proxima falhar por um motivo que nao e dela -- ja
# aconteceu nesta casa, e custou uma rodada procurando defeito no lugar errado.
LIMPO=$(opdb "
const {db}=require('/app/server/db/database');
db.prepare('DELETE FROM contratos_suspensos WHERE contrato_id=?').run('$CONTRATO');
db.prepare('DELETE FROM playlist_items WHERE playlist_id IN (?,?)').run('pl6-contrato','pl6-tela');
db.prepare('DELETE FROM playlists WHERE id IN (?,?)').run('pl6-contrato','pl6-tela');
db.prepare('DELETE FROM content WHERE id IN (?,?,?)').run('c6-do-contrato','c6-solto','c6-livre');
const resto=db.prepare('SELECT COUNT(*) c FROM content WHERE id LIKE ?').get('c6-%').c
          + db.prepare('SELECT COUNT(*) c FROM contratos_suspensos WHERE contrato_id=?').get('$CONTRATO').c;
console.log(resto);")
[ "$LIMPO" = "0" ] && ok "cenario removido" || nok "sobrou sujeira no ambiente ($LIMPO linhas)"

echo
if [ "$falhas" -eq 0 ]; then
  echo "A SUSPENSAO PARA A MIDIA ONDE QUER QUE ELA ESTEJA"
  exit 0
fi
echo "CONTRATO SUSPENSO: $falhas falha(s)"
exit 1
