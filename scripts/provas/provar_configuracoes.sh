#!/bin/sh
# E1 — as abas de configuracoes que cada um ve.
#
# Duas perguntas, e as duas importam:
#
#   POR PAPEL. A tela da Gestao mostrava as sete abas para todo mundo, inclusive "Minha
#   assinatura", "Regua de cobranca" e "Usuarios" para um OPERADOR -- o papel cuja definicao
#   inteira e nao ver o Financeiro. O servidor recusa as acoes, entao o que se via eram portas
#   que nao abrem, que e pior do que portas que faltam.
#
#   POR PLANO. Um cliente Pro nao comprou Gestao e nao pode ver aba nenhuma dela; um Gestao
#   avulsa nao tem Operacao. Uma lista que ignore isso oferece um modulo que a pessoa nao tem.
#
# COMO SE REBAIXA O PAPEL NESTE PRODUTO, que custou duas rodadas descobrir:
#
# canAdmin (lib/permissions.js) e um OU de TRES fontes -- administrador de plataforma, papel
# na organizacao, papel no workspace. Basta uma delas para a pessoa ser TITULAR.
#
# Entao um teste que rebaixa so uma prova exatamente nada: na primeira tentativa mexi so no
# workspace e a lista nao mudou; na segunda mexi so na organizacao e ela nao mudou de novo.
# Nos dois casos a conclusao facil seria "o filtro nao funciona", e nos dois a conclusao
# estava errada -- o filtro funcionava e o teste e que nao rebaixava ninguem.

OP=http://127.0.0.1:3110
GE=http://127.0.0.1:3121
EMAIL=cliente@exemplo.invalid
SENHA='SenhaCliente#2026'

. "$(dirname "$0")/mfa_lib.sh"

falhas=0
ok()  { echo "  OK     $1"; }
nok() { echo "  FALHOU $1"; falhas=$((falhas+1)); }

TMP=${TMPDIR:-/tmp}

