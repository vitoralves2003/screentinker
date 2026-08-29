#!/bin/sh
# Ferramentas de teste para um produto que exige segunda etapa.
#
# Existem porque a exigencia de MFA quebrou todos os testes anteriores de uma vez: eles
# entravam com senha e recebiam sessao. Agora recebem um token intermediario, e quem nao
# souber completar a etapa nao consegue testar mais nada.
#
# O segredo do TOTP e guardado cifrado no banco e nao pode ser lido de volta -- entao o
# preparo REMATRICULA a conta e guarda o segredo num arquivo. Isso e aceitavel aqui e em
# nenhum outro lugar: e um ambiente de teste, sem cliente e sem dado real.

OP=${OP:-http://127.0.0.1:3110}

_arqseg() { echo "/tmp/totp.$(echo "$1" | tr -c 'a-zA-Z0-9' '_')"; }

# codigo() SEGREDO -> imprime o codigo de 6 digitos do momento
codigo() {
  docker exec novo-operacao node -e "
const {authenticator}=require('/app/server/node_modules/otplib');
console.log(authenticator.generate('$1'));
" 2>/dev/null | tr -d '\r'
}

# preparar_mfa() EMAIL SENHA -> zera e rematricula a segunda etapa, guardando o segredo
preparar_mfa() {
  _email=$1; _senha=$2
  docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
db.prepare('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_last_step = 0 WHERE email = ?').run('$_email');
" >/dev/null 2>&1

  _s=$(curl -s -X POST $OP/api/auth/login -H 'Content-Type: application/json' \
    -d "{\"email\":\"$_email\",\"password\":\"$_senha\"}" | sed -E 's/.*"token":"([^"]+)".*/\1/')
  _seg=$(curl -s -X POST $OP/api/auth/totp/setup -H "Authorization: Bearer $_s" \
    | sed -E 's/.*"secret":"([^"]+)".*/\1/')
  echo "$_seg" > "$(_arqseg "$_email")"
  # OS CODIGOS DE RECUPERACAO SAO GUARDADOS, nao jogados fora.
  #
  # Esta linha terminava em `-o /dev/null`, e o produto mostra esses codigos UMA VEZ. Cada
  # rematricula os regerava e os descartava na mesma linha -- entao a unica forma de entrar
  # nessa conta passava a ser um codigo TOTP do momento, que depende de relogio, de janela de
  # 30 segundos e de nao ter ninguem mais testando a mesma conta.
  #
  # Isso custou caro de verdade: rematriculei a conta do cliente DEPOIS de lhe entregar o
  # segredo, invalidando o que ele tinha acabado de cadastrar, e nao havia saida de
  # emergencia porque ela tinha sido descartada aqui. Um codigo de recuperacao e de uso
  # unico, nao depende de relogio e ninguem disputa com ninguem.
  curl -s -X POST $OP/api/auth/totp/enable -H "Authorization: Bearer $_s" \
    -H 'Content-Type: application/json' -d "{\"code\":\"$(codigo "$_seg")\"}" \
    | python3 -c 'import json,sys
try: print("\n".join(json.load(sys.stdin).get("recovery_codes") or []))
except Exception: pass' > "$(_arqseg "$_email").recuperacao" 2>/dev/null

  # A ativacao acabou de gastar o codigo desta janela. Quem chamar entrar() em seguida
  # receberia "Invalid code" da protecao contra reuso -- a defesa funcionando, lida como
  # defeito. Esperar a janela virar aqui deixa o terreno limpo para o chamador.
  sleep $(( 31 - $(date +%s) % 30 ))
}

# _verificar() MFA_TOKEN SEGREDO -> troca o token intermediario por uma sessao
_verificar() {
  curl -s -X POST $OP/api/auth/totp/verify -H 'Content-Type: application/json' \
    -d "{\"mfa_token\":\"$1\",\"code\":\"$(codigo "$2")\"}"
}

# entrar() EMAIL SENHA -> imprime uma sessao COMPLETA, atravessando a segunda etapa
entrar() {
  _email=$1; _senha=$2
  _r=$(curl -s -X POST $OP/api/auth/login -H 'Content-Type: application/json' \
    -d "{\"email\":\"$_email\",\"password\":\"$_senha\"}")

  case "$_r" in
    *mfa_required*)
      _mt=$(echo "$_r" | sed -E 's/.*"mfa_token":"([^"]+)".*/\1/')
      _seg=$(cat "$(_arqseg "$_email")" 2>/dev/null)
      _v=$(_verificar "$_mt" "$_seg")

      # O servidor recusa um codigo JA CONSUMIDO dentro da mesma janela de 30 segundos --
      # e a protecao contra reuso funcionando, nao um defeito. Um teste que entra varias
      # vezes seguidas cai nela; entao aqui esperamos a janela virar e tentamos uma vez
      # mais. Isso nao contorna a defesa: para de pedir a ela justamente o que ela existe
      # para negar.
      case "$_v" in
        *nvalid\ code*|*already\ used*|*replay*)
          sleep $(( 31 - $(date +%s) % 30 ))
          _mt=$(curl -s -X POST $OP/api/auth/login -H 'Content-Type: application/json' \
            -d "{\"email\":\"$_email\",\"password\":\"$_senha\"}" \
            | sed -E 's/.*"mfa_token":"([^"]+)".*/\1/')
          _v=$(_verificar "$_mt" "$_seg")
          ;;
      esac

      echo "$_v" | sed -E 's/.*"token":"([^"]+)".*/\1/'
      ;;
    *)
      echo "$_r" | sed -E 's/.*"token":"([^"]+)".*/\1/'
      ;;
  esac
}

# zerar_mfa() EMAIL -> devolve a conta ao estado "sem segunda etapa"
#
# Existe porque um teste que ATIVA o MFA consome a propria pre-condicao: passa uma vez e
# reprova em todas as rodadas seguintes, e a falha parece um defeito do produto quando e
# so o roteiro pedindo um estado que ele mesmo destruiu. Cada prova prepara o proprio
# terreno; nenhuma depende da ordem em que foi chamada.
#
# totp_last_step e NOT NULL -- zero, nao NULL.
zerar_mfa() {
  docker exec novo-operacao node -e "
const {db}=require('/app/server/db/database');
db.prepare('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_last_step = 0 WHERE email = ?').run('$1');
" >/dev/null 2>&1
}
