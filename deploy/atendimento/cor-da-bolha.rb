# A COR DA BOLHA, PARA O TEXTO SAIR PRETO (20/09, pedido do Vitor).
#
#   docker exec atendimento-rails bundle exec rails runner /tmp/cor-da-bolha.rb
#
# ── o problema ──────────────────────────────────────────────────────────────────────────
# A mensagem do cliente saía em BRANCO sobre o verde da marca — 1,8:1 de contraste, contra os
# 4,5:1 mínimos. Ele pediu preto, que é o padrão do painel.
#
# ── por que não bastava escolher preto ──────────────────────────────────────────────────
# O Chatwoot não deixa escolher: ele CALCULA a cor do texto a partir da cor de fundo. A conta
# está em `UserMessageBubble.vue` — `color: getContrastingTextColor(widgetColor)`.
#
# A fórmula, lida no código-fonte do pacote `@chatwoot/utils` (não presumida):
#
#     luminancia = r * 0.299 + g * 0.587 + b * 0.114
#     luminancia > 186  ->  texto PRETO
#     luminancia <= 186 ->  texto branco
#
# O nosso #20DF91 dá 157,0 — abaixo do limiar, e por isso branco. Não havia jeito de forçar
# preto: o único caminho é dar a ele uma cor que ATRAVESSE o limiar.
#
# ── a cor escolhida, e por que esta ─────────────────────────────────────────────────────
# #70EBB9 é o mesmo TOM do verde da marca (155,5°) com a mesma saturação, clareado até passar
# do limiar: luminância 192,5, com folga de 6,5. Clarear menos deixaria o texto branco de
# novo; clarear mais afastaria da marca sem ganho nenhum.
#
# ── E O BOTÃO NÃO MUDA ──────────────────────────────────────────────────────────────────
# Esta cor vale dentro da conversa. O botão flutuante continua no verde vivo #20DF91, porque
# a nossa própria folha o pinta (`balao-de-atendimento.tsx`) e ela vence o que vem daqui.
# Quem vê a tela continua vendo o verde da marca no canto.

CANDIDATA = '#70EBB9'.freeze

def luminancia(hex)
  c = hex.delete('#')
  r, g, b = [0, 2, 4].map { |i| c[i, 2].to_i(16) }
  (r * 0.299) + (g * 0.587) + (b * 0.114)
end

lum = luminancia(CANDIDATA)
abort("#{CANDIDATA} daria texto BRANCO (luminância #{lum.round(1)}) — escolha uma cor mais clara") if lum <= 186

conta = Account.first
abort('nenhuma conta') if conta.nil?

widget = Channel::WebWidget.first
abort('nenhum balão configurado') if widget.nil?

antes = widget.widget_color
widget.update!(widget_color: CANDIDATA)

puts "cor da bolha: #{antes} -> #{widget.reload.widget_color}"
puts "  luminância #{lum.round(1)} (limiar 186) -> texto PRETO"
puts "  o botão flutuante segue em #20DF91, pintado pela nossa folha"
puts 'PRONTO'
