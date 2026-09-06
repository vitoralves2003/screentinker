#!/bin/sh
# ENTRAR COMO UMA CONTA DE PROVA, PASSANDO PELO SEGUNDO FATOR QUANDO ELE É EXIGIDO (06/09).
#
# Desde o segundo fator, o titular de um workspace com Gestão não recebe sessão só com a senha:
# o login devolve um DESAFIO e espera um código que foi para o WhatsApp ou para o e-mail. A conta
# de prova é exatamente isso (titular de um Master), então toda prova que entrava por curl parou
# de entrar — e é assim que a regra deve se comportar. O caminho legítimo das provas é o mesmo
# das provas de cobrança: de dentro do container, plantar o hash de um código conhecido no
# desafio que o servidor CRIOU, e confirmar por /segundo-fator/confirmar como a porta faria.
# Nada é pulado: o desafio, a validade, as tentativas e o cookie de confiança são os de produção.
#
# uso (roda na VPS, onde há docker):
#   . /opt/novo-operacao/scripts/provas/lib/sessao.sh
#   entrar_de_prova "$EMAIL" "$SENHA" || { echo SEM SESSAO; exit 1; }
#   -> TOKEN (a sessão) e COOKIE_CONFIANCA (o valor de st_dispositivo, quando houve desafio)
entrar_de_prova() {
  _email=$1; _senha=$2
  _base=${BASE:-https://beta.loopplayer.com.br}; _cont=${CONT:-novo-operacao}
  TOKEN=''; COOKIE_CONFIANCA=''
  _resp=$(curl -s -m 20 -X POST "$_base/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$_email\",\"password\":\"$_senha\"}")
  TOKEN=$(printf '%s' "$_resp" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  [ -n "$TOKEN" ] && return 0
  _desafio=$(printf '%s' "$_resp" | sed -n 's/.*"desafio":"\([^"]*\)".*/\1/p')
  [ -n "$_desafio" ] || { echo "SEM SESSAO: o login respondeu $(printf '%s' "$_resp" | head -c 160)" >&2; return 1; }
  # O código nasce aqui, só o hash vai para o banco, e só no desafio ainda não usado.
  _codigo=$(docker exec "$_cont" node -e '
    process.chdir("/app/server");
    const { db } = require("./db/database");
    const { hashToken } = require("./middleware/apiToken");
    const c = String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
    const n = db.prepare("UPDATE codigos_de_acesso SET codigo_hash = ? WHERE id = ? AND usado_em IS NULL").run(hashToken(c), process.argv[1]).changes;
    if (n !== 1) process.exit(2);
    console.log(c);' "$_desafio") || { echo "SEM SESSAO: nao plantou o codigo no desafio $_desafio" >&2; return 1; }
  _conf=$(curl -s -m 20 -D - -X POST "$_base/api/auth/segundo-fator/confirmar" -H 'Content-Type: application/json' \
    -d "{\"desafio\":\"$_desafio\",\"codigo\":\"$_codigo\",\"confiar\":true}")
  COOKIE_CONFIANCA=$(printf '%s' "$_conf" | sed -n 's/^[Ss]et-[Cc]ookie: st_dispositivo=\([^;]*\).*/\1/p' | head -1 | tr -d '\r')
  TOKEN=$(printf '%s' "$_conf" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  [ -n "$TOKEN" ] || { echo "SEM SESSAO: o codigo plantado nao entrou: $(printf '%s' "$_conf" | tail -c 160)" >&2; return 1; }
  return 0
}
