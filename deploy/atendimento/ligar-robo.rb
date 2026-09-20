# LIGA O ROBÔ NA CAIXA DE ENTRADA (20/09, etapa 7).
#
#   docker cp ligar-robo.rb atendimento-rails:/tmp/
#   docker exec atendimento-rails bundle exec rails runner /tmp/ligar-robo.rb
#
# IDEMPOTENTE: procura o robô pelo nome antes de criar. Rodar de novo é o caminho de corrigir
# o endereço ou reconectar a caixa.
#
# ── O QUE ELE IMPRIME, E O QUE NÃO ──────────────────────────────────────────────────────
# O segredo e o token do robô SÃO CREDENCIAIS. Eles saem em linhas próprias, marcadas, para o
# script que chama capturar e escrever direto no `.env` do produto — nunca na tela de ninguém.
# O resto da saída só confirma tamanhos.
#
# ── POR QUE O ENDEREÇO É O PÚBLICO ──────────────────────────────────────────────────────
# O atendimento e o produto vivem em redes Docker separadas e não se alcançam por dentro. O
# aviso sai desta máquina, volta pela internet e entra pelo proxy — que por isso precisa da
# linha `location ^~ /api/atendimento`.

conta = Account.first
abort('nenhuma conta') if conta.nil?

NOME = 'Atendente do Loop Player'
DESTINO = ENV['ROBO_URL'] || 'https://beta.loopplayer.com.br/api/atendimento/robo'

robo = conta.agent_bots.find_by(name: NOME)
if robo.nil?
  robo = AgentBot.create!(
    account: conta,
    name: NOME,
    description: 'Responde a partir dos guias da Central de Ajuda e chama a equipe quando não sabe.',
    outgoing_url: DESTINO,
    bot_type: :webhook,
  )
  puts "robô criado"
else
  robo.update!(outgoing_url: DESTINO, bot_type: :webhook)
  puts "robô já existia — endereço atualizado"
end
puts "  endereço: #{robo.outgoing_url}"

# ── A CAIXA ────────────────────────────────────────────────────────────────────────────
# Só a do painel. O e-mail e, um dia, o WhatsApp ficam de fora até alguém decidir o contrário:
# um robô respondendo e-mail formal tem cara diferente de um respondendo chat, e a mesma
# instrução não serve para os dois.
caixa = conta.inboxes.find_by(name: 'Painel do Loop Player')
abort('caixa "Painel do Loop Player" não existe — rode configurar-atendimento.rb antes') if caixa.nil?

ligacao = AgentBotInbox.find_or_initialize_by(inbox_id: caixa.id)
ligacao.agent_bot_id = robo.id
ligacao.account_id = conta.id
ligacao.status = 'enabled'
ligacao.save!
puts "  ligado à caixa: #{caixa.name} (#{ligacao.status})"

# ── AS CREDENCIAIS ─────────────────────────────────────────────────────────────────────
# `secret` assina o aviso que ELE manda; `access_token` é como o produto responde por ele.
segredo = robo.secret
token = robo.access_token&.token
abort('robô sem segredo — versão inesperada do Chatwoot') if segredo.blank?
abort('robô sem token de acesso — versão inesperada do Chatwoot') if token.blank?

puts "  segredo: #{segredo.length} caracteres"
puts "  token: #{token.length} caracteres"
puts "SEGREDO=#{segredo}"
puts "TOKEN=#{token}"
puts 'PRONTO'
