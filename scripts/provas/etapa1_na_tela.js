/*
 * ETAPA 1, NUM NAVEGADOR: os cinco consertos que o Vitor apontou olhando a tela.
 *
 * Cada um e medido onde ele o viu: a barra (Shadow DOM), o titulo do cartao no painel, a
 * miniatura no modal de adicionar, e o campo de contrato dentro de "Editar conteudo".
 *
 * Sem travessao nem traco de caixa neste arquivo de proposito: ele viaja por heredoc e por
 * cat|ssh, e foi exatamente esse tipo de caractere que fez o shell engolir a primeira versao.
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'https://beta.loopplayer.com.br/gestao';
const TOKEN = process.env.TOKEN || '';
const CLIENTE = process.env.CLIENTE || '';

(async () => {
  if (!TOKEN) { console.log('SEM SESSAO: passe TOKEN=...'); process.exit(1); }
  if (!CLIENTE) { console.log('SEM CLIENTE: passe CLIENTE=<nome de um cliente com contrato>'); process.exit(1); }

  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const pagina = await navegador.newPage();
  await pagina.setViewport({ width: 1366, height: 900 });
  await pagina.evaluateOnNewDocument((tk) => {
    localStorage.setItem('token', tk);
    localStorage.setItem('loop_os_token', tk);
  }, TOKEN);

  let falhas = 0;
  const conferir = (o_que, condicao, detalhe) => {
    console.log('  ' + (condicao ? 'ok    ' : 'FALHA ') + o_que + (detalhe ? '   ' + detalhe : ''));
    if (!condicao) falhas++;
  };
  const esperar = (fn, ms, arg) => pagina.waitForFunction(fn, { timeout: ms || 25000, polling: 300 }, arg).catch(() => null);

  /* 1 e 2: a barra */
  console.log('\n-- a barra: sem aviso de aprovacao, sem nome da organizacao --');
  await pagina.goto(UNI + '/dashboard', { waitUntil: 'networkidle0', timeout: 60000 });
  await esperar(() => {
    const el = document.querySelector('loop-sidebar');
    return el && el.shadowRoot && el.shadowRoot.querySelector('.lista a');
  });
  const barra = await pagina.evaluate(() => {
    const el = document.querySelector('loop-sidebar');
    const sr = el && el.shadowRoot;
    if (!sr) return null;
    return {
      itens: sr.querySelectorAll('.lista a').length,
      avisoEspera: !!sr.querySelector('.atencao.espera'),
      textoEspera: /espera(m)? aprova/i.test(sr.textContent || ''),
      lugar: !!sr.querySelector('.lugar'),
      textoLugar: (sr.querySelector('.lugar .nome') || {}).textContent || null,
    };
  });
  conferir('a barra desenhou', !!barra && barra.itens > 0, barra ? barra.itens + ' itens' : 'sem <loop-sidebar>');
  if (barra) {
    conferir('NAO ha o aviso de midia esperando aprovacao', !barra.avisoEspera && !barra.textoEspera);
    conferir('NAO ha o nome da organizacao no topo', !barra.lugar, barra.textoLugar ? 'apareceu: ' + barra.textoLugar : '');
  }

  /* 3: o cartao do painel */
  console.log('\n-- o painel: "Alertas", e nao "Alertas prioritarios" --');
  await esperar(() => /Alertas/.test(document.body.innerText || ''));
  const titulos = await pagina.evaluate(() => [...document.querySelectorAll('h3')].map((h) => h.textContent.trim()));
  conferir('ha um cartao chamado exatamente "Alertas"', titulos.includes('Alertas'), titulos.filter((t) => /Alert/.test(t)).join(' | '));
  conferir('e "Alertas prioritarios" nao existe mais', !titulos.some((t) => /priorit/i.test(t)));

  /* 4: a miniatura no modal de adicionar a tela */
  console.log('\n-- o modal "Adicionar a tela": videos com miniatura --');
  await pagina.goto(UNI + '/telas', { waitUntil: 'networkidle0', timeout: 60000 });
  await esperar(() => document.querySelector('a[href*="/telas/"]'));
  const tela = await pagina.evaluate(() => {
    const a = document.querySelector('a[href*="/telas/"]');
    return a ? a.getAttribute('href') : null;
  });
  conferir('ha uma tela para abrir', !!tela, tela || '');
  if (tela) {
    const destino = tela.startsWith('http') ? tela : (tela.startsWith('/gestao') ? 'https://beta.loopplayer.com.br' + tela : UNI + tela);
    await pagina.goto(destino, { waitUntil: 'networkidle0', timeout: 60000 });
    await esperar(() => /Adicionar conte/.test(document.body.innerText || ''));
    await pagina.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /Adicionar conte/.test(x.textContent));
      if (b) b.click();
    });
    /* A regua honesta: esperar a lista do modal ter linhas, e nao um numero de milissegundos. */
    await esperar(() => /Adicionar (a|à) tela/.test(document.body.innerText || '') && document.querySelectorAll('li').length > 3);
    /* Cada miniatura e um fetch com token e um blob: espera-se pela PRIMEIRA <img> numa linha. */
    await esperar(() => document.querySelector('li img'), 20000);
    const miniaturas = await pagina.evaluate(() => {
      const linhas = [...document.querySelectorAll('li')].filter((li) => /video\/mp4/.test(li.textContent || ''));
      const comImg = linhas.filter((li) => li.querySelector('img')).length;
      return { videos: linhas.length, comImg };
    });
    conferir('o modal lista videos', miniaturas.videos > 0, miniaturas.videos + ' videos');
    conferir('e a maioria tem miniatura de verdade (<img>)', miniaturas.videos > 0 && miniaturas.comImg >= Math.ceil(miniaturas.videos / 2),
      miniaturas.comImg + ' de ' + miniaturas.videos + ' com <img>');
  }

  /* 5: o campo de contrato dentro de Editar conteudo */
  console.log('\n-- "Editar conteudo": o campo de contrato ACHA os contratos do cliente --');
  await pagina.goto(UNI + '/arquivos', { waitUntil: 'networkidle0', timeout: 60000 });
  await esperar(() => document.querySelector('table tbody tr button'));
  /* O NOME abre editar (a miniatura abre a previa). */
  await pagina.evaluate(() => {
    const tr = document.querySelector('table tbody tr');
    const b = tr && [...tr.querySelectorAll('button')].find((x) => /hover:underline/.test(x.className));
    if (b) b.click();
  });
  await esperar(() => /Editar conte/.test(document.body.innerText || ''));
  const abriu = await pagina.evaluate(() => /Editar conte/.test(document.body.innerText || ''));
  conferir('o modal de editar abriu', abriu);
  if (abriu) {
    /*
     * O CAMPO TEM TRES ESTADOS, e a primeira versao desta prova so conhecia um.
     *
     * Com contrato ja escolhido ele mostra o nome e "Remover" -- sem busca nenhuma. A prova
     * procurava um input por /buscar/i e achava o "Buscar arquivos..." da PAGINA, atras do
     * modal: digitava o nome do cliente no filtro de arquivos, nenhuma lista de anunciante
     * aparecia, e a assercao "nao diz 'nao tem contratos'" passava por vazio -- a frase nao
     * estava la porque nada estava la.
     *
     * Agora: "Remover" (se houver) devolve o campo ao estado de busca; o input e achado pelo
     * placeholder EXATO; e cada passo intermediario e afirmado, para a assercao final nao poder
     * passar sem os anteriores terem acontecido.
     */
    await pagina.evaluate(() => {
      const r = [...document.querySelectorAll('button')].find((x) => /^Remover$/.test((x.textContent || '').trim()));
      if (r) r.click();
    });
    const temCampo = await esperar(() => {
      const i = [...document.querySelectorAll('input')].find((x) => x.placeholder === 'Digite o nome do anunciante');
      if (!i) return false;
      i.focus();
      return true;
    }, 8000);
    conferir('o campo "Digite o nome do anunciante" existe', !!temCampo);
    if (temCampo) {
      await pagina.keyboard.type(CLIENTE.slice(0, 6), { delay: 40 });
      const achouCliente = await esperar((nome) => [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === nome), 15000, CLIENTE);
      conferir('a busca lista o anunciante', !!achouCliente, CLIENTE);
      await pagina.evaluate((nome) => {
        const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === nome);
        if (b) b.click();
      }, CLIENTE);
      /* A resposta de /contracts chegou quando "Carregando" some -- e so entao vale ler. */
      const carregou = await esperar(() => {
        const t = document.body.innerText || '';
        return /Trocar anunciante/.test(t) && !/Carregando/.test(t);
      }, 15000);
      conferir('os contratos do anunciante carregaram', !!carregou);
      const texto = await pagina.evaluate(() => document.body.innerText || '');
      conferir('NAO diz "Este anunciante nao tem contratos"', !!carregou && !/anunciante n(ã|a)o tem contratos/i.test(texto),
        (texto.match(/.{0,60}n(ã|a)o tem contratos.{0,20}/i) || [''])[0]);
      /* As opcoes sao <button> dentro de <li>, ao lado de "Trocar anunciante". */
      const listou = await pagina.evaluate(() => {
        const troca = [...document.querySelectorAll('button')].find((x) => /Trocar anunciante/.test(x.textContent || ''));
        const caixa = troca && troca.closest('div') && troca.closest('div').parentElement;
        return caixa ? caixa.querySelectorAll('li button').length : 0;
      });
      conferir('e lista pelo menos um contrato para escolher', listou > 0, listou + ' opcao(oes)');
    }
  }

  await navegador.close();
  console.log('');
  if (falhas) { console.log(falhas + ' FALHA(S) na Etapa 1'); process.exit(1); }
  console.log('A ETAPA 1 ESTA NA TELA');
})().catch((e) => { console.error('A PROVA QUEBROU: ' + e.message); process.exit(2); });
