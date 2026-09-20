# OS ARTIGOS DA CENTRAL DE AJUDA -- migrados da tela `apps/web/src/app/ajuda/`.
#
#   docker cp migrar-artigos.rb atendimento-rails:/tmp/
#   docker exec atendimento-rails bundle exec rails runner /tmp/migrar-artigos.rb
#
# IDEMPOTENTE: procura pelo slug antes de criar, e ATUALIZA o texto se ele mudou. Rodar de
# novo depois de corrigir uma frase e o caminho normal de publicar correcao.
#
# ── O QUE MUDA AO SAIR DA TELA PARA A CENTRAL ───────────────────────────────────────────
# Na tela, um guia so aparecia se a pessoa ALCANCASSE o que ele descreve (`quando: (c) =>
# c.temGestao`, `c.master`). A Central e publica e nao sabe quem le. Em vez de perder a
# informacao, ela virou TEXTO: cada artigo de modulo diz a que plano pertence, na ultima
# linha. Quem tem Pro lendo o guia do Master passa a ver o que ganharia -- e o que antes era
# filtro vira vitrine.
#
# ── O QUE NAO MIGRA, E POR QUE ──────────────────────────────────────────────────────────
#   layouts    o proprio codigo diz que a tela so aparece para a equipe da plataforma. Guia
#              publico de tela que o cliente nao alcanca nao deixa so de ajudar: faz duvidar
#              de que esta olhando o sistema certo.

conta = Account.first
abort('nenhuma conta') if conta.nil?
portal = conta.portals.find_by(slug: 'loop-player')
abort('portal nao existe -- rode configurar-atendimento.rb antes') if portal.nil?
autor = User.first

DO_MODULO_GESTAO = "\n\n---\n\n*Este recurso faz parte do módulo de Gestão.*"
DO_PLANO_MASTER  = "\n\n---\n\n*Este recurso faz parte do plano Master.*"

CATEGORIAS = [
  { slug: 'telas-e-conteudo', nome: 'Telas e conteúdo',
    descricao: 'Adicionar telas, enviar arquivos, montar listas e agendar o que aparece.' },
  { slug: 'clientes-e-contratos', nome: 'Clientes e contratos',
    descricao: 'Cadastrar anunciantes, emitir contratos e dar acesso ao portal.' },
  { slug: 'financeiro', nome: 'Financeiro',
    descricao: 'Cobrança, conciliação e a régua que avisa o cliente.' },
  { slug: 'perguntas-frequentes', nome: 'Perguntas frequentes',
    descricao: 'As dúvidas que mais aparecem, respondidas direto.' }
].freeze

