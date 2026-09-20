# O ROSTO DO ROBÔ (20/09, pedido do Vitor).
#
#   docker cp rosto-do-robo.png atendimento-rails:/tmp/
#   docker cp avatar-do-robo.rb atendimento-rails:/tmp/
#   docker exec atendimento-rails bundle exec rails runner /tmp/avatar-do-robo.rb
#
# O robô aparecia com o boneco azul padrão do Chatwoot e o rótulo "Robôs" — duas marcas de
# outra empresa dentro da conversa do nosso cliente. Passa a usar o SÍMBOLO DO INFINITO, o
# mesmo que a barra lateral mostra quando está recolhida.
#
# ── O ARQUIVO É QUADRADO, E ISSO NÃO É DETALHE (rodada 2) ──────────────────────────────
# A primeira versão usava `loop-player-symbol.png` direto, que é 182×96 — quase duas vezes
# mais largo que alto, porque é assim que ele vive na barra lateral. O chat desenha qualquer
# rosto como CÍRCULO e recorta pelas laterais: sobravam 53% da largura, e o que restava era
# só o cruzamento do meio. Na tela parecia um X.
#
# `rosto-do-robo.png` é 512×512 com o símbolo centralizado sobre o verde-escuro do painel,
# com 54px de folga entre o canto do símbolo e a borda do círculo. Ele é GERADO a partir do
# mesmo original por `scripts/manutencao/gerar-rosto-do-robo.ps1`, para não haver duas
# versões do símbolo se desencontrando.
#
# IDEMPOTENTE: anexa por cima se já houver.

conta = Account.first
abort('nenhuma conta') if conta.nil?

robo = conta.agent_bots.find_by(name: 'Atendente do Loop Player')
abort('robô não existe — rode ligar-robo.rb antes') if robo.nil?

ARQUIVO = '/tmp/rosto-do-robo.png'
abort("#{ARQUIVO} não está no contêiner") unless File.exist?(ARQUIVO)

# O CORTE EM CÍRCULO É O DEFEITO QUE ESTA CONFERÊNCIA IMPEDE DE VOLTAR. Um arquivo que não
# seja quadrado será recortado, e ninguém descobre isso lendo código — só olhando o chat.
largura, altura = IO.binread(ARQUIVO, 8, 16).unpack('N2')
if largura != altura
  abort("#{ARQUIVO} é #{largura}x#{altura} — o rosto é recortado em círculo e precisa ser QUADRADO")
end

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
