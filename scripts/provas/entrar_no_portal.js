/*
 * O ANUNCIANTE ENTRA PELA PORTA DELE — num navegador, com uma conta convidada de verdade.
 *
 * ── o que só um navegador responde ──────────────────────────────────────────────────────────
 * Que a tela de entrada existe e o formulário funciona; que depois de entrar o portal desenha; e
 * — o que mais importa — que o casco NÃO é o do produto: nada de Telas, Arquivos, Clientes ou
 * Contratos na frente de quem é de fora.
 *
 * ── a ausência é o ponto ────────────────────────────────────────────────────────────────────
 * Se o portal usasse o `AppShell`, o anunciante veria a barra do assinante. As rotas recusariam
 * cada clique, mas ele veria a lista do que existe na casa de quem o atende, e concluiria que
 * aquilo é dele. Uma prova que só olhasse "o portal abriu" aprovaria isso.
 *
 * Roda de /opt/novo-operacao/scripts/provas:
 *   docker run --rm --network host --user root -v "$PWD:/p" -e EMAIL=... -e SENHA=... \
 *     -e NODE_PATH=/usr/src/app/node_modules --entrypoint node \
 *     zenika/alpine-chrome:with-puppeteer /p/entrar_no_portal.js
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'https://beta.loopplayer.com.br/gestao';
const EMAIL = process.env.EMAIL || '';
const SENHA = process.env.SENHA || '';
/* O nome do cliente que o vínculo alcança — para conferir que o portal mostra o contrato dele. */
const CLIENTE = process.env.CLIENTE || '';

(async () => {
  if (!EMAIL || !SENHA) { console.log('SEM CONTA: passe EMAIL= e SENHA='); process.exit(1); }

  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const pagina = await navegador.newPage();
  await pagina.setViewport({ width: 1280, height: 900 });

  const erros = [];
  pagina.on('pageerror', (e) => erros.push('pageerror: ' + e.message.slice(0, 140)));
  pagina.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (m.text().includes('Failed to load resource')) return;
    erros.push('console.error: ' + m.text().slice(0, 140));
  });

  let falhas = 0;
  const conferir = (o_que, condicao, detalhe) => {
    console.log('  ' + (condicao ? 'ok    ' : 'FALHA ') + o_que + (detalhe ? '   ' + detalhe : ''));
    if (!condicao) falhas++;
  };

  console.log('\n── sem sessao, o portal manda para a entrada ──');
  /*
   * O portão. Sem ele, a tela desenharia, chamaria a API sem token, receberia nulo e concluiria
   * "você não tem contrato" — a lição do AppShell, que este projeto já pagou uma vez.
   */
  await pagina.goto(`${UNI}/portal`, { waitUntil: 'networkidle0', timeout: 45000 });
  await pagina.waitForFunction(() => /Portal do anunciante/i.test(document.body.innerText || ''),
    { timeout: 20000, polling: 300 }).catch(() => {});
  let url = pagina.url();
  conferir('quem chega sem sessao cai na entrada', /\/portal\/entrar/.test(url), url);

  console.log('\n── a tela de entrada ──');
  let texto = await pagina.evaluate(() => document.body.innerText || '');
  conferir('ela se apresenta como portal do anunciante', /Portal do anunciante/i.test(texto),
    texto.slice(0, 160).replace(/\n/g, ' | '));
  /*
   * As duas AUSÊNCIAS são deliberadas: aqui não se cria conta (quem entra foi convidado) e não há
   * "esqueci a senha" (quem perdeu pede um link novo a quem o convidou, que é o mesmo gesto).
   */
  conferir('nao oferece criar conta', !/criar conta|cadastre-se|inscrever/i.test(texto));
  conferir('nao oferece "esqueci a senha"', !/esqueci|recuperar senha/i.test(texto));
  conferir('sem erro de JavaScript', erros.length === 0, erros.join(' ; '));

  console.log('\n── senha errada e recusada, sem dizer o motivo ──');
  const preencherEEntrar = async (email, senha) => {
    await pagina.evaluate((e, s) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const campos = [...document.querySelectorAll('input')];
      const cEmail = campos.find((i) => i.type === 'email');
      const cSenha = campos.find((i) => i.type === 'password');
      if (cEmail) { setter.call(cEmail, e); cEmail.dispatchEvent(new Event('input', { bubbles: true })); }
      if (cSenha) { setter.call(cSenha, s); cSenha.dispatchEvent(new Event('input', { bubbles: true })); }
      const b = [...document.querySelectorAll('button')].find((x) => /Entrar/i.test(x.textContent));
      if (b) b.click();
    }, email, senha);
  };

  await preencherEEntrar(EMAIL, 'senha-errada-de-proposito');
  await pagina.waitForFunction(() => /incorretos/i.test(document.body.innerText || ''),
    { timeout: 15000, polling: 200 }).catch(() => {});
  texto = await pagina.evaluate(() => document.body.innerText || '');
  conferir('a recusa aparece na tela', /E-mail ou senha incorretos/i.test(texto),
    texto.slice(0, 200).replace(/\n/g, ' | '));
  /* A mesma frase para os três casos: distinguir transformaria a porta num verificador de
     e-mails — quem quiser saber se a Padaria é cliente só precisaria tentar. */
  conferir('e ela nao diz QUAL dos casos foi', !/nao existe|não existe|sem vínculo|sem vinculo|nao e anunciante/i.test(texto));

  console.log('\n── com a senha certa, o portal abre ──');
  await preencherEEntrar(EMAIL, SENHA);
  await pagina.waitForFunction(() => /Meus contratos/i.test(document.body.innerText || ''),
    { timeout: 25000, polling: 300 }).catch(() => {});
  url = pagina.url();
  texto = await pagina.evaluate(() => document.body.innerText || '');
  conferir('a sessao leva ao portal', /\/portal(\?|$|\/)/.test(url) && !/\/entrar/.test(url), url);
  conferir('e o portal desenhou', /Meus contratos/i.test(texto), texto.slice(0, 200).replace(/\n/g, ' | '));
  if (CLIENTE) conferir('com o contrato do cliente do vinculo', texto.includes(CLIENTE));

  console.log('\n── e o casco NAO e o do produto ──');
  const casco = await pagina.evaluate(() => ({
    /* A barra do assinante é um custom element: se ela existir, o anunciante está vendo o menu
       da casa de quem o atende. */
    temBarraDoProduto: !!document.querySelector('loop-sidebar'),
    texto: document.body.innerText || '',
  }));
  conferir('a barra do assinante NAO esta na tela', !casco.temBarraDoProduto);
  for (const item of ['Telas', 'Arquivos', 'Playlists', 'Clientes', 'Contratos', 'Financeiro']) {
    conferir(`"${item}" nao aparece no portal`, !new RegExp(`(^|\\n)\\s*${item}\\s*(\\n|$)`).test(casco.texto));
  }
  conferir('mas o Sair esta la', /Sair/.test(casco.texto));
  conferir('sem erro de JavaScript no fim', erros.length === 0, erros.join(' ; '));

  await navegador.close();
  console.log('');
  if (falhas) { console.log(falhas + ' FALHA(S) na porta do portal'); process.exit(1); }
  console.log('O ANUNCIANTE ENTRA PELA PORTA DELE');
})().catch((e) => { console.error('A PROVA QUEBROU: ' + e.message); process.exit(2); });