GUIAS = [
  { cat: 'telas-e-conteudo', slug: 'adicionar-uma-tela', titulo: 'Adicionar uma tela', passos: [
    'Instale o Loop Player no aparelho (APK) ou abra o player pelo navegador.',
    'Informe o endereço do servidor quando o app pedir.',
    'Anote o código de 6 dígitos que aparece na tela.',
    'No painel, vá em Telas e clique em Adicionar tela.',
    'Digite o código. A tela aparece na lista em segundos.'] },

  { cat: 'telas-e-conteudo', slug: 'enviar-arquivos', titulo: 'Enviar arquivos', passos: [
    'Vá em Arquivos e clique em Adicionar arquivos.',
    'Arraste os arquivos ou clique para escolher no computador.',
    'Aceita MP4, WebM, JPEG, PNG, GIF e WebP.',
    'A duração dos vídeos é detectada sozinha e a miniatura é gerada.',
    'Clique no nome do arquivo para renomear, pré-visualizar ou agendar.'] },

  { cat: 'telas-e-conteudo', slug: 'montar-uma-playlist', titulo: 'Montar uma playlist', passos: [
    'Vá em Playlists e clique em Nova playlist.',
    'Clique em Adicionar mídia e escolha os arquivos.',
    'Arraste para reordenar e ajuste a duração de cada item.',
    'Em Telas, escolha qual tela recebe esta playlist.',
    'Clique em Publicar. Nada chega às telas antes disso.'] },

  { cat: 'telas-e-conteudo', slug: 'agendar-quando-um-arquivo-aparece',
    titulo: 'Agendar quando um arquivo aparece', passos: [
    'Em Arquivos, clique no nome do arquivo.',
    'Em "Quando pode ser exibido", escolha um tipo de agendamento.',
    'Regras do mesmo tipo somam; de tipos diferentes, todas precisam valer.',
    'A frase abaixo das regras diz em português o que você montou.',
    'Vale para todas as playlists que contêm o arquivo. Publique para enviar.'] },

  { cat: 'telas-e-conteudo', slug: 'ver-quem-mexeu-no-que', titulo: 'Ver quem mexeu no quê', passos: [
    'Vá em Configurações e abra a aba Registro de atividades.',
    'Filtre por pessoa para ver só as ações de alguém.',
    'Visível apenas para o proprietário da conta.'] },

  { cat: 'clientes-e-contratos', slug: 'cadastrar-um-cliente', titulo: 'Cadastrar um cliente',
    rodape: DO_MODULO_GESTAO, passos: [
    'Vá em Clientes e clique em Novo cliente.',
    'Preencha o nome, o contato e os dados do anunciante.',
    'Salve — o cliente já aparece na lista, com busca pelo nome.',
    'Abra o cliente para criar contratos e ver as cobranças dele.'] },

  { cat: 'clientes-e-contratos', slug: 'criar-um-contrato', titulo: 'Criar um contrato',
    rodape: DO_MODULO_GESTAO, passos: [
    'Vá em Contratos e clique em Novo contrato.',
    'Escolha o cliente e um modelo de contrato.',
    'Defina o valor, a vigência (início e fim) e o limite de mídias.',
    'Emita e colha a assinatura — eletrônica ou à caneta.',
    'Ao ativar, a lista de mídias do contrato nasce sozinha.'] },

  { cat: 'clientes-e-contratos', slug: 'a-identidade-da-sua-empresa',
    titulo: 'A identidade da sua empresa', rodape: DO_MODULO_GESTAO, passos: [
    'Em Configurações → Empresa, preencha os dados fiscais (para a nota do serviço).',
    'Envie a sua logomarca e escolha as cores da marca.',
    'Essa identidade veste o cadastro público, os contratos e os recibos.',
    'Copie o link do cadastro público (/cadastro/…) para o cliente se inscrever.'] },

  { cat: 'clientes-e-contratos', slug: 'portal-do-anunciante', titulo: 'Portal do anunciante',
    rodape: DO_PLANO_MASTER, passos: [
    'O portal é um acesso próprio para o seu cliente anunciante.',
    'Em Configurações → Empresa, copie o link do Portal do anunciante.',
    'O anunciante entra, vê só os contratos dele e envia mídias.',
    'As mídias que ele envia entram na fila de aprovação.',
    'Você aprova, e a mídia vai para a lista do contrato.'] },

  { cat: 'clientes-e-contratos', slug: 'a-rede-sua-vitrine-publica',
    titulo: 'A Rede — sua vitrine pública', rodape: DO_PLANO_MASTER, passos: [
    'A Rede é a página pública que apresenta a sua rede a quem quer anunciar.',
    'Em Configurações → Empresa, copie o link de "A Rede".',
    'Ela mostra seus pontos, telas, cidades e o público mensal estimado.',
    'Cada ponto leva foto, cidade e público — definidos no próprio ponto.',
    'Compartilhe o link com quem quer anunciar na sua rede.'] },

  { cat: 'financeiro', slug: 'acompanhar-o-financeiro', titulo: 'Acompanhar o financeiro',
    rodape: DO_MODULO_GESTAO, passos: [
    'Em Financeiro, veja o saldo, o recebido e o que está a receber.',
    'Conecte o Asaas em Configurações → Integrações para cobrar automático.',
    'O extrato bancário concilia os pagamentos sozinho.',
    'Em Pagamentos, escaneie um boleto ou QR Code para pagar.',
    'A aba Assinaturas reúne as cobranças recorrentes.'] },

  { cat: 'financeiro', slug: 'regua-de-cobranca-e-mensagens',
    titulo: 'Régua de cobrança e mensagens', rodape: DO_MODULO_GESTAO, passos: [
    'Em Configurações → Régua de cobrança, monte as etapas (dias antes/depois do vencimento).',
    'Escolha o modo: Assistido (você aprova) ou Automático (envia sozinho pelo WhatsApp).',
    'Cada etapa tem variantes de mensagem, sorteadas para não parecer disparo em massa.',
    'Em Mensagens, a fila mostra o que espera aprovação.',
    '"Sincronizar mensagens" refaz a fila com as cobranças em aberto.'] }
].freeze

