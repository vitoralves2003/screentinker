# A COR GUARDADA NO CHATWOOT (20/09, rodada 2).
#
#   docker exec atendimento-rails bundle exec rails runner /tmp/cor-da-bolha.rb
#
# ── O QUE ESTA COR FAZ ──────────────────────────────────────────────────────────────────
# O Chatwoot guarda UM valor de cor para o quadro do chat e o usa em dois papeis opostos:
#
#   como FUNDO    a fala do cliente, o botao do formulario de entrada
#   como LETRA    o botao "Falar com uma pessoa", o link de escrever para a equipe,
#                 sobre fundo BRANCO
#
# Fundo e letra pedem coisas contrarias. Nao existe uma cor boa para os dois.
#
# ── A RODADA ANTERIOR ESCOLHEU O LADO ERRADO ────────────────────────────────────────────
# Em 20/09 eu clareei esta cor para #70EBB9 para o texto da fala sair preto. Funcionou na
# fala e apagou o botao: letra #70EBB9 sobre branco mede 1,47:1, contra os 4,5:1 minimos.
# Trocou um defeito por outro, e o Vitor viu no print.
#
# ── O ARRANJO DE AGORA ──────────────────────────────────────────────────────────────────
# Esta cor passa a servir ao papel de LETRA, que e o que nao se consegue consertar de fora
# sem uma regra por componente. #047857 e o verde da nossa identidade que se pode ler:
# 5,48:1 sobre branco, e e exatamente o `--lp-marca-tinta` que o painel ja usa em texto e
# links.
#
# O papel de FUNDO e resolvido pela folha que o nosso servidor acrescenta ao quadro do chat
# (deploy/atendimento/nginx-ajuda.loopplayer.com.br.conf): ela promove a fala do cliente ao
# verde vivo #20DF91 com tinta preta, 12,03:1.
#
#   Chatwoot  ->  #047857   todo lugar onde a cor vira LETRA ja nasce legivel
#   a folha   ->  #20DF91   onde a cor e FUNDO, a marca aparece, com preto por cima
#
# ── POR QUE NAO DEIXAR TUDO PARA A FOLHA ────────────────────────────────────────────────
# Porque cada regra da folha precisa mirar numa classe do Chatwoot, e classe que ele
# renomeia faz a regra parar de valer. Uma cor base ja legivel significa que os lugares
# NAO cobertos pela folha continuam certos sozinhos -- inclusive os que ainda nao existem.
#
# ── O BOTAO FLUTUANTE NAO VEM DAQUI ─────────────────────────────────────────────────────
# Ele e desenhado na nossa pagina, e quem o pinta e `balao-de-atendimento.tsx`, com
# `--lp-marca` e `--lp-marca-sobre`. Nada nesta cor o alcanca.

CANDIDATA = '#047857'.freeze

# A conta que o Chatwoot faz para decidir a cor do texto sobre um fundo, lida no codigo de
# `@chatwoot/utils` (nao presumida): luminancia > 186 da texto preto, senao branco.
def luminancia(hex)
  c = hex.delete('#')
  r, g, b = [0, 2, 4].map { |i| c[i, 2].to_i(16) }
  (r * 0.299) + (g * 0.587) + (b * 0.114)
end

# O contraste de verdade (WCAG), que e outra conta -- e a que diz se da para LER.
def relativa(canal)
  c = canal / 255.0
  c <= 0.03928 ? c / 12.92 : (((c + 0.055) / 1.055)**2.4)
end

def luminancia_relativa(hex)
  c = hex.delete('#')
  r, g, b = [0, 2, 4].map { |i| relativa(c[i, 2].to_i(16)) }
  (0.2126 * r) + (0.7152 * g) + (0.0722 * b)
end

def contraste(a, b)
  la = luminancia_relativa(a)
  lb = luminancia_relativa(b)
  (([la, lb].max + 0.05) / ([la, lb].min + 0.05))
end

# A CONFERENCIA QUE IMPORTA: esta cor vai virar LETRA sobre branco. Se ela nao passar aqui,
# o botao de chamar uma pessoa fica invisivel -- que e exatamente o defeito que esta rodada
# conserta. Falhar alto e melhor do que gravar e descobrir no print.
sobre_branco = contraste(CANDIDATA, '#FFFFFF')
if sobre_branco < 4.5
  abort("#{CANDIDATA} mede #{sobre_branco.round(2)}:1 sobre branco -- escolha uma cor mais escura")
end

conta = Account.first
abort('nenhuma conta') if conta.nil?

widget = Channel::WebWidget.first
abort('nenhum balao configurado') if widget.nil?

antes = widget.widget_color
widget.update!(widget_color: CANDIDATA)

puts "cor do Chatwoot: #{antes} -> #{widget.reload.widget_color}"
puts "  como LETRA sobre branco: #{sobre_branco.round(2)}:1  (minimo 4,5)"
puts "  como FUNDO, a folha do nosso servidor promove para #20DF91 com preto: 12,03:1"
puts 'PRONTO'
