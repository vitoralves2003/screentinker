#!/bin/sh
# COMO AS PROVAS ENTRAM NO PRODUTO.
#
# ── ESTE ARQUIVO ENCOLHEU DE 114 LINHAS PARA ESTAS ───────────────────────────────────────
# Ele existia para dar conta da segunda etapa: gerava o segredo TOTP, calculava o codigo de
# seis digitos com a hora certa, esperava a janela virar quando o codigo estava prestes a
# expirar, guardava o segredo por conta para nao reinscrever, e trocava o token intermediario
# pela sessao de verdade.
#
# A segunda etapa foi removida do produto. Entrar voltou a ser: POST /login, pega o token.
#
# ── POR QUE OS NOMES CONTINUAM OS MESMOS ─────────────────────────────────────────────────
# `preparar_mfa` e `entrar` sao chamados pelas DEZ suites. Renomea-los agora seria mexer em dez
# arquivos no mesmo passo em que se muda o login -- e no dia em que algo falhasse, ninguem
# saberia se foi o login ou a renomeacao. `preparar_mfa` virou uma funcao que nao faz nada, e
# some quando as suites forem tocadas por outro motivo.

# Nao ha mais nada a preparar. Fica como no-op para as suites nao precisarem mudar hoje.
preparar_mfa() { : ; }

# Zerar tambem nao faz mais sentido: nao ha o que zerar.
zerar_mfa() { : ; }

# Entra e devolve o token da sessao. Vazio quando a senha nao confere -- e quem chama TEM de
# conferir: uma suite que segue com token vazio nao falha, ela passa medindo nada. Isso ja
# aconteceu tres vezes neste projeto.
#
# ── POR QUE ELE ESPERA E TENTA DE NOVO ───────────────────────────────────────────────────
# O servidor limita o login a 10 tentativas por minuto por IP (server.js), e isso e certo: e a
# defesa contra quem fica adivinhando senha.
#
# A dança do TOTP que existia aqui antes tinha esperas -- para a janela de trinta segundos
# virar -- e elas ESPAÇAVAM os logins sem que ninguem tivesse pensado nisso. Tirada a dança, as
# onze suites passaram a entrar em rajada e a estourar o limite: 27 checagens ficaram vermelhas
# de uma vez, todas com 401, e nenhuma delas por defeito do produto.
#
# Quem cede e a prova, nao o servidor. Baixar o limite para o teste passar seria enfraquecer em
# producao uma defesa real para nao ter que esperar dez segundos aqui.
entrar() {
  _email="$1"
  _senha="$2"
  _op="${OP:-http://127.0.0.1:3110}"
  _tentativa=0

  while [ "$_tentativa" -lt 4 ]; do
    _cod=$(curl -s -o /tmp/_login.json -w '%{http_code}' -X POST "$_op/api/auth/login" \
      -H 'Content-Type: application/json' \
      -d "{\"email\":\"$_email\",\"password\":\"$_senha\"}" 2>/dev/null)

    # 429 nao e resposta sobre a senha: e o limitador dizendo "espere". Qualquer outro codigo,
    # inclusive 401, e uma resposta de verdade e nao deve ser tentada de novo.
    [ "$_cod" != "429" ] && break

    _tentativa=$((_tentativa + 1))
    sleep 20
  done

  # Le do arquivo, e nao de um `echo`: o JSON tem acentos e barras invertidas, e o `echo` do sh
  # interpreta barra invertida. Ja custou uma rodada aqui.
  python3 -c "
import json
try:
    print(json.load(open('/tmp/_login.json', encoding='utf-8')).get('token', ''))
except Exception:
    print('')
" 2>/dev/null
}
