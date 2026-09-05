/*
 * ARQUIVOS E PLAYLISTS EM REACT ABREM, E MOSTRAM O QUE HÁ — num navegador com sessão.
 *
 * As travas do jest prendem TEXTO e FORMA. O que só um navegador responde: as páginas passam o
 * portão do AppShell e DESENHAM; a lista de arquivos mostra o que a conta tem de verdade; a lista
 * de playlists abre o detalhe da primeira e os itens aparecem; o legado NÃO montou junto; sem
 * erro de JavaScript e sem 5xx.
 *
 * COM o basePath (/gestao): sem ele a casa velha responde qualquer caminho com o casco dela, 200
 * e o mesmo <title> — ver ajuda_nativa.js.
 *
 * Roda de /opt/novo-operacao/scripts/provas:
 *   docker run --rm --network host --user root -v "$PWD:/p" -e TOKEN=... \
 *     -e NODE_PATH=/usr/src/app/node_modules --entrypoint node zenika/alpine-chrome:with-puppeteer \
 *     /p/arquivos_e_playlists_nativos.js
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'https://beta.loopplayer.com.br/gestao';
const TOKEN = process.env.TOKEN || '';
const SAIDA = process.env.SAIDA || '/p';

(async () => {
  if (!TOKEN) { console.log('SEM SESSAO: passe TOKEN=...'); process.exit(1); }

  /* protocolTimeout: a prévia roda o PLAYER dentro do iframe — vídeo, widget, temporizadores — e
     um Input.dispatchKeyEvent chegou a estourar os 30s padrão esperando a página responder. */
  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'], protocolTimeout: 180000 });
  const pagina = await navegador.newPage();
  await pagina.setViewport({ width: 1280, height: 900 });

  const erros = [];
  const respostas5xx = [];
/*
 * O QUE VEM DE DENTRO DO PLAYER É REGISTRADO, E NÃO REPROVA ESTA TELA — mas também não some.
 *
 * O filtro por origem existia só no `console.error`. `pageerror` escapou dele, e a prova passou
 * a reprovar por um defeito que não é desta tela nem foi causado por ela: a prévia embute o
 * player, o player embute cada widget num iframe SANDBOXED, e o arranque do player lê
 * `localStorage.getItem('rd_lang')` sem guarda (server/player/index.html). Num documento
 * sandboxed sem `allow-same-origin`, ler localStorage LANÇA.
 *
 * Silenciar seria pior que reprovar: um defeito real desapareceria da vista. Então ele vai para
 * uma lista própria, IMPRESSA no fim — a prova do player é que deve cobrá-lo, e enquanto ela não
 * o cobrar, ele fica visível aqui sem derrubar o veredito de outra coisa.
 */
