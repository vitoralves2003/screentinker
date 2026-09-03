'use strict';

/*
 * A SENHA QUE SE PODE USAR — um lugar só, para os quatro pontos que definem senha.
 *
 * ── o que faltava ────────────────────────────────────────────────────────────────────────────
 * O sistema tem bcrypt, mínimo de 8 caracteres, trava por IP e por conta sem vazar existência.
 * Tudo isso defende contra ADIVINHAR. Contra SABER — uma senha que vazou de outro site e é
 * acertada na primeira tentativa — não fazia nada.
 *
 * E o mínimo de 8 estava escrito quatro vezes, em quatro rotas, com duas mensagens em inglês num
 * produto que é só português desde a Etapa 4.
 *
 * ── como a checagem de vazamento funciona sem entregar a senha ───────────────────────────────
 * k-anonymity, o método do Have I Been Pwned: calcula-se o SHA-1 da senha, envia-se apenas os
 * CINCO PRIMEIROS caracteres do hash, e recebe-se de volta a lista de todos os sufixos conhecidos
 * que começam com aqueles cinco. A comparação é local.
 *
 * O serviço nunca vê a senha nem o hash completo, e recebe um prefixo que casa com centenas de
 * milhares de senhas diferentes. É o padrão da indústria, sem chave de API.
 *
 * ── ela FALHA ABERTO, e isso é deliberado ────────────────────────────────────────────────────
 * Se a rede cair, se o serviço estiver fora, se der timeout: a senha passa. Um cadastro que não
 * consegue ser feito porque um serviço de terceiros está indisponível é pior que uma senha fraca
 * — o cliente vai embora e não volta, e nós nem ficamos sabendo.
 *
 * O limite é curto (2,5s) pelo mesmo motivo: ninguém espera cinco segundos por um cadastro.
 */

const crypto = require('crypto');

const MINIMO = 8;
const LIMITE_MS = 2500;
const ENDERECO = 'https://api.pwnedpasswords.com/range/';

/*
 * Quantas vezes uma senha precisa ter aparecido em vazamentos para ser recusada.
 *
 * 1 seria rigoroso demais: a base tem quase um bilhão de senhas, e combinações razoáveis
 * aparecem uma ou duas vezes por coincidência. 10 recusa o que está em lista de ataque de
 * verdade — "123456" aparece milhões de vezes — sem punir quem escolheu algo incomum que por
 * azar já foi visto.
 */
const VEZES_PARA_RECUSAR = 10;

/*
 * ── O CURTO-CIRCUITO, e por que ele não é otimização ────────────────────────────────────────
 * Quando a rede não responde, cada chamada custa os 2,5s inteiros do limite. Isso não é só lento:
 * na suíte de testes derrubou 312 casos de uma vez, porque cada usuário criado passava a esperar
 * o timeout. Em produção seria o mesmo com o serviço fora — todo cadastro, todo dia, 2,5s a mais,
 * até alguém ligar a lentidão à causa.
 *
 * Depois de uma falha, as próximas chamadas devolvem `null` na hora, por alguns minutos. A senha
 * continua passando (falha aberta), só que sem pagar a espera de novo.
 *
 * O prazo é curto de propósito: uma indisponibilidade de dez minutos não desliga a proteção pelo
 * resto do dia.
 */
const DESCANSO_APOS_FALHA_MS = 5 * 60 * 1000;
let redeCaiuEm = 0;

/** Só para o teste: esquece que a rede caiu. */
function esquecerAFalha() {
  redeCaiuEm = 0;
}

/**
 * Quantas vezes esta senha apareceu em vazamentos conhecidos.
 *
 * Devolve `null` quando não deu para saber (rede, timeout, resposta estranha) — e quem chama
 * trata `null` como "passa", nunca como "recusa".
 *
 * @param {string} senha
 * @param {(url: string, opcoes: object) => Promise<Response>} [buscar] injetável para o teste
 * @returns {Promise<number|null>}
 */
