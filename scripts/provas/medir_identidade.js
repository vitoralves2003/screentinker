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

function normalizarCor(c) {
  if (!c) return '';
  const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return c;
  const hex = (n) => Number(n).toString(16).padStart(2, '0');
  return '#' + hex(m[1]) + hex(m[2]) + hex(m[3]);
}

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

      const m = await pagina.evaluate(() => {
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

        const d = (e, campos) => {
          if (!e) return null;
          const c = getComputedStyle(e);
          const o = {};
          for (const k of campos) o[k] = c[k];
          return o;
        };

        return {
          principal: d(principal, ['backgroundColor', 'color', 'borderRadius', 'height', 'fontSize', 'fontWeight', 'paddingLeft']),
          secundario: d(secundario, ['borderColor', 'color', 'borderRadius', 'height', 'fontSize']),
          campo: d(campo, ['borderColor', 'borderRadius', 'height', 'fontSize', 'backgroundColor', 'paddingLeft']),
          cartao: d(cartao, ['borderRadius', 'backgroundColor', 'boxShadow', 'borderColor']),
        };
      });

      colhido.push({ ...t, m });
    } catch (e) {
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

  for (const [titulo, chave, atributos] of linhas) {
    console.log('\n' + titulo);
    for (const attr of atributos) {
      const porCasa = {};
      for (const c of colhido) {
        const v = c.m && c.m[chave] ? c.m[chave][attr] : null;
        if (!v) continue;
        const vv = attr.toLowerCase().includes('color') ? normalizarCor(v) : v;
        (porCasa[c.casa] = porCasa[c.casa] || new Set()).add(vv);
      }
      const op = [...(porCasa['OPERAÇÃO'] || [])].join(' | ') || '—';
      const ge = [...(porCasa['GESTÃO'] || [])].join(' | ') || '—';
      const igual = op === ge ? '  ' : '≠ ';
      console.log('  ' + igual + attr.padEnd(17) + ' Operação: ' + op.padEnd(26) + ' Gestão: ' + ge);
    }
  }
  console.log('\n(≠ marca o que difere entre as duas casas)');
})();
