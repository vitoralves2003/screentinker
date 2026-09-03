/*
 * A ENTRADA PELO GOOGLE ESTÁ DE PÉ — os dois caminhos, provados no navegador.
 *
 * ── por que dois ────────────────────────────────────────────────────────────────────────────
 * O produto oferece o Google de duas formas, e elas não se parecem por dentro:
 *
 *   1. O BOTÃO na página de cadastro. Acontece todo no navegador: o script do Google desenha o
 *      botão, a pessoa escolhe a conta, e o site recebe um id_token que manda para a API. Precisa
 *      da ORIGEM autorizada na credencial, e do ID embutido no bundle em tempo de BUILD.
 *
 *   2. O FLUXO OIDC da Operação. Sai do site, passa pelo Google, volta no callback. Precisa da
 *      URI DE REDIRECIONAMENTO autorizada, do ID e do SEGREDO em tempo de execução.
 *
 * Um pode estar de pé e o outro não — foi exatamente o que aconteceu ao configurar: o fluxo OIDC
 * respondeu de primeira e o botão não aparecia no HTML. O botão não estava quebrado; ele só não
 * existe até alguém pedir para criar conta, e é desenhado por JavaScript. `curl` nunca o veria.
 *
 * ── o que ela NÃO faz ───────────────────────────────────────────────────────────────────────
 * Não entra numa conta Google de verdade — isso exigiria uma senha do Google, que não temos e não
 * queremos ter. Ela prova tudo até a porta: que o botão nasce, que o redirecionamento sai com os
 * parâmetros certos, e que o callback recusa quem chega sem estado válido.
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'http://127.0.0.1:3100';

/* O ID é público — ele aparece no HTML para qualquer visitante. Vem do ambiente para a prova não
   precisar ser editada quando a credencial mudar. */
const ID_ESPERADO = process.env.GOOGLE_CLIENT_ID || '';

