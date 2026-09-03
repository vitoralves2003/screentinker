/*
 * A IDENTIDADE, ITEM A ITEM — o que ainda difere entre as duas famílias de tela.
 *
 * O Vitor diz que ainda vê "botões, campos e cores diferentes". Isto não julga: colhe os
 * valores computados dos elementos que ele nomeou, nas telas da Operação (CSS próprio,
 * hospedadas) e nas da Gestão (Tailwind), e mostra onde discordam.
 *
 * Serve para o plano ser sobre números. "Cores diferentes" pode ser um verde com dois hexes,
 * ou dois sistemas de cor inteiros — e o custo de cada um não se parece.
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'http://127.0.0.1:3100';
const TOKEN = process.env.TOKEN || '';

const TELAS = [
  { casa: 'OPERAÇÃO', nome: 'Telas', caminho: '/gestao/telas' },
  { casa: 'OPERAÇÃO', nome: 'Arquivos', caminho: '/gestao/arquivos' },
  { casa: 'GESTÃO', nome: 'Clientes', caminho: '/gestao/clientes' },
  { casa: 'GESTÃO', nome: 'Contratos', caminho: '/gestao/contratos' },
];

/*
 * A NORMALIZAÇÃO DE COR RODA DENTRO DA PÁGINA, num canvas — e não com regex aqui fora.
 *
 * A versão de regex acusou duas diferenças que não existiam, e as duas do mesmo jeito:
 *
 *   rgba(0, 0, 0, 0)  ->  #000000     transparente virava PRETO, então um campo sem fundo
 *                                     aparecia como "campo de fundo preto" na Gestão
 *   lab(91.7 -1 -4.8) ->  (cru)       o Tailwind v4 emite lab()/oklch(), o regex não casava,
 *                                     e o valor saía em outra notação — incomparável com hex
 *
 * Perseguir esses dois seria mexer em telas que estão certas. Uma prova que acusa pelo motivo
 * errado custa o mesmo que uma que passa pelo motivo errado: manda consertar o lugar errado.
 *
 * O canvas resolve os dois porque quem interpreta a cor passa a ser o próprio navegador, em
 * qualquer notação que ele saiba escrever — e o alfa sobrevive, então "sem fundo" tem nome.
 */
const NORMALIZAR_NA_PAGINA = `(valor) => {
  if (!valor) return '';
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillStyle = valor;
  const resolvido = ctx.fillStyle;            /* '#rrggbb' ou 'rgba(r, g, b, a)' */
  const m = resolvido.match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/);
  if (!m) return resolvido;
  const a = m[4] === undefined ? 1 : Number(m[4]);
  if (a === 0) return 'sem fundo';
  const hex = (n) => Math.round(Number(n)).toString(16).padStart(2, '0');
  const base = '#' + hex(m[1]) + hex(m[2]) + hex(m[3]);
  return a === 1 ? base : base + ' a' + a;
}`;

