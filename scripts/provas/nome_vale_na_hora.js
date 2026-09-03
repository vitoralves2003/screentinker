/*
 * TROCAR O NOME VALE NA HORA — provado trocando de verdade.
 *
 * ── POR QUE ISTO EXISTE ──────────────────────────────────────────────────────────────────
 * O Vitor trocou o nome dele para "Vitão" em Configurações, salvou, e o painel continuou
 * dizendo "Bom dia, Cliente!". Uma tela do produto mostrava um valor e o resto mostrava outro.
 *
 * A causa não é a óbvia: o banco já tinha o nome novo, e um token NOVO também — um login limpo
 * saudava certo. O que estava velho era a SESSÃO dele. O token é assinado na entrada e carrega
 * o nome daquele momento, então quem não sai e entra de novo fica com o nome antigo até
 * a próxima vez.
 *
 * `updateStoredUser` existe exatamente para essa janela e a nota dele diz isso por escrito —
 * só nunca era chamado por ninguém. Um mecanismo escrito e não lido parece resolvido em toda
 * leitura do código, e é por isso que a prova precisa EXERCITAR o caminho: só rodando dá para
 * saber que a ponta está ligada.
 *
 * ── O QUE ELA FAZ ────────────────────────────────────────────────────────────────────────
 * Entra, lê o nome que a saudação usa, TROCA o nome em Configurações, volta ao painel SEM
 * refazer a sessão, e confere que a saudação mudou. No fim devolve o nome original — inclusive
 * se falhar no meio.
 *
 * ── COMO RODA ────────────────────────────────────────────────────────────────────────────
 *   docker run --rm --network host --entrypoint node \
 *     -e NODE_PATH=/usr/src/app/node_modules -e UNI=https://beta.loopplayer.com.br \
 *     -v /opt/novo-operacao/scripts/provas:/p \
 *     zenika/alpine-chrome:with-puppeteer /p/nome_vale_na_hora.js
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'http://127.0.0.1:3100';
const EMAIL = process.env.PROVA_EMAIL || 'cliente@exemplo.invalid';
const SENHA = process.env.PROVA_SENHA || 'SenhaCliente#2026';
const NOME_DE_PROVA = 'Prova' + Date.now().toString().slice(-5);

let falhou = 0;
function conferir(nome, ok, detalhe) {
  if (ok) console.log('  ok    ' + nome);
  else { falhou++; console.log('  FALHA ' + nome + (detalhe ? '  -> ' + detalhe : '')); }
}

async function apertar(pagina, rotulo) {
  const alvo = await pagina.evaluateHandle((p) => {
    const re = new RegExp(p.fonte, p.flags);
    return [...document.querySelectorAll('button')]
      .find((b) => b.offsetParent !== null && re.test((b.innerText || '').trim()));
  }, { fonte: rotulo.source, flags: rotulo.flags });
  const el = alvo.asElement();
  if (!el) throw new Error('nao achei o botao ' + rotulo);
  await el.click();
}

/* O primeiro nome que a saudação mostra. É ele que o Vitor leu errado. */
async function nomeNaSaudacao(pagina) {
  return pagina.evaluate(() => {
    const m = document.body.innerText.match(/(?:Bom dia|Boa tarde|Boa noite),\s*([^!]+)!/);
    return m ? m[1].trim() : null;
  });
}

async function trocarNomePara(pagina, novo) {
  await pagina.goto(UNI + '/gestao/configuracoes?aba=conta', { waitUntil: 'networkidle0', timeout: 45000 });
  await new Promise((r) => setTimeout(r, 3000));
  /* O campo Nome — o de e-mail vem desabilitado, então o primeiro habilitado é este. */
  const ok = await pagina.evaluate((valor) => {
    const campos = [...document.querySelectorAll('input[type=text], input:not([type])')]
      .filter((i) => i.offsetParent !== null && !i.disabled);
    const campo = campos[0];
    if (!campo) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(campo, valor);
    campo.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, novo);
  if (!ok) throw new Error('nao achei o campo Nome');
  await apertar(pagina, /Salvar perfil/i);
  await new Promise((r) => setTimeout(r, 3500));
}

(async () => {
  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const pagina = await navegador.newPage();
  await pagina.setViewport({ width: 390, height: 700, isMobile: true, hasTouch: true });

  let original = null;
  try {
    /* Entra de verdade: é a sessão que carrega o nome, e é dela que se trata. */
    await pagina.goto(UNI + '/login', { waitUntil: 'networkidle0', timeout: 45000 });
    await new Promise((r) => setTimeout(r, 1800));
    await pagina.type('#loginEmail', EMAIL, { delay: 30 });
    await apertar(pagina, /Continuar/i);
    await new Promise((r) => setTimeout(r, 2500));
    await pagina.evaluate(() => {
      const i = [...document.querySelectorAll('input[type=password]')].find((e) => e.offsetParent !== null);
      if (i) i.focus();
    });
    await pagina.keyboard.type(SENHA, { delay: 30 });
    await apertar(pagina, /Entrar/i);
    await new Promise((r) => setTimeout(r, 7000));

    original = await nomeNaSaudacao(pagina);
    conferir('a saudação mostra um nome', !!original, String(original));

    await trocarNomePara(pagina, NOME_DE_PROVA);

    /*
     * DE VOLTA AO PAINEL SEM REFAZER A SESSÃO. É esse o ponto inteiro: o token continua com o
     * nome antigo, e o que tem de vencer é a sobreposição que o salvar acabou de gravar.
     */
    await pagina.goto(UNI + '/gestao/dashboard', { waitUntil: 'networkidle0', timeout: 45000 });
    await new Promise((r) => setTimeout(r, 4000));
    const depois = await nomeNaSaudacao(pagina);

    conferir('a saudação passou a usar o nome novo, sem refazer a sessão',
      depois === NOME_DE_PROVA, 'esperava ' + NOME_DE_PROVA + ', veio ' + depois);

    const naBarra = await pagina.evaluate(() => {
      const el = document.querySelector('loop-sidebar');
      const p = el && el.shadowRoot && el.shadowRoot.querySelector('.pessoa');
      return p ? p.textContent.replace(/\s+/g, ' ').trim() : '';
    });
    conferir('a barra também mostra o nome novo', naBarra.includes(NOME_DE_PROVA), naBarra.slice(0, 40));
  } catch (e) {
    conferir('a prova rodou', false, e.message.slice(0, 90));
  } finally {
    /* DEVOLVE O NOME, mesmo se algo acima falhou: uma prova não pode deixar a conta trocada. */
    if (original) {
      try { await trocarNomePara(pagina, original); } catch { /* melhor esforço */ }
      const voltou = await pagina.goto(UNI + '/gestao/dashboard', { waitUntil: 'networkidle0', timeout: 30000 })
        .then(() => new Promise((r) => setTimeout(r, 3000)))
        .then(() => nomeNaSaudacao(pagina))
        .catch(() => null);
      conferir('o nome original foi devolvido', voltou === original,
        'esperava ' + original + ', veio ' + voltou);
    }
    await navegador.close();
  }

  console.log(falhou ? '\nFALHOU ' + falhou : '\nO NOME VALE NA HORA');
  process.exit(falhou ? 1 : 0);
})();
