# AS RESPOSTAS PRONTAS (20/09, etapa 5 do plano do atendimento).
#
#   docker cp respostas-prontas.rb atendimento-rails:/tmp/
#   docker exec atendimento-rails bundle exec rails runner /tmp/respostas-prontas.rb
#
# IDEMPOTENTE: procura pelo atalho antes de criar, e ATUALIZA o texto se ele mudou. Rodar de
# novo é o caminho normal de corrigir uma frase.
#
# ── COMO SE USA ─────────────────────────────────────────────────────────────────────────
# Na conversa, digitar "/" abre a lista; digitar "/fin" filtra as do financeiro. O texto entra
# na caixa e ainda pode ser editado antes de enviar — resposta pronta é RASCUNHO, não carimbo.
#
# ── POR QUE O PREFIXO, E NÃO PASTAS ─────────────────────────────────────────────────────
# O Chatwoot guarda as respostas numa lista só da conta: não há pasta nem categoria. A forma de
# organizar por área é o PREFIXO do atalho, que a busca filtra. Foi a ressalva que eu levantei
# quando o Vitor perguntou se havia "catálogo por área" — e continua sendo a resposta.
#
#   tel-   telas e aparelhos
#   arq-   arquivos, listas e agendamento
#   fin-   cobrança, boleto e conciliação
#   cnt-   contratos e clientes
#   ger-   as que servem a qualquer assunto
#
# ── O QUE ESTAS RESPOSTAS TÊM EM COMUM ──────────────────────────────────────────────────
# Quase todas TERMINAM PERGUNTANDO ou levam a um guia. Uma resposta pronta que encerra o assunto
# sem confirmar que resolveu é um jeito educado de empurrar o problema de volta — e a pessoa
# volta amanhã com a mesma dúvida, agora irritada.
#
# E nenhuma promete prazo diferente do publicado (1 dia útil, igual para todos os planos): o que
# a tela de Ajuda diz e o que o atendente escreve não podem divergir.

conta = Account.first
abort('nenhuma conta') if conta.nil?

AJUDA = 'https://ajuda.loopplayer.com.br/hc/loop-player'

