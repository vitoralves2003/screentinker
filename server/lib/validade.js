'use strict';

/*
 * A VALIDADE DE UM DADO NA PAREDE (16/09, regra do Vitor).
 *
 * ── o que aconteceu ─────────────────────────────────────────────────────────────────────────
 * Três telas mostraram, ao meio-dia de 16/09: um placar da Champions de 10/09 e um "AO VIVO ·
 * 83'" de um jogo encerrado. Nenhuma estava travada e o servidor nunca esteve errado — o que
 * faltava é a ideia de que UM DADO TEM PRAZO, e vencido ele não vai à parede.
 *
 * A regra do Vitor: "precisamos que as informações sejam de no máximo 1 dia antes. Se não tiver
 * dados de 1 dia antes ele deixa de ser exibido e passa o conteúdo que tem informação vigente."
 *
 * ── o prazo é do CONTEÚDO, não da busca ─────────────────────────────────────────────────────
 * "Buscado há um minuto" não quer dizer nada: o placar da Champions de 10/09 foi buscado agora
 * há pouco. O que tem de caber no prazo é O DIA DE QUE O CARD FALA.
 *
 * ── e a conta é em DIAS DE CALENDÁRIO, não em horas ─────────────────────────────────────────
 * Esta parte custou duas provas vermelhas, e elas estavam certas. Medindo 24 horas corridas, um
 * jogo de ontem às 21h já estaria vencido hoje ao meio-dia — 27 horas atrás — e o card sumiria
 * no dia seguinte ao clássico, que é quando mais gente comenta. "Um dia antes" na boca de uma
 * pessoa quer dizer ONTEM, e ontem é um dia do calendário, não uma janela de 86.400 segundos.
 *
 * ── e o que vem PELA FRENTE nunca vence ─────────────────────────────────────────────────────
 * "Champions · quarta, 16:00" é informação útil. Sem esta metade, o widget sumiria justamente na
 * véspera da rodada, que é quando ela mais interessa. Mas ela tem LIMITE: a próxima rodada da
 * Champions, medida em 16/09, estava a 27 dias. Um card anunciando algo de daqui a um mês é tão
 * pouco útil quanto um resultado da semana passada, então o futuro também tem horizonte.
 *
 * ── por que num arquivo só ──────────────────────────────────────────────────────────────────
 * Porque a regra vale para TODO widget que lê o mundo lá fora — futebol, notícias, cotações,
 * loteria —, e uma regra escrita em quatro lugares diverge pelo segundo. Aqui ela tem dono.
 */

const DIA_MS = 24 * 60 * 60 * 1000;

/** O fuso de quem olha a tela. O servidor roda em UTC e isso não pode decidir que dia é hoje. */
const FUSO = 'America/Sao_Paulo';

/** O padrão: um dia. Cada widget pode declarar o seu quando o dado tiver ritmo próprio. */
const VALIDADE_PADRAO_MS = 1 * DIA_MS;

/**
 * ATÉ ONDE O FUTURO AINDA É NOTÍCIA — sete dias.
 *
 * Dentro de uma semana, "a rodada é quarta" orienta quem passa. Além disso vira agenda, e agenda
 * não é o que uma parede de loja serve. Medido em 16/09: a Champions estava a 27 dias da próxima
 * rodada, e é exatamente o caso que este limite manda sair de cena.
 */
const HORIZONTE_FUTURO_MS = 7 * DIA_MS;

/**
 * O QUE PODE SER CHAMADO DE "AO VIVO" — quinze minutos.
 *
 * O servidor busca placar a cada cinco. Quinze é folgado o bastante para não piscar entre duas
 * buscas normais, e curto o bastante para nunca cobrir um jogo que terminou. Passado isso o
 * placar continua na tela; o que sai é a AFIRMAÇÃO de tempo real.
 */
const AO_VIVO_MAXIMO_MS = 15 * 60 * 1000;

