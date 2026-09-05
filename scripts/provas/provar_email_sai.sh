#!/bin/sh
# O E-MAIL SAI DE VERDADE — contra a caixa de verdade, e não contra um mock.
#
# As travas de jest prendem a ESCOLHA do transporte e a mensagem de falta. O que só o servidor
# responde: a caixa existe, a senha está certa, a VPS alcança a porta, e o servidor de e-mail
# ACEITA a mensagem. Nenhuma dessas quatro coisas aparece num teste de unidade, e as quatro já
# derrubaram configurações de e-mail em produção.
#
# ── por que ela manda um e-mail DE VERDADE ──────────────────────────────────────────────────
# Um teste que só conecta na porta prova que a rede deixa passar, e não que a credencial serve.
# "Invalid login" só aparece depois do AUTH, e "domínio não verificado" só depois do RCPT TO.
# Então a prova entrega a mensagem inteira — e o destinatário é quem administra, não um cliente.
#
# ── e por que ela roda DENTRO do container ──────────────────────────────────────────────────
# É o ambiente do processo que manda o e-mail de verdade: as variáveis que ele enxerga são as que
# valem. Rodar no host mediria um ambiente que nenhum código usa.
#
# Uso:  DESTINO=voce@exemplo.com sh provar_email_sai.sh
#       (sem DESTINO, manda para o próprio SMTP_USER — que é sempre uma caixa sua)

CONTAINER=${CONTAINER:-novo-gestao-api}

falhas=0
ok()  { echo "  ok    $1"; }
nok() { echo "  FALHA $1"; falhas=$((falhas+1)); }

echo "== o que o processo enxerga =="
# Os NOMES, nunca os valores: a senha não pode aparecer em log de prova, que é o lugar mais
# fácil de esquecer aberto.
ESTADO=$(docker exec "$CONTAINER" sh -c '
  falta=""
  for v in SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASSWORD; do
    eval val=\$$v
    [ -n "$val" ] || falta="$falta $v"
  done
  echo "transporte=${EMAIL_TRANSPORT:-(automatico)}"
  echo "host=${SMTP_HOST:-(vazio)}"
  echo "porta=${SMTP_PORT:-(vazio)}"
  echo "usuario=${SMTP_USER:-(vazio)}"
  echo "remetente=${SMTP_FROM:-${EMAIL_FROM:-(vazio)}}"
  echo "senha=$([ -n "$SMTP_PASSWORD" ] && echo definida || echo AUSENTE)"
  echo "falta=$falta"
' 2>&1)
echo "$ESTADO" | sed 's/^/  /'

echo "$ESTADO" | grep -q "falta=$" && ok "nenhuma variavel faltando" || {
  nok "faltam variaveis -- o e-mail nao tem como sair"
  echo ""
  echo "$falhas FALHA(S): configure o .env e reinicie o container"
  exit 1
}

echo ""
echo "== o servidor de e-mail aceita a mensagem? =="
# O nodemailer do próprio container, com as MESMAS variáveis que o serviço lê. Se este envio
# passa e o do produto não, a diferença está no código do produto e não na caixa.
# A SAÍDA VAI PARA UMA VARIÁVEL, e não por um cano até o `sed`.
#
# A primeira versão terminava em `| sed 's/^/  /'` e lia `$?` depois: num pipe, `$?` é o código
# do ÚLTIMO comando, que era o sed — e o sed sempre devolve 0. O node morreu com
# MODULE_NOT_FOUND, a prova imprimiu o rastro de pilha inteiro na tela, e mesmo assim declarou
# "O E-MAIL SAI". Uma prova que mente é pior que prova nenhuma.
SAIDA=$(docker exec -e DESTINO="${DESTINO:-}" "$CONTAINER" node -e '
const nodemailer = require("nodemailer");
const porta = Number(process.env.SMTP_PORT || 465);
const seguro = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : porta === 465;
const para = process.env.DESTINO || process.env.SMTP_USER;
const t = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: porta,
  secure: seguro,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
});
t.sendMail({
  from: process.env.SMTP_FROM || process.env.EMAIL_FROM || process.env.SMTP_USER,
  to: para,
  subject: "Loop Player — o e-mail do servidor está funcionando",
  html: "<p>Se você está lendo isto, o servidor do Loop Player conseguiu mandar e-mail.</p>"
      + "<p>Esta mensagem foi disparada por <code>provar_email_sai.sh</code>. "
      + "A partir de agora o convite do portal e a ativação de conta chegam por este caminho.</p>",
}).then((r) => {
  console.log("ACEITO por " + process.env.SMTP_HOST + " para " + para);
  console.log("resposta: " + (r.response || "(sem resposta)"));
  process.exit(0);
}).catch((e) => {
  // A mensagem do servidor VIAJA: "Invalid login" e "domínio não verificado" pedem coisas
  // diferentes de quem administra, e "falha no envio" faz as duas parecerem a mesma coisa.
  console.log("RECUSADO: " + e.message);
  process.exit(1);
});
' 2>&1)
enviou=$?
echo "$SAIDA" | sed 's/^/  /'

# Duas condições, e não uma: o código de saída E a frase que só o caminho feliz imprime. Um
# `node` que morre antes de chegar ao envio pode devolver 0 em algum ambiente, e "ACEITO por"
# só existe depois de o servidor de e-mail responder.
if [ "$enviou" = "0" ] && echo "$SAIDA" | grep -q "^ACEITO por "; then
  ok "o servidor aceitou a mensagem"
else
  nok "o servidor NAO aceitou (codigo $enviou)"
fi

echo ""
if [ "$falhas" = "0" ]; then
  echo "O E-MAIL SAI"
  echo "(confira a caixa do destinatario -- 'aceito pelo servidor' e o mais longe que o codigo enxerga;"
  echo " entrega em caixa de entrada depende de SPF, DKIM e reputacao, e nenhum deles responde aqui)"
else
  echo "$falhas FALHA(S) no e-mail"
fi
exit $falhas