PERGUNTAS = [
  { slug: 'que-aparelhos-funcionam', q: 'Que aparelhos funcionam?',
    a: 'TV Box e tablets Android (pelo APK), e qualquer aparelho com navegador, usando o player web.' },
  { slug: 'quais-formatos-de-video', q: 'Quais formatos de vídeo posso enviar?',
    a: 'MP4, WebM, AVI, MKV e MOV. Para compatibilidade máxima use MP4 com H.264.' },
  { slug: 'se-a-internet-cair', q: 'O que acontece se a internet cair?',
    a: 'A tela continua tocando normalmente: o conteúdo já está baixado no aparelho. As alterações que você fizer entram assim que a conexão voltar.' },
  { slug: 'tela-em-pe', q: 'Posso usar a tela em pé?',
    a: 'Pode. Na página da tela, mude a orientação para Retrato e o conteúdo gira sozinho — não precisa girar o vídeo antes de enviar.' },
  { slug: 'como-o-aplicativo-se-atualiza', q: 'Como o aplicativo se atualiza?',
    a: 'Sozinho, a cada 30 minutos ele verifica se há versão nova. Também dá para forçar pela página da tela no painel.' },
  { slug: 'publiquei-e-a-tela-nao-mudou', q: 'Publiquei e a tela não mudou. O que houve?',
    a: 'Verifique se a playlist está publicada e se ela está atribuída a essa tela. Se o arquivo tiver agendamento, confira o relógio ao lado do nome dele em Arquivos: verde é no ar, cinza é fora do horário e vermelho já encerrou.' },
  { slug: 'como-o-meu-cliente-paga', q: 'Como o meu cliente paga?',
    a: 'Pelo Asaas — boleto, Pix ou cartão. A cobrança nasce do contrato e o pagamento concilia sozinho no extrato bancário.',
    rodape: DO_MODULO_GESTAO },
  { slug: 'o-que-o-anunciante-ve-no-portal', q: 'O que o anunciante vê no portal?',
    a: 'Só os contratos dele e as mídias que ele mesmo enviou — nunca nada dos seus outros clientes.',
    rodape: DO_PLANO_MASTER },
  { slug: 'quando-um-contrato-termina', q: 'O que acontece quando um contrato termina?',
    a: 'As mídias param de exibir, mas ficam guardadas — nada é apagado. A régua de cobrança avisa antes do vencimento.',
    rodape: DO_MODULO_GESTAO }
].freeze

cats = {}
CATEGORIAS.each_with_index do |c, i|
  cat = portal.categories.find_by(slug: c[:slug], locale: 'pt_BR')
  if cat.nil?
    cat = Category.create!(account: conta, portal: portal, name: c[:nome],
                           description: c[:descricao], slug: c[:slug],
                           locale: 'pt_BR', position: i)
  else
    cat.update!(name: c[:nome], description: c[:descricao], position: i)
  end
  cats[c[:slug]] = cat
end
puts "categorias: #{cats.size}"

def grava(conta, portal, cat, autor, slug, titulo, corpo, resumo, pos)
  art = portal.articles.find_by(slug: slug)
  if art.nil?
    Article.create!(account: conta, portal: portal, category: cat, author: autor,
                    title: titulo, content: corpo, description: resumo,
                    slug: slug, locale: 'pt_BR', status: :published, position: pos)
    :criado
  else
    art.update!(category: cat, title: titulo, content: corpo, description: resumo,
                status: :published, position: pos)
    :atualizado
  end
end

criados = 0
atualizados = 0

GUIAS.each_with_index do |g, i|
  corpo = g[:passos].each_with_index.map { |p, n| "#{n + 1}. #{p}" }.join("\n")
  corpo += g[:rodape].to_s
  r = grava(conta, portal, cats[g[:cat]], autor, g[:slug], g[:titulo], corpo,
            g[:passos].first, i)
  r == :criado ? criados += 1 : atualizados += 1
end

PERGUNTAS.each_with_index do |p, i|
  corpo = p[:a] + p[:rodape].to_s
  r = grava(conta, portal, cats['perguntas-frequentes'], autor, p[:slug], p[:q], corpo,
            p[:a][0, 140], i)
  r == :criado ? criados += 1 : atualizados += 1
end

puts "artigos criados: #{criados}, atualizados: #{atualizados}"
puts "total no portal: #{portal.articles.count} (#{portal.articles.published.count} publicados)"
puts 'PRONTO'