RESPOSTAS = [
  # ── GERAIS ────────────────────────────────────────────────────────────────────────────
  ['ger-recebi',
   'Recebi sua mensagem e já estou olhando. Volto aqui assim que tiver a resposta — ' \
   'no máximo em 1 dia útil.'],

  ['ger-preciso-de-mais',
   'Para eu achar isso rápido, me ajuda com duas coisas: o nome da tela (ou do cliente) ' \
   'envolvida, e mais ou menos que horas você notou. Se puder mandar um print, melhor ainda.'],

  ['ger-resolvido',
   'Acabei de ajustar aqui. Dá uma olhada aí e me confirma se resolveu? ' \
   'Se ainda estiver estranho, me diga o que você está vendo que eu volto nisso.'],

  ['ger-vou-entrar',
   'Para investigar direito, preciso entrar na sua conta e olhar do seu lado. ' \
   'O acesso fica registrado e aparece na sua tela enquanto durar, e eu saio assim que terminar. ' \
   'Posso?'],

  ['ger-fora-do-horario',
   'Nosso atendimento é de segunda a sexta, das 8h às 18h. Já registrei sua mensagem e ' \
   'respondo assim que abrirmos. Se a sua tela estiver fora do ar, me escreva "TELA PARADA" ' \
   'que eu priorizo.'],

  # ── TELAS ─────────────────────────────────────────────────────────────────────────────
  ['tel-parada',
   "Vamos achar isso juntos. Três perguntas rápidas:\n\n" \
   "1. A TV está ligada e na entrada certa (HDMI)?\n" \
   "2. O aparelho aparece como \"no ar\" na sua lista de Telas?\n" \
   "3. Ela parou hoje ou já estava assim?\n\n" \
   'Se ela está no ar no painel mas a TV mostra outra coisa, costuma ser a entrada da TV.'],

  ['tel-adicionar',
   "O passo a passo está aqui: #{AJUDA}/articles/adicionar-uma-tela\n\n" \
   'O ponto onde mais gente trava é o código de 6 dígitos: ele aparece NA TELA do aparelho, e ' \
   'é esse número que você digita no painel. Me diga se emperrar em algum passo.'],

  ['tel-sem-internet',
   'Quando a internet cai, a tela continua tocando normalmente — o conteúdo já está baixado no ' \
   'aparelho. O que fica para trás são as alterações novas, que entram sozinhas assim que a ' \
   'conexão voltar. Se ela voltou e a tela não atualizou, me avise que eu olho.'],

  # ── ARQUIVOS E LISTAS ─────────────────────────────────────────────────────────────────
  ['arq-nao-mudou',
   "Isso quase sempre é uma destas três:\n\n" \
   "1. A lista não foi publicada (nada vai para as telas antes de publicar).\n" \
   "2. A lista não está atribuída a essa tela.\n" \
   "3. O arquivo tem agendamento e está fora do horário dele.\n\n" \
   "Em Arquivos, o relógio ao lado do nome diz qual é o caso: verde está no ar, cinza está " \
   'fora do horário, vermelho já encerrou. Me conta o que você vê aí.'],

  ['arq-formatos',
   'Aceitamos MP4, WebM, AVI, MKV e MOV para vídeo, e JPEG, PNG, GIF e WebP para imagem. ' \
   'Se der erro no envio, o motivo mais comum é o formato do vídeo — MP4 com H.264 funciona ' \
   'em qualquer aparelho. Me manda o nome do arquivo que eu confiro.'],

  ['arq-agendar',
   "O guia está aqui: #{AJUDA}/articles/agendar-quando-um-arquivo-aparece\n\n" \
   'A regra que confunde: agendamentos do MESMO tipo somam, e de tipos diferentes precisam ' \
   'valer todos ao mesmo tempo. A frase embaixo das regras diz em português o que você montou — ' \
   'vale conferir por ela antes de publicar.'],

  # ── FINANCEIRO ────────────────────────────────────────────────────────────────────────
  ['fin-boleto-nao-chegou',
   'Vou verificar o envio. Enquanto isso: o boleto também fica disponível na ficha do cliente, ' \
   'em Financeiro — dá para copiar o link e mandar direto por lá. Me confirma o nome do cliente ' \
   'e a data de vencimento?'],

  ['fin-pago-e-em-aberto',
   'O pagamento entra sozinho pelo extrato, mas pode levar até um dia útil para aparecer, ' \
   'dependendo da forma de pagamento. Se já passou disso, me manda o nome do cliente e o valor ' \
   'que eu concilio manualmente aqui.'],

  ['fin-como-cobra',
   'A cobrança nasce do contrato e vai pelo Asaas — boleto, Pix ou cartão. O pagamento concilia ' \
   "sozinho no extrato. O guia com o passo a passo: #{AJUDA}/articles/acompanhar-o-financeiro"],

  ['fin-regua',
   "A régua envia os lembretes no seu nome, pelo WhatsApp do seu negócio. Ela tem dois modos: " \
   "Assistido (você aprova cada mensagem) e Automático (envia sozinha).\n\n" \
   "O guia: #{AJUDA}/articles/regua-de-cobranca-e-mensagens\n\n" \
   'Se as mensagens não estão saindo, o primeiro lugar para olhar é Mensagens — a fila mostra ' \
   'o que está esperando aprovação.'],

  # ── CONTRATOS E CLIENTES ──────────────────────────────────────────────────────────────
  ['cnt-fim-de-contrato',
   'Quando um contrato termina, as mídias param de exibir mas ficam guardadas — nada é apagado. ' \
   'Se você renovar, elas voltam ao ar sem precisar subir de novo.'],

  ['cnt-portal',
   "O portal é o acesso do seu anunciante: ele entra, vê só os contratos dele e envia mídias, " \
   "que chegam na sua fila de aprovação.\n\n" \
   "Como liberar: #{AJUDA}/articles/portal-do-anunciante"],

  ['cnt-assinatura',
   'O link de assinatura vai pelo WhatsApp do cliente quando o contrato é emitido. ' \
   'Se ele não recebeu, dá para reenviar pela ficha do contrato — e, se preferir assinar à ' \
   'caneta, o PDF continua disponível para imprimir. Qual dos dois você prefere?'],
].freeze

criadas = 0
atualizadas = 0

RESPOSTAS.each do |atalho, texto|
  r = conta.canned_responses.find_by(short_code: atalho)
  if r.nil?
    conta.canned_responses.create!(short_code: atalho, content: texto)
    criadas += 1
  elsif r.content != texto
    r.update!(content: texto)
    atualizadas += 1
  end
end

puts "respostas criadas: #{criadas}, atualizadas: #{atualizadas}"
puts "total na conta: #{conta.canned_responses.count}"
puts 'por área: ' + conta.canned_responses.pluck(:short_code)
  .group_by { |s| s.split('-').first }
  .map { |area, lista| "#{area}=#{lista.size}" }.sort.join(', ')
puts 'PRONTO'