async function vezesEmVazamentos(senha, buscar) {
  const buscador = buscar || globalThis.fetch;
  if (typeof buscador !== 'function') return null;

  /* A rede caiu há pouco: não paga a espera de novo. */
  if (redeCaiuEm && Date.now() - redeCaiuEm < DESCANSO_APOS_FALHA_MS) return null;

  const sha1 = crypto.createHash('sha1').update(senha, 'utf8').digest('hex').toUpperCase();
  const prefixo = sha1.slice(0, 5);
  const sufixo = sha1.slice(5);

  const cancelador = new AbortController();
  const relogio = setTimeout(() => cancelador.abort(), LIMITE_MS);

  try {
    const resposta = await buscador(ENDERECO + prefixo, {
      signal: cancelador.signal,
      headers: { 'Add-Padding': 'true' },
    });
    if (!resposta || !resposta.ok) { redeCaiuEm = Date.now(); return null; }

    redeCaiuEm = 0;   /* respondeu: o descanso acaba aqui */

    const corpo = await resposta.text();
    for (const linha of corpo.split('\n')) {
      const [dele, quantas] = linha.trim().split(':');
      if (dele === sufixo) return Number(quantas) || 0;
    }
    return 0;
  } catch (e) {
    /* Rede fora, timeout, resposta impossível de ler: não sabemos, então não recusamos. */
    redeCaiuEm = Date.now();
    return null;
  } finally {
    clearTimeout(relogio);
  }
}

/**
 * Confere uma senha antes de ela virar hash.
 *
 * @param {string} senha
 * @param {object} [opcoes]
 * @param {boolean} [opcoes.conferirVazamento=true]
 * @param {Function} [opcoes.buscar]
 * @returns {Promise<{ok: boolean, erro?: string}>}
 */
async function conferirSenha(senha, opcoes = {}) {
  const { conferirVazamento = true, buscar } = opcoes;

  if (typeof senha !== 'string' || senha.length < MINIMO) {
    return { ok: false, erro: `A senha precisa ter pelo menos ${MINIMO} caracteres.` };
  }

  if (!conferirVazamento) return { ok: true };

  /*
   * ── A SUÍTE NÃO BATE NA REDE ────────────────────────────────────────────────────────────────
   * A senha que 312 casos usam para criar usuário é `test12345`, e ela ESTÁ em vazamentos de
   * verdade — foi assim que descobri que a checagem funciona: ela recusou, e a suíte inteira
   * parou de conseguir criar contas.
   *
   * Trocar a senha em 312 lugares resolveria hoje e voltaria a quebrar no dia em que alguém
   * escrevesse um teste novo com uma senha comum, que é o que se digita num teste. E cada caso
   * continuaria pagando uma chamada externa para provar coisas que nada têm a ver com senha.
   *
   * `NODE_ENV=test` é posto pelos próprios testes ao subir o servidor. A LÓGICA continua provada
   * em test/senha-segura.test.js, com o buscador injetado — o que se desliga aqui é a viagem até
   * o serviço, não a decisão.
   *
   * E a trava `senha-segura-nas-duas-casas.spec.ts` afirma que este atalho existe só para
   * `test`: se alguém o estender para `production`, ela falha.
   */
  if (process.env.NODE_ENV === 'test' && !buscar) return { ok: true };

  const vezes = await vezesEmVazamentos(senha, buscar);

  /* Não soubemos: passa. Ver a nota sobre falhar aberto, no topo. */
  if (vezes === null) return { ok: true };

  if (vezes >= VEZES_PARA_RECUSAR) {
    /*
     * A mensagem diz o que aconteceu e o que fazer, sem culpar quem escolheu a senha: ela não é
     * "fraca" — ela é conhecida, o que é outra coisa e não depende de quantos símbolos tem.
     */
    return {
      ok: false,
      erro: 'Esta senha já apareceu em vazamentos de outros sites e é testada por invasores. '
        + 'Escolha outra — pode ser simples de lembrar, desde que não seja uma senha comum.',
    };
  }

  return { ok: true };
}

module.exports = {
  conferirSenha, vezesEmVazamentos, esquecerAFalha,
  MINIMO, VEZES_PARA_RECUSAR, DESCANSO_APOS_FALHA_MS,
};
