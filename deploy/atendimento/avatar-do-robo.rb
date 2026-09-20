# O ROSTO DO ROBÔ (20/09, pedido do Vitor).
#
#   docker cp loop-player-symbol.png atendimento-rails:/tmp/
#   docker cp avatar-do-robo.rb atendimento-rails:/tmp/
#   docker exec atendimento-rails bundle exec rails runner /tmp/avatar-do-robo.rb
#
# O robô aparecia com o boneco azul padrão do Chatwoot e o rótulo "Robôs" — duas marcas de
# outra empresa dentro da conversa do nosso cliente. Passa a usar o SÍMBOLO DO INFINITO, o
# mesmo que a barra lateral mostra quando está recolhida.
#
# IDEMPOTENTE: anexa por cima se já houver.

conta = Account.first
abort('nenhuma conta') if conta.nil?

robo = conta.agent_bots.find_by(name: 'Atendente do Loop Player')
abort('robô não existe — rode ligar-robo.rb antes') if robo.nil?

ARQUIVO = '/tmp/loop-player-symbol.png'
abort("#{ARQUIVO} não está no contêiner") unless File.exist?(ARQUIVO)

robo.avatar.purge if robo.avatar.attached?
robo.avatar.attach(
  io: File.open(ARQUIVO),
  filename: 'loop-player-symbol.png',
  content_type: 'image/png',
)
robo.save!

puts "avatar anexado: #{robo.avatar.attached?}"
puts "  robô: #{robo.name}"
puts "  arquivo: #{(File.size(ARQUIVO) / 1024.0).round(1)} KB"
puts 'PRONTO'
