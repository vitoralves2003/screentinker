/*
 * AS TELAS DE FUNDO ESCURO CONTINUAM ESCURAS — e os campos delas, legíveis.
 *
 * ── POR QUE ESTA PROVA EXISTE ────────────────────────────────────────────────────────────────
 * A identidade deu ao campo um fundo de papel por padrão, porque a medição mostrou um lado com
 * #ffffff e o outro sem fundo declarado. A primeira versão dessa regra ficou FORA de camada — e
 * no Tailwind v4 a precedência é de camada, não de especificidade: fora de camada ela venceria
 * qualquer classe, inclusive o `bg-white/[0.04]` dos campos das três telas de fundo escuro.
 *
 * O resultado seria campo branco com `text-white` dentro. Texto invisível, em três telas, sem
 * nada acusando — o defeito que este produto já pagou duas vezes esta semana.
 *
 * Peguei antes de publicar porque fui LER as telas escuras antes de confiar na regra. Esta prova
 * é para a próxima pessoa não precisar ter a mesma ideia: ela mede o contraste real do texto
 * contra o fundo real do campo, nas três telas, e falha se algum par ficar ilegível.
 *
 * ── POR QUE ELA NÃO PRECISA DE SESSÃO ───────────────────────────────────────────────────────
 * As três são telas de ENTRADA: quem chega nelas ainda não entrou. É o que as torna as únicas
 * que dá para provar sem token, e também as mais caras de quebrar — são a primeira tela que um
 * cliente novo vê.
 */
const puppeteer = require('puppeteer');

const UNI = process.env.UNI || 'http://127.0.0.1:3100';

const TELAS = [
  { nome: 'login do admin', caminho: '/gestao/admin/login' },
  { nome: 'ativar conta', caminho: '/gestao/ativar-conta' },
  { nome: 'comercial', caminho: '/gestao/comercial' },
];

/* Mesma conta de contraste da trava de identidade — WCAG 2.1, relativa. */
const CONTRASTE = `(corA, corB) => {
  const canal = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const lum = ([r, g, b]) => 0.2126 * canal(r / 255) + 0.7152 * canal(g / 255) + 0.0722 * canal(b / 255);
  const a = lum(corA), b = lum(corB);
  const claro = Math.max(a, b), escuro = Math.min(a, b);
  return (claro + 0.05) / (escuro + 0.05);
}`;

(async () => {
  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  let falhas = 0, medidos = 0;

  for (const tela of TELAS) {
    const pagina = await navegador.newPage();
    await pagina.setViewport({ width: 390, height: 700 });

    let resultado;
    try {
      await pagina.goto(UNI + tela.caminho, { waitUntil: 'networkidle0', timeout: 45000 });
      await new Promise((r) => setTimeout(r, 1500));

      resultado = await pagina.evaluate((fonteDoContraste) => {
        const contraste = eval(fonteDoContraste);

        /*
         * A cor EFETIVA do fundo: um campo com fundo translúcido (`bg-white/[0.04]`) mostra o
         * que está atrás dele, então o valor declarado não diz o que se vê. Compõe o campo
         * sobre os ancestrais até achar um opaco — que é o que o olho faz.
         */
        function fundoEfetivo(el) {
          const pilha = [];
          let e = el;
          while (e) {
            const c = getComputedStyle(e).backgroundColor;
            const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
            if (m) {
              const alfa = m[4] === undefined ? 1 : Number(m[4]);
              if (alfa > 0) {
                pilha.push({ rgb: [+m[1], +m[2], +m[3]], alfa });
                if (alfa === 1) break;
              }
            }
            e = e.parentElement;
          }
          /* Do fundo opaco para cima, compondo cada véu sobre o que já havia. */
          let atual = [255, 255, 255];
          for (const camada of pilha.reverse()) {
            atual = atual.map((v, i) => Math.round(camada.rgb[i] * camada.alfa + v * (1 - camada.alfa)));
          }
          return atual;
        }

        const campos = [...document.querySelectorAll('input, textarea, select')]
          .filter((e) => e.offsetParent !== null && e.getBoundingClientRect().height > 8);

        return campos.slice(0, 6).map((campo) => {
          const c = getComputedStyle(campo);
          const t = c.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
          const texto = t ? [+t[1], +t[2], +t[3]] : [0, 0, 0];
          const fundo = fundoEfetivo(campo);
          return {
            tipo: campo.getAttribute('type') || campo.tagName.toLowerCase(),
            texto: 'rgb(' + texto.join(',') + ')',
            fundo: 'rgb(' + fundo.join(',') + ')',
            razao: Number(contraste(texto, fundo).toFixed(2)),
          };
        });
      }, CONTRASTE);
    } catch (erro) {
      console.log('!! ' + tela.nome + ' não abriu: ' + erro.message.slice(0, 70));
      falhas++;
      await pagina.close();
      continue;
    }

    console.log('\n== ' + tela.nome + ' (' + tela.caminho + ') ==');
    if (!resultado.length) {
      /*
       * Zero campos é FALHA, não sucesso. Uma tela que não carregou não tem campo nenhum, e
       * "nenhum campo ilegível" seria verdade nos dois casos — foi assim que provas verdes
       * deste projeto mediram a coisa certa no estado errado.
       */
      console.log('  !! nenhum campo visível — a tela não carregou ou mudou de forma');
      falhas++;
    }

    for (const campo of resultado) {
      medidos++;
      const passa = campo.razao >= 4.5;
      if (!passa) falhas++;
      console.log(
        '  ' + (passa ? 'ok  ' : 'FALHA ') + campo.tipo.padEnd(9) +
        ' texto ' + campo.texto.padEnd(18) + ' sobre ' + campo.fundo.padEnd(18) +
        ' = ' + String(campo.razao).padStart(6) + ':1',
      );
    }

    await pagina.close();
  }

  await navegador.close();

  console.log('\n' + medidos + ' campos medidos nas ' + TELAS.length + ' telas de entrada');
  if (falhas) {
    console.log(falhas + ' FALHA(S) — texto de campo ilegível sobre o fundo que ele realmente tem');
    process.exit(1);
  }
  console.log('nenhum campo ilegível');
})();
