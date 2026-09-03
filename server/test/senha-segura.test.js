'use strict';

/*
 * A SENHA QUE SE PODE USAR — as provas.
 *
 * Nenhuma delas toca a rede: o buscador é injetado. Um teste que depende de um serviço de
 * terceiros falha no dia em que o serviço cai, e aí ninguém sabe se o defeito é nosso.
 *
 * O que importa afirmar aqui não é "a API responde" — é que a NOSSA decisão está certa em cada
 * resposta possível, inclusive nas que não são resposta nenhuma.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const {
  conferirSenha, vezesEmVazamentos, esquecerAFalha,
  MINIMO, VEZES_PARA_RECUSAR, DESCANSO_APOS_FALHA_MS,
} = require('../lib/senha-segura');

/*
 * O CURTO-CIRCUITO E ESTADO GLOBAL, e por isso cada caso comeca limpando-o.
 *
 * Sem isto, o caso que simula a rede fora liga o descanso e os SEGUINTES passam a devolver null
 * na hora -- e um deles, que esperava uma recusa, passava a aceitar. O teste falhava por causa
 * do vizinho, que e o pior tipo de falha para diagnosticar.
 */
test.beforeEach(() => esquecerAFalha());

/* Monta uma resposta da API a partir de um mapa senha -> quantas vezes vazou. */
function buscadorFalso(vazamentos) {
  return async (url) => {
    const prefixoPedido = url.slice(url.lastIndexOf('/') + 1);

    const linhas = [];
    for (const [senha, vezes] of Object.entries(vazamentos)) {
      const sha1 = crypto.createHash('sha1').update(senha, 'utf8').digest('hex').toUpperCase();
      if (sha1.slice(0, 5) === prefixoPedido) linhas.push(sha1.slice(5) + ':' + vezes);
    }
    /* Ruído: a API sempre devolve centenas de sufixos, e o nosso não é o único. */
    linhas.push('0000000000000000000000000000000000A:3');

    return { ok: true, text: async () => linhas.join('\r\n') };
  };
}

test('recusa uma senha que aparece muito em vazamentos', async () => {
  const r = await conferirSenha('senha-que-vazou-muito', {
    buscar: buscadorFalso({ 'senha-que-vazou-muito': 50000 }),
  });

  assert.equal(r.ok, false);
  assert.match(r.erro, /vazamentos/i);
  /*
   * A mensagem não pode culpar quem escolheu: a senha não é "fraca", é CONHECIDA — e isso não
   * depende de quantos símbolos ela tem. Quem lê precisa entender que trocar resolve.
   */
  assert.doesNotMatch(r.erro, /fraca|insegura|ruim/i);
});

test('aceita uma senha que aparece POUCAS vezes', async () => {
  /*
   * A base tem quase um bilhão de senhas: combinações razoáveis aparecem uma ou duas vezes por
   * coincidência. Recusar a partir de 1 puniria quem escolheu algo incomum.
   */
  const r = await conferirSenha('incomum-mas-ja-vista', {
    buscar: buscadorFalso({ 'incomum-mas-ja-vista': VEZES_PARA_RECUSAR - 1 }),
  });

  assert.equal(r.ok, true);
});

test('aceita uma senha que nunca apareceu', async () => {
  const r = await conferirSenha('esta-nunca-vazou-mesmo', { buscar: buscadorFalso({}) });
  assert.equal(r.ok, true);
});

test('FALHA ABERTO: a rede fora não impede o cadastro', async () => {
  /*
   * A afirmação mais importante do arquivo. Um cadastro que não pode ser feito porque um serviço
   * de terceiros está indisponível é pior que uma senha fraca: o cliente vai embora, e nós nem
   * ficamos sabendo que ele tentou.
   */
  const r = await conferirSenha('uma-senha-qualquer-boa', {
    buscar: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
  });

  assert.equal(r.ok, true);
});

test('FALHA ABERTO também quando o serviço responde errado', async () => {
  const r = await conferirSenha('uma-senha-qualquer-boa', {
    buscar: async () => ({ ok: false, text: async () => 'Service Unavailable' }),
  });

  assert.equal(r.ok, true);
});