/**
 * O DIA (`AAAA-MM-DD`) de um valor, no fuso de quem olha a tela — ou `null`.
 *
 * Duas armadilhas, e caí nas duas:
 *
 *   `new Date(null)` é 1º de janeiro de 1970 — uma data VÁLIDA. Sem a guarda de vazio na
 *   frente, "sem data" virava "vencido há cinquenta e seis anos", que por acaso dá a resposta
 *   certa pelo motivo errado, até o dia em que não desse.
 *
 *   Data só-dia se lê AOS PEDAÇOS, sem fuso: `new Date('2026-09-16')` é meia-noite em UTC, que
 *   no Brasil ainda é dia 15. Instante com hora, esse sim, se formata em São Paulo.
 */
function diaDoValor(valor) {
  if (valor === null || valor === undefined || valor === '') return null;

  const soDia = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(valor));
  if (soDia) return soDia[0];

  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) return null;
  const [dd, mm, aaaa] = d.toLocaleDateString('pt-BR', { timeZone: FUSO }).split('/');
  return `${aaaa}-${mm}-${dd}`;
}

/** Quantos dias de calendário `dia` está à frente de `referencia`. Negativo é passado. */
function distanciaEmDias(dia, referencia) {
  const emUtc = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((emUtc(dia) - emUtc(referencia)) / DIA_MS);
}

/**
 * O ESTADO DE VALIDADE de um conteúdo, pelo dia de que ele fala.
 *
 *   'vigente'    hoje, ontem, ou dentro do prazo declarado
 *   'futuro'     ainda vai acontecer, e dentro do horizonte
 *   'vencido'    passou do prazo — não vai à parede
 *   'distante'   vai acontecer, mas longe demais para ser notícia
 *   'sem-data'   não dá para saber — e na dúvida a tela não afirma
 *
 * `agora` entra por parâmetro para a prova poder envelhecer um dado sem mexer no relógio da
 * máquina — um teste que depende da hora real só falha no dia em que alguém o roda tarde.
 */
function estadoDaValidade(valor, agora = Date.now(), prazoMs = VALIDADE_PADRAO_MS) {
  const dia = diaDoValor(valor);
  if (!dia) return 'sem-data';

  const hoje = diaDoValor(new Date(agora).toISOString());
  const adiante = distanciaEmDias(dia, hoje);

  if (adiante > Math.round(HORIZONTE_FUTURO_MS / DIA_MS)) return 'distante';
  if (adiante > 0) return 'futuro';
  return -adiante <= Math.max(0, Math.round(prazoMs / DIA_MS)) ? 'vigente' : 'vencido';
}

/** Vai à parede? Vigente e futuro sim; vencido, distante e sem data, não. */
function podeIrParaParede(valor, agora = Date.now(), prazoMs = VALIDADE_PADRAO_MS) {
  const e = estadoDaValidade(valor, agora, prazoMs);
  return e === 'vigente' || e === 'futuro';
}

/**
 * ESTE RETRATO AINDA PODE DIZER "AO VIVO"?
 *
 * Nada a ver com o prazo do conteúdo: aqui a pergunta é sobre a IDADE DA BUSCA, porque "ao vivo"
 * é uma afirmação sobre o agora. Sem carimbo de hora a resposta é NÃO — um retrato sem hora não
 * tem como provar que é recente, e na dúvida a tela não afirma.
 */
function podeDizerAoVivo(fetchedAt, agora = Date.now()) {
  if (!fetchedAt || !Number.isFinite(fetchedAt)) return false;
  const idade = agora - fetchedAt;
  return idade >= 0 && idade <= AO_VIVO_MAXIMO_MS;
}

module.exports = {
  DIA_MS,
  FUSO,
  VALIDADE_PADRAO_MS,
  HORIZONTE_FUTURO_MS,
  AO_VIVO_MAXIMO_MS,
  diaDoValor,
  distanciaEmDias,
  estadoDaValidade,
  podeIrParaParede,
  podeDizerAoVivo,
};
