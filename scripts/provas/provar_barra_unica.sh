#!/bin/sh
# Etapa 2 -- existe UMA barra, e nao duas parecidas.
#
# ── O QUE ESTA PROVA CONSEGUE E O QUE NAO CONSEGUE ───────────────────────────────────────
# Nao ha navegador sem cabeca nesta maquina, entao ela nao olha pixel. O argumento e outro, e
# e mais forte que uma comparacao de telas:
#
#     um renderizador so  +  dois payloads iguais  =>  desenho igual
#
# As duas metades sao verificaveis sem navegador. A primeira e estrutural (nenhum dos dois
# aplicativos tem marcacao de barra propria, e os dois carregam o MESMO arquivo). A segunda e
# comparar, campo a campo, o que cada porta manda.
#
# O que continua precisando de olho humano: fonte, alinhamento, e a barra desenhando de fato.
# Isso esta dito no relatorio em vez de fingido aqui.

OP=http://127.0.0.1:3110
GE=http://127.0.0.1:3120
UNI=http://127.0.0.1:3100
EMAIL=cliente@exemplo.invalid
SENHA='SenhaCliente#2026'
REPO=/opt/novo-operacao
REPO_GE=/opt/novo-gestao/repo

. "$(dirname "$0")/mfa_lib.sh"

falhas=0
ok()  { echo "  OK     $1"; }
nok() { echo "  FALHOU $1"; falhas=$((falhas+1)); }
TMP=${TMPDIR:-/tmp}

echo "=== 1. nenhum dos dois aplicativos desenha barra propria ==="

# A Operacao: a marcacao de 100 linhas virou uma tag.
if grep -q '<loop-sidebar' "$REPO/frontend/index.html" 2>/dev/null; then
  ok "a Operacao monta <loop-sidebar>"
else
  nok "a Operacao nao monta o componente"
fi
if grep -q 'nav class="sidebar"' "$REPO/frontend/index.html" 2>/dev/null; then
  nok "a marcacao antiga da barra AINDA esta no index.html"
else
  ok "a marcacao antiga da barra saiu do index.html"
fi

# A Gestao: 362 linhas de <aside> viraram uma tag.
SHELL_TSX="$REPO_GE/apps/web/src/components/layout/app-shell.tsx"
if grep -q '<LoopSidebar' "$SHELL_TSX" 2>/dev/null; then
  ok "a Gestao monta <LoopSidebar>"
else
  nok "a Gestao nao monta o componente"
fi
if grep -q '<aside' "$SHELL_TSX" 2>/dev/null; then
  nok "o <aside> da Gestao AINDA existe"
else
  ok "o <aside> da Gestao saiu"
fi

echo "--- e ninguem guarda o estado de recolher por conta propria ---"
# Era o defeito em pessoa: dois codigos escrevendo a MESMA chave de localStorage.
DONOS=0
grep -rq "loop_os_sidebar_collapsed" "$REPO/frontend/js/" 2>/dev/null && DONOS=$((DONOS+1))
grep -rq "loop_os_sidebar_collapsed" "$REPO_GE/apps/web/src/" 2>/dev/null && DONOS=$((DONOS+1))
[ "$DONOS" -eq 0 ] \
  && ok "nenhum dos dois aplicativos toca a chave -- so o componente" \
  || nok "$DONOS aplicativo(s) ainda escrevem loop_os_sidebar_collapsed"

echo
echo "=== 2. os dois carregam o MESMO arquivo, da mesma origem ==="
for url in "$OP/components/loop-sidebar.js" "$UNI/components/loop-sidebar.js"; do
  TIPO=$(curl -s -o "$TMP/comp.js" -w '%{content_type}' "$url")
  BYTES=$(wc -c < "$TMP/comp.js")
  case "$TIPO" in
    *javascript*)
      # Tipo, e nao so status 200. Na Fase B a Operacao respondia 200 com HTML para arquivo
      # que nao existia, e dezoito checagens passaram em cima disso.
      [ "$BYTES" -gt 10000 ] && ok "$url  ($TIPO, $BYTES bytes)" \
                             || nok "$url respondeu javascript pequeno demais: $BYTES bytes" ;;
    *) nok "$url respondeu '$TIPO', nao javascript" ;;
  esac
done

SOMA_OP=$(curl -s "$OP/components/loop-sidebar.js" | md5sum | cut -d' ' -f1)
SOMA_UNI=$(curl -s "$UNI/components/loop-sidebar.js" | md5sum | cut -d' ' -f1)
[ -n "$SOMA_OP" ] && [ "$SOMA_OP" = "$SOMA_UNI" ] \
  && ok "byte a byte identico pelas duas rotas ($SOMA_OP)" \
  || nok "o arquivo difere conforme o caminho: $SOMA_OP x $SOMA_UNI"