test('o mínimo de caracteres continua valendo, e não gasta rede para dizer isso', async () => {
  let bateuNaRede = false;
  const r = await conferirSenha('curta', {
    buscar: async () => { bateuNaRede = true; return { ok: true, text: async () => '' }; },
  });

  assert.equal(r.ok, false);
  assert.match(r.erro, new RegExp(String(MINIMO)));
  assert.equal(bateuNaRede, false, 'senha curta é recusada antes de qualquer chamada externa');
});

test('a mensagem do mínimo está em português', async () => {
  /*
   * Os quatro pontos que definem senha diziam "Password must be at least 8 characters", em dois
   * deles palavra por palavra — num produto que é só português desde a Etapa 4, que apagou
   * 10.073 linhas de tradução justamente para não haver dois idiomas.
   */
  const r = await conferirSenha('abc', { conferirVazamento: false });

  assert.equal(r.ok, false);
  assert.doesNotMatch(r.erro, /password|characters|must be/i);
  assert.match(r.erro, /senha|caracteres/i);
});

test('a senha nunca sai da máquina: só cinco caracteres do hash viajam', async () => {
  /*
   * O ponto inteiro do k-anonymity. Se um dia alguém "simplificar" mandando a senha ou o hash
   * completo, isto falha — e é a única forma de garantir que a simplificação não passe.
   */
  const senha = 'uma-senha-bem-particular-do-vitor';
  const sha1 = crypto.createHash('sha1').update(senha, 'utf8').digest('hex').toUpperCase();

  let urlPedida = '';
  await vezesEmVazamentos(senha, async (url) => {
    urlPedida = url;
    return { ok: true, text: async () => '' };
  });

  assert.ok(urlPedida.length > 0, 'a busca foi chamada');
  assert.doesNotMatch(urlPedida, new RegExp(senha), 'a senha não aparece na URL');
  assert.doesNotMatch(urlPedida, new RegExp(sha1), 'o hash completo não aparece na URL');
  assert.ok(urlPedida.endsWith(sha1.slice(0, 5)), 'viajam exatamente os 5 primeiros do hash');
});

test('depois de uma falha, a proxima chamada nao paga a espera de novo', async () => {
  /*
   * O curto-circuito. Sem ele, cada chamada custa os 2,5s inteiros do limite quando a rede não
   * responde — o que derrubou 312 casos desta suíte de uma vez, porque cada usuário criado
   * passava a esperar o timeout. Em produção seria todo cadastro, todo dia, até alguém ligar a
   * lentidão à causa.
   */
  esquecerAFalha();

  let chamadas = 0;
  const quebrado = async () => { chamadas++; throw new Error('ENOTFOUND'); };

  await conferirSenha('uma-senha-boa-qualquer', { buscar: quebrado });
  assert.equal(chamadas, 1, 'a primeira tenta');

  await conferirSenha('outra-senha-boa-qualquer', { buscar: quebrado });
  assert.equal(chamadas, 1, 'a segunda nem tenta — o descanso está valendo');

  /* E a senha continua passando: falhar aberto não mudou. */
  const r = await conferirSenha('mais-uma-senha-boa', { buscar: quebrado });
  assert.equal(r.ok, true);
});

test('e uma resposta boa encerra o descanso na hora', async () => {
  esquecerAFalha();

  await conferirSenha('senha-durante-a-queda', { buscar: async () => { throw new Error('fora'); } });

  let tentou = false;
  await conferirSenha('senha-depois-da-volta', {
    buscar: async () => { tentou = true; return { ok: true, text: async () => '' }; },
  });
  assert.equal(tentou, false, 'ainda em descanso');

  /* O descanso é curto de propósito: uma queda de dez minutos não desliga a proteção o dia todo. */
  assert.ok(DESCANSO_APOS_FALHA_MS <= 10 * 60 * 1000, 'o descanso não passa de dez minutos');
});