const errosDoPlayer = [];
const DE_DENTRO_DO_PLAYER = /sandboxed and lacks the 'allow-same-origin'|rd_lang/i;
pagina.on('pageerror', (e) => {
  const msg = e.message.slice(0, 160);
  if (DE_DENTRO_DO_PLAYER.test(msg)) { errosDoPlayer.push(msg); return; }
  erros.push('pageerror: ' + msg);
});
  pagina.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (m.text().includes('Failed to load resource')) return;
    /*
     * O que sai de DENTRO do player não é erro desta tela.
     *
     * A prévia embute /player num iframe, e o player é outro programa, com provas próprias. Num
     * Chrome headless sem placa de som ele reclama do autoplay ("muted-fallback play() failed:
     * AbortError") toda vez. Filtrar por ORIGEM e não por texto: assim o dia em que o player
     * quebrar de verdade, a prova DELE acusa, e esta aqui não vira uma peneira de mensagens.
     */
    const de = m.location() && m.location().url ? m.location().url : '';
    if (/\/player(\?|$)/.test(de)) return;
    erros.push('console.error: ' + m.text().slice(0, 120));
  });
  pagina.on('response', (r) => { if (r.status() >= 500) respostas5xx.push(r.status() + ' ' + new URL(r.url()).pathname); });

  await pagina.evaluateOnNewDocument((tk) => {
    localStorage.setItem('token', tk);
    localStorage.setItem('loop_os_token', tk);
  }, TOKEN);

  let falhas = 0;
  const conferir = (o_que, condicao, detalhe) => {
    console.log('  ' + (condicao ? 'ok    ' : 'FALHA ') + o_que + (detalhe ? '   ' + detalhe : ''));
    if (!condicao) falhas++;
  };
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

  const abrir = async (caminho) => {
    await pagina.goto(UNI + caminho, { waitUntil: 'networkidle0', timeout: 45000 });
    await pagina.waitForFunction(() => !!document.querySelector('h1'), { timeout: 20000, polling: 300 }).catch(() => {});
    /* As tabelas carregam depois do h1: espera a primeira linha ou o "nenhum" aparecer. */
    await pagina.waitForFunction(() => {
      const t = document.body.innerText || '';
      return document.querySelector('tbody tr[data-content-id], tbody tr[data-playlist-id], li[data-item-id]') || /Nenhum|Sem playlists|vazia/.test(t);
    }, { timeout: 20000, polling: 300 }).catch(() => {});
    await esperar(800);
  };

  const medir = () => pagina.evaluate(() => {
    const texto = document.body.innerText || '';
    return {
      h1s: [...document.querySelectorAll('h1')].map((h) => h.textContent.trim()),
      linhasDeArquivo: document.querySelectorAll('tbody tr[data-content-id]').length,
      linhasDeLista: document.querySelectorAll('tbody tr[data-playlist-id]').length,
      itensDeLista: document.querySelectorAll('li[data-item-id]').length,
      primeiraLista: (document.querySelector('tbody tr[data-playlist-id] a') || {}).getAttribute?.('href') || null,
      casco: !!(document.querySelector('#toastContainer') || document.querySelector('#banners')),
      cssVelho: [...document.querySelectorAll('style')].some((s) => /\.settings-section|--console-bg|\.list-table \{/.test(s.textContent || '')),
      texto,
    };
  });

  /* ── Arquivos ── */
  console.log('\n── /arquivos ──');
  await abrir('/arquivos');
  let m = await medir();
  conferir('um h1 só, e é "Arquivos"', m.h1s.length === 1 && m.h1s[0] === 'Arquivos', JSON.stringify(m.h1s));
  conferir('o botão "Adicionar arquivos" existe', /Adicionar arquivos/.test(m.texto));
  conferir('a lista mostra os arquivos da conta (ou diz que não há)', m.linhasDeArquivo > 0 || /Nenhum arquivo/.test(m.texto), m.linhasDeArquivo + ' linha(s)');
  conferir('o que a conta tem aparece pelo nome', /STUDIO-VS\.mp4|\.mp4|\.jpg|\.png/i.test(m.texto) || m.linhasDeArquivo === 0, '');
  /* Sem distinguir caixa: o cabeçalho da tabela é `text-transform: uppercase` pela identidade
     (table thead th em globals.css), e innerText devolve o texto COMO RENDERIZADO — "NOME". A
     primeira rodada reprovou as colunas de uma tabela que estava certa. */
  conferir('as colunas são Nome · Tipo · Duração · Tamanho · Dimensões', /nome[\s\S]*tipo[\s\S]*duração[\s\S]*tamanho[\s\S]*dimensões/i.test(m.texto));
  conferir('sem CascoOperacao', !m.casco);
  conferir('sem o CSS da casa velha', !m.cssVelho);
  await pagina.screenshot({ path: SAIDA + '/arquivos-nativo.png', fullPage: true });

  /* ── Playlists ── */
  console.log('\n── /playlists ──');
  await abrir('/playlists');
  m = await medir();
  conferir('um h1 só, e é "Playlists"', m.h1s.length === 1 && m.h1s[0] === 'Playlists', JSON.stringify(m.h1s));
  conferir('o botão "Nova playlist" existe', /Nova playlist/.test(m.texto));
  conferir('a lista mostra as playlists da conta (ou diz que não há)', m.linhasDeLista > 0 || /Sem playlists ainda/.test(m.texto), m.linhasDeLista + ' linha(s)');
  conferir('as colunas são Nome · Itens · Duração · Criada em', /nome[\s\S]*itens[\s\S]*duração[\s\S]*criada em/i.test(m.texto));
  conferir('sem CascoOperacao', !m.casco);
  await pagina.screenshot({ path: SAIDA + '/playlists-nativo.png', fullPage: true });

  /* ── o detalhe da primeira ── */
  if (m.primeiraLista) {
    console.log('\n── ' + m.primeiraLista + ' ──');
    const nomeNaLista = await pagina.evaluate(() => (document.querySelector('tbody tr[data-playlist-id] a') || {}).textContent?.trim() || '');
    await abrir(m.primeiraLista.replace(/^\/gestao/, ''));
    const d = await medir();
    conferir('o h1 é o nome da playlist', d.h1s.length === 1 && d.h1s[0] === nomeNaLista, JSON.stringify(d.h1s) + ' vs "' + nomeNaLista + '"');
    conferir('"Adicionar conteúdo" e "Pré-visualizar" existem', /Adicionar conteúdo/.test(d.texto) && /Pré-visualizar/.test(d.texto));
    conferir('os itens aparecem (ou a lista se diz vazia)', d.itensDeLista > 0 || /Esta playlist está vazia/.test(d.texto), d.itensDeLista + ' item(ns)');
    conferir('sem Publicar/Descartar — as listas aplicam na hora', !/\bPublicar\b|Descartar alterações/.test(d.texto));
    conferir('sem CascoOperacao', !d.casco);
    await pagina.screenshot({ path: SAIDA + '/playlist-detalhe-nativo.png', fullPage: true });

    /* ── a prévia, e o "Próximo" que fala com o player por postMessage ──
       Aqui não basta o botão existir: ele manda uma mensagem para o iframe e depende de o player
       RESPONDER com o estado. Se o protocolo estiver errado o botão fica cinza para sempre e o
       contador vazio — e nada no console acusa. Então a prova lê o contador. */
    if (d.itensDeLista > 1) {
      console.log('\n── a prévia ──');
      await pagina.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => /Pré-visualizar/.test(x.textContent || ''));
        if (b) b.click();
      });
      /* O player precisa subir dentro do iframe e postar o estado; 12s é folga para uma TV lenta. */
      await pagina.waitForFunction(() => {
        const el = document.querySelector('[data-posicao-da-previa]');
        return !!el && /\d+ de \d+|As zonas tocam juntas/.test(el.textContent || '');
      }, { timeout: 12000, polling: 300 }).catch(() => {});
      const p1 = await pagina.evaluate(() => ({
        contador: (document.querySelector('[data-posicao-da-previa]') || {}).textContent?.trim() || '',
        temIframe: !!document.querySelector('iframe[title="Prévia da playlist"]'),
        proximoLigado: !![...document.querySelectorAll('button')].find((x) => /Próximo/.test(x.textContent || '') && !x.disabled),
      }));
      conferir('a prévia abre com o player dentro', p1.temIframe);
      conferir('o player respondeu o estado — o contador diz onde está', /\d+ de \d+|As zonas tocam juntas/.test(p1.contador), JSON.stringify(p1.contador));
      if (/\d+ de \d+/.test(p1.contador)) {
        conferir('"Próximo" está habilitado', p1.proximoLigado);
        /*
         * ESPERAR O PLAYER ASSENTAR, e não um número de milissegundos.
         *
         * A primeira versão clicava 1,5s depois de o contador aparecer e reprovava: a mensagem
         * saía (medido com um espião no postMessage), mas o player ainda estava montando o
         * primeiro item e o passo se perdia. O sinal de assentado é o contador ficar PARADO —
         * enquanto o player monta, ele ainda posta estado.
         */
        const estavel = async (ms) => {
          let anterior = null;
          for (let i = 0; i < 40; i++) {
            const agora = await pagina.evaluate(() => (document.querySelector('[data-posicao-da-previa]') || {}).textContent?.trim() || '');
            if (agora && agora === anterior) return agora;
            anterior = agora;
            await esperar(ms);
          }
          return anterior;
        };
        const base = await estavel(500);
        await pagina.evaluate(() => {
          const b = [...document.querySelectorAll('button')].find((x) => /Próximo/.test(x.textContent || '') && !x.disabled);
          if (b) b.click();
        });
        /* Mudar para VAZIO não é andar: o texto novo tem de ser outro "N de M". Sem esta parte a
           prova aprovava um re-render que apagou o contador por um quadro. */
        const andou = await pagina.waitForFunction((antes) => {
          const el = document.querySelector('[data-posicao-da-previa]');
          const t = el ? (el.textContent || '').trim() : '';
          return /^\d+ de \d+$/.test(t) && t !== antes;
        }, { timeout: 10000, polling: 250 }, base).then(() => true).catch(() => false);
        const p2 = await pagina.evaluate(() => (document.querySelector('[data-posicao-da-previa]') || {}).textContent?.trim() || '');
        conferir('"Próximo" ANDA no player — o contador mudou', andou, base + ' → ' + p2);
      }
      await pagina.screenshot({ path: SAIDA + '/playlist-previa-nativo.png' });
      /* Fecha pelo BOTÃO, e não pelo Escape: o player está tocando vídeo dentro do iframe e o
         Input.dispatchKeyEvent do protocolo do Chrome chegou a estourar esperando a página
         responder. O clique via DOM não passa pelo protocolo de entrada. */
      await pagina.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => /^Fechar$/.test((x.textContent || '').trim()));
        if (b) b.click();
      });
      await esperar(600);
    } else {
      console.log('  --    a primeira lista tem menos de 2 itens: a prévia não teria o que andar');
    }
  } else {
    console.log('  --    sem playlist para abrir o detalhe');
  }

  console.log('\n── erros ──');
  conferir('sem erro de JavaScript', erros.length === 0, erros.join(' | '));
  /* Visível, e sem derrubar esta prova: o defeito é do player, e some se ninguém o imprimir. */
  if (errosDoPlayer.length) {
    console.log('  nota  ' + errosDoPlayer.length + ' erro(s) DE DENTRO DO PLAYER, que esta prova nao julga:');
    for (const m of [...new Set(errosDoPlayer)]) console.log('        ' + m);
  }
  conferir('sem 5xx', respostas5xx.length === 0, respostas5xx.join(' | '));

  await navegador.close();
  console.log('');
  if (falhas) { console.log(falhas + ' FALHA(S) em Arquivos/Playlists'); process.exit(1); }
  console.log('ARQUIVOS E PLAYLISTS EM REACT ESTAO DE PE');
})().catch((e) => { console.error('A PROVA QUEBROU: ' + e.message); process.exit(2); });