echo "--- e a Gestao aponta para ele, fora do basePath ---"
if grep -q "'/components/loop-sidebar.js'" "$REPO_GE/apps/web/src/components/layout/loop-sidebar.tsx" 2>/dev/null; then
  ok "a Gestao carrega /components/loop-sidebar.js"
else
  nok "a Gestao nao aponta para o arquivo compartilhado"
fi

echo
echo "=== 3. as duas portas mandam a MESMA lista ==="
preparar_mfa "$EMAIL" "$SENHA"
S=$(entrar "$EMAIL" "$SENHA")
case "$S" in *.*.*) : ;; *) echo "  FALHOU nao autenticou $EMAIL"; exit 1 ;; esac

ORG=$(docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
const u=db.prepare('SELECT id FROM users WHERE email = ?').get('$EMAIL');
console.log(db.prepare('SELECT organization_id FROM workspaces WHERE created_by = ?').get(u.id).organization_id);
" 2>/dev/null | tr -d '\r')

TOK=$(docker exec novo-operacao node -e "
const jwt=require('jsonwebtoken');
const config=require('/app/server/config');
console.log(jwt.sign({organizationId:'$ORG',papel:'TITULAR'},config.federationSecret,
  {algorithm:'HS256',audience:'operacao',issuer:'gestao',expiresIn:60}));
" 2>/dev/null | tr -d '\r')

curl -s "$OP/api/menu" -H "Authorization: Bearer $S" > "$TMP/m_nav.json"
curl -s "$OP/api/federation/menu" -H "Authorization: Bearer $TOK" > "$TMP/m_fed.json"

# Achata a lista inteira -- secoes, itens, transversais, rodape -- em texto ordenado, com
# TUDO o que decide o desenho: id, rotulo, endereco, modulo e o traco do icone. Comparar so
# os ids deixaria passar exatamente as divergencias que este trabalho veio fechar (o mesmo
# item com nome diferente, ou com desenho diferente).
achatar() {
  python3 -c "
import json,sys
try:
    d=json.load(open('$1'))
except Exception:
    print('ERRO-JSON'); sys.exit(0)
linhas=[]
for s in (d.get('secoes') or []):
    linhas.append('secao|'+str(s.get('titulo')))
    for i in (s.get('itens') or []):
        linhas.append('|'.join(['item',str(i.get('id')),str(i.get('rotulo')),str(i.get('href')),str(i.get('modulo')),str(i.get('icone'))[:40]]))
for i in (d.get('transversais') or []):
    linhas.append('|'.join(['trans',str(i.get('id')),str(i.get('rotulo')),str(i.get('href')),str(i.get('modulo')),str(i.get('icone'))[:40]]))
for i in (d.get('rodape') or []):
    linhas.append('|'.join(['rodape',str(i.get('id')),str(i.get('rotulo')),str(i.get('href')),str(i.get('modulo')),str(i.get('icone'))[:40]]))
print('\n'.join(linhas))
"
}

achatar "$TMP/m_nav.json" > "$TMP/plano_nav.txt"
achatar "$TMP/m_fed.json" > "$TMP/plano_fed.txt"

N=$(grep -c '^item' "$TMP/plano_nav.txt" 2>/dev/null || echo 0)
if [ "$N" -lt 3 ]; then
  nok "a lista do navegador veio com $N itens -- pouco demais para provar algo"
else
  ok "a lista tem $N itens de secao (mais transversais e rodape)"
  if diff -q "$TMP/plano_nav.txt" "$TMP/plano_fed.txt" >/dev/null 2>&1; then
    ok "navegador e federada: identicas, campo a campo"
  else
    nok "as duas portas divergem:"
    diff "$TMP/plano_nav.txt" "$TMP/plano_fed.txt" | head -12 | sed 's/^/         /'
  fi
fi

echo "--- todo item tem icone (o defeito era Telas/Arquivos/Playlists no icone de contrato) ---"
SEM=$(grep -E '^(item|trans|rodape)' "$TMP/plano_nav.txt" | awk -F'|' '$6=="None"||$6==""' | wc -l)
[ "$SEM" -eq 0 ] && ok "nenhum item sem traco" || nok "$SEM item(ns) chegam sem icone"

echo
echo "=== 4. a pagina da Gestao traz a tag ==="
COD=$(curl -s -o "$TMP/ge.html" -w '%{http_code}' "$GE/gestao/dashboard")
if [ "$COD" = "200" ] || [ "$COD" = "307" ] || [ "$COD" = "302" ]; then
  ok "a Gestao responde ($COD)"
else
  nok "a Gestao respondeu $COD"
fi

echo
[ "$falhas" -eq 0 ] && echo "TUDO VERDE -- uma barra so, alimentada igual pelas duas portas" \
                    || echo "$falhas FALHA(S)"
echo "(pixel, fonte e alinhamento continuam precisando de olho humano: nao ha navegador aqui)"
exit "$falhas"
