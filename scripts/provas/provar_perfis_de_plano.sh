#!/bin/sh
# ── AS CONFIGURAÇÕES NOS TRÊS PERFIS DE PLANO — Etapa 8 da unificação ─────────────────────
#
# A fileira e a porta prometem: aba de CONTA existe para todo assinante; aba de MÓDULO só
# para quem o comprou; e a API da Gestão deixa a conta passar sem o módulo (@ContaDoProduto)
# sem abrir nada do módulo junto.
#
# A prova rebaixa a workspace da conta de teste para `free` (só-Operação), mede, e DEVOLVE O
# PLANO — devolver é parte da prova, não limpeza: um restore que falha calado já deixou a
# conta de teste no plano errado e a suíte seguinte quebrou (ver provar_sessao_unica.sh).
#
# Roda na VPS:  bash provar_perfis_de_plano.sh

UNI=${UNI:-http://127.0.0.1:3100}
EMAIL=${EMAIL:-cliente@exemplo.invalid}
SENHA=${SENHA:-'SenhaCliente#2026'}

. "$(dirname "$0")/mfa_lib.sh"

falhas=0
ok()  { echo "  OK     $1"; }
nok() { echo "  FALHOU $1"; falhas=$((falhas+1)); }

claim() {
  printf '%s' "$1" | cut -d. -f2 | python3 -c "
import base64,sys,json
s=sys.stdin.read().strip(); s+='='*(-len(s)%4)
print(json.loads(base64.urlsafe_b64decode(s)).get('$2',''))"
}
opdb() { docker exec novo-operacao node -e "$1" 2>/dev/null | tr -d '\r'; }

SESSAO=$(entrar "$EMAIL" "$SENHA")
[ -n "$SESSAO" ] || { echo "  FALHOU nao consegui entrar"; exit 1; }
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

# Grupos da fileira servida, como "conta:5 gestao:4"
grupos_da_fileira() {
  curl -s "$UNI/api/configuracoes" -H "Authorization: Bearer $1" | python3 -c "
import json,sys
d=json.load(sys.stdin)
c={}
for a in d.get('abas',[]): c[a.get('grupo','?')]=c.get(a.get('grupo','?'),0)+1
print(' '.join(f'{k}:{v}' for k in sorted(c) for v in [c[k]]))"
}

tem_aba() {  # $1 token, $2 id  ->  imprime o href ou vazio
  curl -s "$UNI/api/configuracoes" -H "Authorization: Bearer $1" | python3 -c "
import json,sys
for a in json.load(sys.stdin).get('abas',[]):
    if a['id']=='$2': print(a['href']); break"
}

cod() { curl -s -o /dev/null -w '%{http_code}' "$UNI$1" -H "Authorization: Bearer $2"; }

PLANO_ANTES=$(plano_ler)
if [ -z "$WS" ] || [ -z "$PLANO_ANTES" ]; then
  nok "sem workspace ou plano legível — não mexo no que não sei devolver"
  exit 1
fi
echo "  (workspace $WS, plano original: $PLANO_ANTES)"

echo "--- 1. COM O MÓDULO (plano $PLANO_ANTES): os dois grupos, e a API do módulo aberta ---"
G=$(grupos_da_fileira "$SESSAO")
case "$G" in *conta:*) ok "grupo conta presente ($G)";; *) nok "sem grupo conta: $G";; esac
case "$G" in *gestao:*) ok "grupo gestao presente";; *) nok "sem grupo gestao: $G";; esac
[ "$(cod /gestao-api/clients "$SESSAO")" = "200" ] \
  && ok "API do módulo responde 200" || nok "API do módulo deveria dar 200"

echo "--- 2. SÓ-OPERAÇÃO (free): conta fica, módulo some — na fileira E na porta ---"
plano_escrever free
sleep 61   # o limitador de login é 10/min/IP e a sessão nova precisa dos claims novos
S_FREE=$(entrar "$EMAIL" "$SENHA")
if [ -z "$S_FREE" ]; then
  nok "não consegui entrar como free"
else
  G=$(grupos_da_fileira "$S_FREE")
  case "$G" in *gestao:*) nok "grupo gestao vazou para o plano free: $G";; *) ok "nenhuma aba de módulo ($G)";; esac
  case "$G" in *conta:*) ok "as abas de conta continuam";; *) nok "as abas de conta sumiram: $G";; esac

  HREF_EMPRESA=$(tem_aba "$S_FREE" empresa)
  case "$HREF_EMPRESA" in
    */gestao/configuracoes*) ok "empresa aponta para a página unificada" ;;
    "") nok "empresa sumiu do perfil só-Operação" ;;
    *) nok "empresa aponta para lugar estranho: $HREF_EMPRESA" ;;
  esac

  # A PORTA: conta passa, módulo não — as duas metades da mesma decisão.
  [ "$(cod /gestao-api/organizations/public-settings "$S_FREE")" = "200" ] \
    && ok "a rota DA CONTA passa sem o módulo (public-settings 200)" \
    || nok "public-settings deveria dar 200 sem o módulo (deu $(cod /gestao-api/organizations/public-settings "$S_FREE"))"
  [ "$(cod /gestao-api/clients "$S_FREE")" = "403" ] \
    && ok "a rota DO MÓDULO continua fechada (clients 403)" \
    || nok "clients deveria dar 403 sem o módulo (deu $(cod /gestao-api/clients "$S_FREE"))"
fi

# DEVOLVER O PLANO É PARTE DA PROVA.
plano_escrever "$PLANO_ANTES"
PLANO_DEPOIS=$(plano_ler)
[ "$PLANO_DEPOIS" = "$PLANO_ANTES" ] \
  && ok "plano devolvido ($PLANO_DEPOIS)" \
  || nok "PLANO NÃO DEVOLVIDO: era $PLANO_ANTES, ficou $PLANO_DEPOIS — conserte antes de rodar qualquer outra prova"

echo
if [ "$falhas" -eq 0 ]; then echo "TODAS PASSARAM"; else echo "$falhas FALHARAM"; exit 1; fi
