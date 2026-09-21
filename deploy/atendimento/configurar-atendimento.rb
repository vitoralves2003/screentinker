# A CONFIGURACAO DO ATENDIMENTO -- o balao no painel, o horario, e a Central de Ajuda.
#
#   docker cp configurar-atendimento.rb atendimento-rails:/tmp/
#   docker exec atendimento-rails bundle exec rails runner /tmp/configurar-atendimento.rb
#
# IDEMPOTENTE: rodar duas vezes nao duplica nada. Cada peca e procurada antes de ser criada,
# porque este script vai rodar de novo toda vez que um texto de guia mudar.
#
# Os nomes de modelo e coluna aqui foram CONFERIDOS nesta versao (4.17.1), nao supostos:
# o horario mora em `WorkingHour` (e nao `InboxWorkingHour`, que nao existe), e o portal se
# liga ao balao por `Portal#channel_web_widget_id`.

conta = Account.first
abort("nenhuma conta -- crie a conta de dono primeiro") if conta.nil?
puts "conta: #{conta.name} (locale #{conta.locale})"

# ── O BALAO DENTRO DO PAINEL ─────────────────────────────────────────────────────────────
# `website_url` e o endereco de onde o balao vai ser aberto -- o painel do Loop Player.
NOME_DA_CAIXA = 'Painel do Loop Player'
PAINEL = 'https://beta.loopplayer.com.br'

caixa = conta.inboxes.find_by(name: NOME_DA_CAIXA)
if caixa.nil?
  widget = Channel::WebWidget.create!(
    account: conta,
    website_url: PAINEL,
    widget_color: '#20DF91',
    welcome_title: 'Precisa de ajuda?',
    # A FRASE DIZ O QUE ACONTECE (21/09, rodada 3). Ela prometia "dias uteis, das 8h as 18h"
    # enquanto a assistente ja respondia as 22h de um sabado -- prometer MENOS do que se cumpre
    # parece prudencia e na verdade afasta quem precisa, porque quem le as 21h nao escreve.
    welcome_tagline: 'Escreva aqui. Respondemos na hora, todos os dias — e quando precisar, uma pessoa entra na conversa.',
    # O tempo de resposta que o balao anuncia ao abrir. Era `in_a_few_hours`, escrito quando so
    # havia gente atendendo; com a assistente na frente, "algumas horas" e uma espera que nao
    # existe mais.
    reply_time: 'in_a_few_minutes'
  )
  caixa = Inbox.create!(account: conta, channel: widget, name: NOME_DA_CAIXA)
  puts "caixa criada: #{caixa.name}"
else
  puts "caixa ja existia: #{caixa.name}"
end

# ── O HORARIO FICA DESLIGADO (21/09) ─────────────────────────────────────────────────────
# Ele era 8 as 18 em dias uteis, decidido em 20/09 -- quando quem atendia era gente. Desde a
# etapa 7 a assistente responde primeiro, e ela nao tem expediente.
#
# Com o horario LIGADO, o Chatwoot mandava "respondemos assim que abrirmos" logo depois de a
# assistente ja ter respondido: a mesma conversa dizendo as duas coisas, e a segunda
# desmentindo a primeira.
#
# As horas abaixo continuam gravadas de proposito. No dia em que a equipe crescer e o horario
# voltar a valer para uma pessoa, e uma linha que se religa -- e nao uma tabela a reconstruir.
caixa.update!(
  working_hours_enabled: false,
  timezone: 'America/Sao_Paulo',
  out_of_office_message:
    'Recebemos a sua mensagem e respondemos assim que possível. Se for urgente e a sua tela ' \
    'estiver fora do ar, escreva "TELA PARADA" que damos prioridade.',
  greeting_enabled: true,
  greeting_message:
    'Oi! Conte o que está acontecendo e, se puder, mande um print da tela. ' \
    'Cada conversa aqui vira um chamado com número, então nada se perde.'
)

(0..6).each do |dia|
  fim_de_semana = [0, 6].include?(dia)
  hora = WorkingHour.find_or_initialize_by(inbox_id: caixa.id, day_of_week: dia)
  hora.account_id = conta.id
  hora.closed_all_day = fim_de_semana
  hora.open_all_day = false
  hora.open_hour = fim_de_semana ? nil : 8
  hora.open_minutes = fim_de_semana ? nil : 0
  hora.close_hour = fim_de_semana ? nil : 18
  hora.close_minutes = fim_de_semana ? nil : 0
  hora.save!
end
puts "horario: gravado seg-sex 8h-18h, mas DESLIGADO -- a assistente atende a qualquer hora"

# ── A CENTRAL DE AJUDA ───────────────────────────────────────────────────────────────────
# `channel_web_widget_id` e o que amarra a Central ao balao: quem vai abrir um chamado busca
# ANTES nos artigos, e boa parte das duvidas morre ali sem virar conversa.
portal = conta.portals.find_by(slug: 'loop-player')
if portal.nil?
  portal = Portal.create!(
    account: conta,
    name: 'Ajuda do Loop Player',
    slug: 'loop-player',
    page_title: 'Ajuda do Loop Player',
    header_text: 'Guias e respostas para usar o Loop Player no dia a dia.',
    color: '#20DF91',
    homepage_link: PAINEL,
    channel_web_widget_id: caixa.channel_id,
    config: { 'allowed_locales' => ['pt_BR'], 'default_locale' => 'pt_BR' }
  )
  puts "portal criado: /hc/#{portal.slug}"
else
  portal.update!(channel_web_widget_id: caixa.channel_id)
  puts "portal ja existia: /hc/#{portal.slug}"
end

puts "PRONTO"