# Estado original, para devolver no fim. Uma prova que deixa a conta rebaixada quebra todas
# as outras suites que entram com ela.
ORIG_ORG=$(docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
const u=db.prepare('SELECT id FROM users WHERE email=?').get('$EMAIL');
const w=db.prepare('SELECT organization_id FROM workspaces WHERE created_by=?').get(u.id);
const m=db.prepare('SELECT role FROM organization_members WHERE organization_id=? AND user_id=?').get(w.organization_id,u.id);
console.log(m ? m.role : 'org_owner');
" 2>/dev/null | tr -d '\r')

ORIG_WS=$(docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
const u=db.prepare('SELECT id FROM users WHERE email=?').get('$EMAIL');
const w=db.prepare('SELECT id FROM workspaces WHERE created_by=?').get(u.id);
const m=db.prepare('SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?').get(w.id,u.id);
console.log(m ? m.role : 'workspace_admin');
" 2>/dev/null | tr -d '\r')

WS=$(docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
const u=db.prepare('SELECT id FROM users WHERE email=?').get('$EMAIL');
console.log(db.prepare('SELECT id FROM workspaces WHERE created_by=?').get(u.id).id);
" 2>/dev/null | tr -d '\r')

# por_papel() PAPEL_NA_ORG PAPEL_NO_WORKSPACE -- as duas, sempre, pelo motivo acima.
por_papel() {
  docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
const u=db.prepare('SELECT id FROM users WHERE email=?').get('$EMAIL');
const w=db.prepare('SELECT id,organization_id FROM workspaces WHERE created_by=?').get(u.id);
db.prepare('UPDATE organization_members SET role=? WHERE organization_id=? AND user_id=?').run('$1',w.organization_id,u.id);
db.prepare('UPDATE workspace_members SET role=? WHERE workspace_id=? AND user_id=?').run('$2',w.id,u.id);
" >/dev/null 2>&1
}

por_plano() {
  docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
db.prepare('UPDATE workspaces SET plan_id = ? WHERE id = ?').run('$1','$WS');
" >/dev/null 2>&1
}

restaurar() { por_papel "$ORIG_ORG" "$ORIG_WS"; por_plano master; }

# Le a lista de um arquivo, nao de echo: o JSON tem acentos e aspas, e o echo do sh e
# uma camada a mais que pode interpretar o que nao devia.
abas() { curl -s $OP/api/configuracoes -H "Authorization: Bearer $S" > "$TMP/abas.json"; }
tem()  { python3 -c "
import json,sys
d=json.load(open(sys.argv[1],encoding='utf-8'))
print('sim' if any(a['id']==sys.argv[2] for a in d['abas']) else 'nao')" "$TMP/abas.json" "$1" 2>/dev/null; }
quantas() { python3 -c "
import json,sys
print(len(json.load(open(sys.argv[1],encoding='utf-8'))['abas']))" "$TMP/abas.json" 2>/dev/null; }

preparar_mfa "$EMAIL" "$SENHA"
S=$(entrar "$EMAIL" "$SENHA")
case "$S" in *.*.*) : ;; *) echo "  FALHOU nao autenticou"; exit 1 ;; esac

echo "=== 1. TITULAR ve as abas de dinheiro e de pessoas ==="
por_papel org_owner workspace_admin; por_plano master; abas
for a in assinatura regua pessoas; do
  [ "$(tem $a)" = "sim" ] && ok "titular ve '$a'" || nok "titular NAO ve '$a'"
done

echo "=== 2. OPERADOR nao ve nenhuma delas ==="
por_papel org_member editor; abas
for a in assinatura regua pessoas; do
  [ "$(tem $a)" = "nao" ] && ok "operador nao ve '$a'" || nok "OPERADOR VE '$a' -- porta que nao abre"
done
# E continua vendo o que e dele: uma lista vazia seria outro defeito, nao a correcao.
[ "$(tem conta)" = "sim" ] && ok "operador continua vendo 'conta'" || nok "operador ficou sem aba nenhuma"

echo "=== 3. por PLANO: quem nao comprou o modulo nao ve as abas dele ==="
por_papel org_owner workspace_admin
por_plano pro;    abas
[ "$(tem empresa)" = "nao" ] && [ "$(tem conta)" = "sim" ] \
  && ok "Pro: abas da Operacao, nenhuma da Gestao" || nok "Pro viu aba de Gestao"
por_plano free;   abas
[ "$(tem empresa)" = "nao" ] && ok "Free: nenhuma aba de Gestao" || nok "Free viu aba de Gestao"
por_plano gestao; abas
[ "$(tem conta)" = "nao" ] && [ "$(tem empresa)" = "sim" ] \
  && ok "Gestao avulsa: abas da Gestao, nenhuma da Operacao" || nok "Gestao avulsa viu aba de Operacao"
por_plano master; abas
N=$(quantas)
[ "$N" -ge 8 ] 2>/dev/null && ok "Master ve os dois modulos ($N abas)" || nok "Master viu so $N abas"

echo "=== 4. a porta federada responde a MESMA lista ==="
# Se as duas portas divergirem, a tela muda de conteudo conforme o lado de onde se olha --
# que e o defeito inteiro que este endpoint existe para acabar.
T=$(curl -s -X POST $OP/api/auth/federation/gestao -H "Authorization: Bearer $S" \
      | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
curl -s -X POST $GE/auth/federated -H 'Content-Type: application/json' -d "{\"token\":\"$T\"}" \
  > "$TMP/sessao.json"
G=$(python3 -c "
import json,sys
try: print(json.load(open(sys.argv[1],encoding='utf-8')).get('accessToken',''))
except Exception: print('')" "$TMP/sessao.json" 2>/dev/null)

#
# A COMPARACAO ENTRE AS DUAS PORTAS SAIU, porque a segunda saiu.
#
# Aqui se pedia a lista por /api/configuracoes E por /dashboard/configuracoes, e se conferia
# que eram iguais. A Etapa 1 apagou a segunda: o navegador da Gestao pergunta direto a
# primeira, com a sessao da Operacao que ja esta no localStorage dele.
#
# O que sobra e mais direto -- a rota antiga MORREU, e a que restou marca de quem e cada aba.
#
if [ -z "$G" ]; then nok "nao consegui uma sessao da Gestao"; else
  CODG=$(curl -s -o /dev/null -w '%{http_code}' "$GE/dashboard/configuracoes" -H "Authorization: Bearer $G")
  case "$CODG" in
    2*) nok "a rota /dashboard/configuracoes da Gestao ainda serve a lista ($CODG)" ;;
    *)  ok "a rota /dashboard/configuracoes da Gestao nao existe mais ($CODG)" ;;
  esac

  # A lista precisa marcar de quem e cada aba: sem isso o componente nao sabe quais trocam o
  # painel e quais atravessam para o outro modulo.
  M=$(python3 -c "
import json,sys
d=json.load(open(sys.argv[1],encoding='utf-8'))
print(','.join(sorted(set(a['modulo'] for a in d['abas']))))" "$TMP/abas.json" 2>/dev/null)
  [ "$M" = "gestao,operacao" ] && ok "a lista marca os dois modulos ($M)" \
    || nok "modulos inesperados: '$M'"
fi

echo "=== 5. as DUAS telas consomem a lista, em vez da lista fixa ==="
# O jeito de este trabalho se desfazer sem ninguem notar e alguem voltar a desenhar as abas de
# um array local. As duas telas continuariam funcionando -- e voltariam a mostrar portas que
# nao abrem. Por isso a prova olha o arquivo SERVIDO, e nao o repositorio.
UNI=http://127.0.0.1:3100

curl -s "$UNI/js/views/settings.js" > "$TMP/settings.js"
# O termo mudou junto com o mecanismo. `gestaoDestino` era o atributo que a fileira antiga
# punha nas abas da Gestao para um manipulador delegado no documento abrir. As abas moram
# dentro do Shadow DOM agora, onde closest() nao alcanca -- a travessia passou a vir do evento
# do componente, chamando js/atravessar.js.
#
# Continuar procurando o termo antigo acusaria falha por uma substituicao proposital, e prova
# que grita a toa ensina a ignorar o vermelho. O que a checagem quer garantir nao mudou: que
# esta tela NAO volte a desenhar as abas de um array local.
for termo in api/configuracoes aplicarAbasServidas loop-settings-tabs atravessarParaGestao; do
  grep -qF "$termo" "$TMP/settings.js" \
    && ok "Operacao: settings.js servido usa '$termo'" \
    || nok "Operacao: settings.js servido NAO usa '$termo'"
done

# Na Gestao o codigo vai empacotado; procuramos o caminho do endpoint nos pedacos da pagina.
ACHOU=nao
for f in $(curl -s "$UNI/gestao/configuracoes" | grep -o '/gestao/_next/static/chunks/[^"]*\.js' | head -25); do
  curl -s "$UNI$f" | grep -q '/api/configuracoes' && { ACHOU=sim; break; }
done
# O caminho mudou junto com a arquitetura: era /dashboard/configuracoes (a API da Gestao
# reencaminhando a pergunta) e virou /api/configuracoes (o navegador perguntando direto).
# Procurar o antigo acusaria falha por uma remocao proposital.
[ "$ACHOU" = "sim" ] \
  && ok "Gestao: a pagina servida pede /api/configuracoes, direto" \
  || nok "Gestao: a pagina servida NAO pede a lista -- voltou para o array fixo?"

# E sem sessao ninguem le a lista: ela diz o que a pessoa pode configurar.
C=$(curl -s -o /dev/null -w '%{http_code}' "$UNI/api/configuracoes")
[ "$C" = "401" ] && ok "sem sessao, a lista e recusada (401)" || nok "sem sessao respondeu $C"

echo "=== 6. assinatura: as duas metades, e a trava que as protege ==="
# Uma assinatura, duas telas: a fatura mora na Gestao e o plano/consumo na Operacao.
#
# A trava importa mais do que parece. O @Roles(TITULAR) desta rota NASCEU INERTE -- o
# controller nao tinha RolesGuard, entao o decorador nao fazia nada e a rota PARECIA
# protegida. Um teste que so conferisse o caminho feliz teria passado com ela aberta.

# TITULAR ve os numeros.
G_TIT=$(python3 -c "
import json,sys
try: print(json.load(open(sys.argv[1],encoding='utf-8')).get('accessToken',''))
except Exception: print('')" "$TMP/sessao.json" 2>/dev/null)

if [ -z "$G_TIT" ]; then nok "sem sessao da Gestao para conferir a assinatura"; else
  curl -s "$GE/dashboard/assinatura" -H "Authorization: Bearer $G_TIT" > "$TMP/assin.json"
  P=$(python3 -c "
import json,sys
try:
    d=json.load(open(sys.argv[1],encoding='utf-8'))
    m=d.get('mes') or {}
    print('%s|%s' % ((d.get('plano') or {}).get('nome',''), m.get('projetado','')))
except Exception: print('|')" "$TMP/assin.json" 2>/dev/null)
  NOME=$(echo "$P" | cut -d'|' -f1); PROJ=$(echo "$P" | cut -d'|' -f2)
  echo "  plano '$NOME', projecao do mes fechado: $PROJ"
  [ -n "$NOME" ] && ok "titular ve o plano vindo da Operacao" || nok "titular nao recebeu o plano"
  # A projecao e o numero que nao existia em lugar nenhum antes: quanto o mes inteiro custa se
  # nada mudar. Vazio aqui significa que a ponte trouxe uma casca.
  [ -n "$PROJ" ] && ok "e a projecao do mes fechado" || nok "veio sem projecao"
fi

# OPERADOR nao ve. Rebaixa, atravessa de novo, confere, e devolve.
por_papel org_member editor
S_OP=$(entrar "$EMAIL" "$SENHA")
T_OP=$(curl -s -X POST $OP/api/auth/federation/gestao -H "Authorization: Bearer $S_OP" \
        | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
curl -s -X POST $GE/auth/federated -H 'Content-Type: application/json' -d "{\"token\":\"$T_OP\"}" \
  > "$TMP/sessao_op.json"
G_OP=$(python3 -c "
import json,sys
try: print(json.load(open(sys.argv[1],encoding='utf-8')).get('accessToken',''))
except Exception: print('')" "$TMP/sessao_op.json" 2>/dev/null)

if [ -z "$G_OP" ]; then nok "nao consegui uma sessao de OPERADOR"; else
  C=$(curl -s -o /dev/null -w '%{http_code}' "$GE/dashboard/assinatura" -H "Authorization: Bearer $G_OP")
  [ "$C" = "403" ] && ok "operador recusado na assinatura (403)" \
    || nok "operador respondeu $C -- o @Roles esta inerte de novo?"

  # E o guard novo nao pode ter fechado as rotas que sempre foram de todos.
  #
  # Era /dashboard/menu que servia de contraprova aqui -- uma rota sem @Roles, que TINHA de
  # continuar aberta. Ela saiu na Etapa 1 (o navegador pergunta direto a /api/menu), entao a
  # contraprova passa a ser /dashboard/overview: mesmo criterio, sem @Roles, e a tela que todo
  # usuario da organizacao precisa ver.
  #
  # A contraprova continua sendo o ponto: sem ela, "o operador foi recusado" seria verdade
  # tambem no dia em que o guard fechasse tudo.
  C=$(curl -s -o /dev/null -w '%{http_code}' "$GE/dashboard/overview" -H "Authorization: Bearer $G_OP")
  [ "$C" = "200" ] && ok "e o painel, sem @Roles, segue aberto (200)" \
    || nok "o painel respondeu $C -- o RolesGuard fechou o que nao devia"
fi

echo "=== 7. pessoas: a lista vem da fonte, e a Gestao nao cria fantasmas ==="
# A aba de Usuarios da Gestao tinha cadastro completo escrevendo numa COPIA. Criar alguem ali
# gerava um usuario que nao entra em lugar nenhum: nasce so no Postgres da Gestao, e o login
# proprio dela esta fechado. Foi demonstrado -- criei um, tentei entrar pelos dois caminhos, e
# os dois recusaram.
#
# O caso abaixo guarda as duas metades do conserto: a lista vem da Operacao (a fonte), e
# criar gente pela Gestao continua produzindo alguem que nao entra -- entao a tela nao pode
# voltar a oferecer isso.
por_papel org_owner workspace_admin
S=$(entrar "$EMAIL" "$SENHA")
T=$(curl -s -X POST $OP/api/auth/federation/gestao -H "Authorization: Bearer $S" \
      | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
curl -s -X POST $GE/auth/federated -H 'Content-Type: application/json' -d "{\"token\":\"$T\"}" \
  > "$TMP/sessao_tit.json"
G_T=$(python3 -c "
import json,sys
try: print(json.load(open(sys.argv[1],encoding='utf-8')).get('accessToken',''))
except Exception: print('')" "$TMP/sessao_tit.json" 2>/dev/null)

if [ -z "$G_T" ]; then nok "sem sessao de titular para conferir pessoas"; else
  curl -s "$GE/dashboard/pessoas" -H "Authorization: Bearer $G_T" > "$TMP/pessoas.json"
  R=$(python3 -c "
import json,sys
try:
    d=json.load(open(sys.argv[1],encoding='utf-8'))
    print('%d|%s|%s' % (len(d.get('pessoas',[])),
                        'sim' if d.get('gerenciar') else 'nao',
                        'sim' if any('titular' in p for p in d.get('pessoas',[])) else 'nao'))
except Exception: print('0|nao|nao')" "$TMP/pessoas.json" 2>/dev/null)
  N=$(echo "$R" | cut -d'|' -f1); GER=$(echo "$R" | cut -d'|' -f2); VAZA=$(echo "$R" | cut -d'|' -f3)

  [ "$N" -gt 0 ] 2>/dev/null && ok "a lista traz $N pessoa(s), vindas da Operacao" \
    || nok "a lista veio vazia -- a fonte nao respondeu?"
  [ "$GER" = "sim" ] && ok "traz o endereco de onde gerenciar" \
    || nok "sem endereco de gerenciamento: a tela ficaria sem saida"
  # O campo interno nao pode voltar: duas formas de dizer o mesmo papel e como alguem le a errada.
  [ "$VAZA" = "nao" ] && ok "nao vaza o campo interno 'titular'" || nok "o campo interno voltou"

  # E a tela servida nao pode voltar a oferecer cadastro.
  ACHOU=nao
  for f in $(curl -s "$UNI/gestao/configuracoes" | grep -o '/gestao/_next/static/chunks/[^"]*\.js' | head -25); do
    curl -s "$UNI$f" | grep -q 'Novo usu' && { ACHOU=sim; break; }
  done
  [ "$ACHOU" = "nao" ] && ok "a tela servida nao oferece 'Novo usuario'" \
    || nok "a tela voltou a oferecer cadastro -- e ele cria quem nao consegue entrar"
fi

echo "=== 8. nenhum nome repetido na fileira ==="
# O ponto da Etapa 2. Antes a fileira tinha "Plano e consumo" E "Minha assinatura" (a mesma
# assinatura, partida ao meio) e "Membros" E "Usuarios" (as mesmas pessoas). A Fase E juntou o
# CONTEUDO e deixou os dois nomes -- o que tornou a duplicacao mais visivel em vez de menor.
#
# Nao basta contar abas: dois nomes diferentes para a mesma coisa passariam numa contagem. O
# que se confere e que nenhum ROTULO aparece duas vezes, e que os ids velhos sumiram.
por_papel org_owner workspace_admin; por_plano master; abas

REP=$(python3 -c "
import json,sys
from collections import Counter
d=json.load(open(sys.argv[1],encoding='utf-8'))
print(','.join(k for k,v in Counter(a['rotulo'] for a in d['abas']).items() if v>1))" "$TMP/abas.json" 2>/dev/null)
[ -z "$REP" ] && ok "nenhum rotulo repetido" || nok "repetidos: $REP"

for velho in assinatura-plano assinatura-fatura membros usuarios; do
  [ "$(tem $velho)" = "nao" ] && ok "o id antigo '$velho' nao volta" \
    || nok "o id antigo '$velho' voltou -- a aba desdobrou de novo"
done

# E um PRO, que nao tem Gestao, precisa alcancar as duas pela Operacao: sem isso a
# unificacao teria custado a ele o acesso a assinatura e as pessoas dele.
por_plano pro; abas
MOD=$(python3 -c "
import json,sys
d=json.load(open(sys.argv[1],encoding='utf-8'))
m={a['id']:a['modulo'] for a in d['abas']}
print('%s|%s' % (m.get('assinatura','ausente'), m.get('pessoas','ausente')))" "$TMP/abas.json" 2>/dev/null)
[ "$MOD" = "operacao|operacao" ] \
  && ok "Pro alcanca Assinatura e Pessoas pela Operacao" \
  || nok "Pro ficou com '$MOD' -- a unificacao tirou acesso dele"
por_plano master

restaurar
echo
[ "$falhas" = "0" ] && echo "CONFIGURACOES: as abas seguem o papel e o plano" \
  || echo "CONFIGURACOES: $falhas falha(s)"
exit $falhas
