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
    welcome_tagline: 'Escreva aqui. A gente responde em dias úteis, das 8h às 18h.',
    # O tempo de resposta que o balao anuncia ao abrir. Prometer menos do que se cumpre e o
    # unico jeito de a promessa nao virar reclamacao.
    reply_time: 'in_a_few_hours'
  )
  caixa = Inbox.create!(account: conta, channel: widget, name: NOME_DA_CAIXA)
  puts "caixa criada: #{caixa.name}"
else
  puts "caixa ja existia: #{caixa.name}"
end

# ── O HORARIO: 8 AS 18, DIAS UTEIS ───────────────────────────────────────────────────────
# Decisao do Vitor em 20/09. Os Termos ja prometem "dias uteis, no horario publicado no
# painel" -- ate hoje o painel nao publicava nada, entao a promessa nao tinha como ser
# cobrada nem esperada.
#
# `day_of_week` segue o Ruby: 0 = domingo. Sabado e domingo ficam `closed_all_day`.
caixa.update!(
  working_hours_enabled: true,
  timezone: 'America/Sao_Paulo',
  out_of_office_message:
    'Recebemos a sua mensagem. Nosso atendimento é de segunda a sexta, das 8h às 18h — ' \
    'respondemos assim que abrirmos. Se for urgente e a sua tela estiver fora do ar, ' \
    'escreva "TELA PARADA" que damos prioridade.',
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
puts "horario: seg-sex 8h-18h (America/Sao_Paulo), fim de semana fechado"

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