(async () => {
  if (!TOKEN) { console.log('SEM SESSAO'); process.exit(1); }
  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  const colhido = [];

  for (const t of TELAS) {
    const pagina = await navegador.newPage();
    await pagina.setViewport({ width: 1440, height: 900 });
    await pagina.evaluateOnNewDocument((tk) => {
      localStorage.setItem('token', tk);
      localStorage.setItem('loop_os_token', tk);
    }, TOKEN);

    try {
      await pagina.goto(UNI + t.caminho, { waitUntil: 'networkidle0', timeout: 45000 });
      await new Promise((r) => setTimeout(r, 3000));

      const m = await pagina.evaluate((fonteDaNormalizacao) => {
        const normalizar = eval(fonteDaNormalizacao);
        const vis = (e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0;
        const cs = (e) => (e ? getComputedStyle(e) : null);

        /* O botão de AÇÃO PRINCIPAL: o mais destacado da tela (fundo forte). */
        const botoes = [...document.querySelectorAll('button, a.btn, .btn')].filter(vis);
        const principal = botoes.find((b) => {
          const c = getComputedStyle(b).backgroundColor;
          return c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent';
        });
        const secundario = botoes.find((b) => {
          const c = getComputedStyle(b);
          return (c.backgroundColor === 'rgba(0, 0, 0, 0)' || c.backgroundColor === 'transparent')
            && c.borderTopWidth !== '0px';
        });

        /* Um CAMPO de texto qualquer. */
        const campo = [...document.querySelectorAll('input[type=text], input[type=search], input:not([type]), select')].filter(vis)[0];

        /* Um CARTÃO: o container branco que agrupa conteúdo. */
        const cartao = [...document.querySelectorAll('div, section, article')].filter((e) => {
          if (!vis(e)) return false;
          const c = getComputedStyle(e);
          const r = e.getBoundingClientRect();
          return c.borderRadius !== '0px' && r.width > 260 && r.height > 90
            && (c.backgroundColor === 'rgb(255, 255, 255)' || c.boxShadow !== 'none');
        })[0];

        /* Cor sai daqui JA NORMALIZADA: quem sabe ler lab() e alfa e o navegador, nao um regex. */
        const d = (e, campos) => {
          if (!e) return null;
          const c = getComputedStyle(e);
          const o = {};
          for (const k of campos) {
            o[k] = k.toLowerCase().includes("color") ? normalizar(c[k]) : c[k];
          }
          return o;
        };

        return {
          principal: d(principal, ['backgroundColor', 'color', 'borderRadius', 'height', 'fontSize', 'fontWeight', 'paddingLeft']),
          secundario: d(secundario, ['borderColor', 'color', 'borderRadius', 'height', 'fontSize']),
          campo: d(campo, ['borderColor', 'borderRadius', 'height', 'fontSize', 'backgroundColor', 'paddingLeft']),
          cartao: d(cartao, ['borderRadius', 'backgroundColor', 'boxShadow', 'borderColor']),
        };
      }, NORMALIZAR_NA_PAGINA);

      colhido.push({ ...t, m });
    } catch (e) {
      /*
       * O erro APARECE. Antes ele ia para um campo que o relatório não imprime, e uma tela que
       * nem carregou saía como '—' — o mesmo símbolo de "não achei este elemento aqui". Foi
       * assim que 'CARTÃO —' na Operação pôde significar duas coisas muito diferentes.
       */
      console.log('!! ' + t.casa + ' / ' + t.nome + ': ' + e.message.slice(0, 90));
      colhido.push({ ...t, erro: e.message.slice(0, 60) });
    }
    await pagina.close();
  }

  await navegador.close();

  /* ── o relatório: uma linha por atributo, as duas casas lado a lado ── */
  const linhas = [
    ['BOTÃO PRINCIPAL', 'principal', ['backgroundColor', 'color', 'borderRadius', 'height', 'fontSize', 'fontWeight']],
    ['BOTÃO SECUNDÁRIO', 'secundario', ['borderColor', 'color', 'borderRadius', 'height', 'fontSize']],
    ['CAMPO', 'campo', ['borderColor', 'borderRadius', 'height', 'fontSize', 'backgroundColor']],
    ['CARTÃO', 'cartao', ['borderRadius', 'backgroundColor', 'boxShadow']],
  ];

  /*
   * DIZER QUAL VAZIO É — porque '—' significava três coisas e eu tratei as três como uma.
   *
   * Aconteceu com 'CARTÃO —' na Operação: eu li como "o cartão da Operação está diferente" e
   * fui atrás de consertar a tela. Não era nada disso: aquelas duas telas não TÊM cartão, elas
   * são tabela de largura inteira. Não havia o que consertar.
   *
   *   (não há)     a tela carregou e não tem esse elemento    -- nada a fazer
   *   (não abriu)  a tela falhou                              -- é defeito, e de outro tipo
   *   —            nenhuma tela desta casa foi medida
   *
   * Um relatório que empata "igual" com "não medi" é pior que um relatório sem a linha: ele dá
   * a mesma tranquilidade das provas verdes que mediam a coisa certa no estado errado.
   */
  function valorDaCasa(casa, chave, attr) {
    const telas = colhido.filter((c) => c.casa === casa);
    if (!telas.length) return '—';
    if (telas.every((c) => c.erro)) return '(não abriu)';

    const vistos = new Set();
    for (const c of telas.filter((x) => x.m)) {
      const grupo = c.m[chave];
      if (grupo && grupo[attr]) vistos.add(grupo[attr]);
    }
    if (!vistos.size) return '(não há)';
    return [...vistos].join(' | ');
  }

  for (const [titulo, chave, atributos] of linhas) {
    console.log('\n' + titulo);
    for (const attr of atributos) {
      const op = valorDaCasa('OPERAÇÃO', chave, attr);
      const ge = valorDaCasa('GESTÃO', chave, attr);

      /* Ausente nos dois lados não é divergência: nenhuma das telas tem o elemento. */
      const ausente = (v) => v === '(não há)' || v === '—';
      const igual = op === ge || (ausente(op) && ausente(ge)) ? '  ' : '≠ ';

      console.log('  ' + igual + attr.padEnd(17) + ' Operação: ' + op.padEnd(26) + ' Gestão: ' + ge);
    }
  }
  console.log('\n(≠ marca o que difere entre as duas casas; "(não há)" é elemento ausente na tela)');
})();