(async () => {
  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  let falhas = 0;
  const conferir = (o_que, condicao, detalhe) => {
    console.log('  ' + (condicao ? 'ok    ' : 'FALHA ') + o_que + (detalhe ? '   ' + detalhe : ''));
    if (!condicao) falhas++;
  };

  /* ── 1. o provedor está registrado ────────────────────────────────────────────────────── */
  console.log('\n── a Operação oferece o Google ──');
  {
    const pagina = await navegador.newPage();
    const r = await pagina.goto(UNI + '/api/auth/providers', { waitUntil: 'domcontentloaded' });
    const corpo = await r.text();
    const dados = JSON.parse(corpo);
    const google = (dados.providers || []).find((p) => p.slug === 'google');

    conferir('o provedor Google está na lista', !!google);
    /*
     * E o SEGREDO não vaza para quem só quer desenhar botões. A lista pública passa por
     * publicList() justamente por isso, e uma regressão aqui entregaria a chave a qualquer
     * visitante.
     */
    conferir('a lista pública não traz clientSecret nem clientId',
      !/clientSecret|GOCSPX|client_secret/i.test(corpo), corpo.slice(0, 60));
    await pagina.close();
  }

  /* ── 2. o fluxo OIDC sai com os parâmetros certos ─────────────────────────────────────── */
  console.log('\n── o fluxo que sai do site e volta ──');
  {
    const pagina = await navegador.newPage();
    await pagina.setRequestInterception(true);
    let destino = '';
    pagina.on('request', (req) => {
      /* Para no primeiro salto para o Google: não queremos bater no serviço deles numa prova. */
      if (req.url().startsWith('https://accounts.google.com')) { destino = req.url(); req.abort(); }
      else req.continue();
    });

    await pagina.goto(UNI + '/api/auth/oidc/google/start', { waitUntil: 'domcontentloaded' })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 800));

    conferir('o início redireciona para o Google', destino.includes('accounts.google.com'));

    if (destino) {
      const u = new URL(destino);
      conferir('leva a URI de retorno certa',
        (u.searchParams.get('redirect_uri') || '').endsWith('/api/auth/oidc/google/callback'),
        u.searchParams.get('redirect_uri') || '(nenhuma)');
      conferir('pede só os escopos básicos',
        (u.searchParams.get('scope') || '').split(/[+ ]/).sort().join(' ') === 'email openid profile',
        u.searchParams.get('scope') || '(nenhum)');
      /*
       * PKCE. Sem ele, quem interceptasse o código de autorização poderia trocá-lo por um token.
       * O Google não exige para aplicativo web, e é justamente por isso que vale afirmar: uma
       * regressão aqui não daria erro nenhum.
       */
      conferir('usa PKCE (code_challenge S256)',
        u.searchParams.get('code_challenge_method') === 'S256');
      conferir('manda state e nonce',
        !!u.searchParams.get('state') && !!u.searchParams.get('nonce'));

      if (ID_ESPERADO) {
        conferir('usa o ID de cliente configurado',
          u.searchParams.get('client_id') === ID_ESPERADO);
      }
    }
    await pagina.close();
  }

  /* ── 3. o callback recusa quem chega sem estado ───────────────────────────────────────── */
  console.log('\n── o callback não aceita qualquer um ──');
  {
    const pagina = await navegador.newPage();
    await pagina.goto(UNI + '/api/auth/oidc/google/callback?code=inventado&state=inventado',
      { waitUntil: 'domcontentloaded' }).catch(() => {});
    const url = pagina.url();

    /*
     * Ele devolve para a tela de login com um código de erro — nunca uma sessão. Um callback que
     * aceitasse `code` sem o estado que ele mesmo emitiu seria uma porta aberta.
     */
    conferir('recusa um código forjado e volta com erro',
      /sso_error=/.test(url), url.slice(0, 90));
    conferir('e não devolve token nenhum', !/token=/.test(url));
    await pagina.close();
  }

  /* ── 4. o botão nasce na página de criar conta ────────────────────────────────────────── */
  console.log('\n── o botão na página de cadastro ──');
  {
    const pagina = await navegador.newPage();
    await pagina.setViewport({ width: 1280, height: 900 });
    await pagina.goto(UNI + '/gestao/', { waitUntil: 'networkidle0', timeout: 45000 });
    await new Promise((r) => setTimeout(r, 1500));

    /*
     * O botão só existe no modo "criar conta" — a página abre em "entrar". Procura o controle que
     * troca de modo, pelo texto, como uma pessoa faria.
     */
    const trocou = await pagina.evaluate(() => {
      const alvo = [...document.querySelectorAll('button, a')].find((e) =>
        /criar (uma )?conta|cadastr|come[çc]ar|teste gr[áa]tis/i.test(e.textContent || ''));
      if (!alvo) return false;
      alvo.click();
      return true;
    });
    conferir('a página oferece criar conta', trocou);

    await new Promise((r) => setTimeout(r, 2500));

    const oBotao = await pagina.evaluate(() => {
      /* O Google desenha o botão dentro de um iframe próprio, ou num div que ele preenche. */
      const iframe = document.querySelector('iframe[src*="accounts.google.com"]');
      const divDoGoogle = document.querySelector('[id*="g_id"], .g_id_signin, [data-client_id]');
      return { temIframe: !!iframe, temDiv: !!divDoGoogle };
    });

    conferir('o botão do Google aparece', oBotao.temIframe || oBotao.temDiv,
      JSON.stringify(oBotao));

    /* E que o ID que ele usa é o configurado, não um resto de outro projeto. */
    if (ID_ESPERADO) {
      const noHtml = await pagina.content();
      conferir('e usa o ID de cliente configurado', noHtml.includes(ID_ESPERADO));
    }
    await pagina.close();
  }

  await navegador.close();

  console.log('');
  if (falhas) {
    console.log(falhas + ' FALHA(S) na entrada pelo Google');
    process.exit(1);
  }
  console.log('A ENTRADA PELO GOOGLE ESTA DE PE');
})();
