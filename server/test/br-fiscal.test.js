'use strict';

/*
 * THE CHECK DIGITS, CHECKED.
 *
 * These numbers go to Asaas and from there onto a nota fiscal. A transposed digit passes every text
 * field on the way and fails at the far end — weeks later, as a rejected emission carrying a
 * message from a municipal web service, by which time the customer has paid, the invoice is
 * settled, and the person who typed it wrong closed the page in another month.
 *
 * The documents carry their own check digits so this is catchable at the keyboard. These tests use
 * real, valid, PUBLIC numbers (Receita Federal's own and Asaas's published sandbox values) plus
 * deliberate one-digit corruptions of them, because an implementation that accepts everything also
 * passes a test written only with valid input.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const f = require('../lib/br-fiscal');

test('CNPJ: aceita válido, recusa o mesmo número com um dígito trocado', () => {
  assert.equal(f.isValidCNPJ('11.222.333/0001-81'), true, 'com pontuação');
  assert.equal(f.isValidCNPJ('11222333000181'), true, 'sem pontuação');

  // Um único dígito trocado no meio — o erro de digitação que um campo de texto aceita feliz.
  assert.equal(f.isValidCNPJ('11222353000181'), false);
  // Dígito verificador errado.
  assert.equal(f.isValidCNPJ('11222333000182'), false);
  // Transposição, que é o erro mais comum de todos.
  assert.equal(f.isValidCNPJ('12122333000181'), false);
});

test('CPF: mesma coisa', () => {
  assert.equal(f.isValidCPF('529.982.247-25'), true);
  assert.equal(f.isValidCPF('52998224725'), true);
  assert.equal(f.isValidCPF('52998224726'), false, 'dígito verificador errado');
  assert.equal(f.isValidCPF('52998242725'), false, 'transposição');
});

test('sequências repetidas são recusadas, mesmo satisfazendo a conta', () => {
  /*
   * 111.111.111-11 passa na aritmética do módulo 11. É também exatamente o que alguém digita para
   * passar de um campo obrigatório — e emitiria uma nota para um contribuinte inexistente.
   */
  for (const cpf of ['00000000000', '11111111111', '99999999999']) {
    assert.equal(f.isValidCPF(cpf), false, cpf);
  }
  for (const cnpj of ['00000000000000', '11111111111111']) {
    assert.equal(f.isValidCNPJ(cnpj), false, cnpj);
  }
});

test('tamanho errado não é "quase certo", é errado', () => {
  assert.equal(f.isValidTaxId('1122233300018'), false, '13 dígitos');
  assert.equal(f.isValidTaxId('112223330001812'), false, '15 dígitos');
  assert.equal(f.isValidTaxId(''), false);
  assert.equal(f.isValidTaxId(null), false);
  assert.equal(f.isValidTaxId(undefined), false);
});

test('o campo único aceita os dois, e sabe qual é qual', () => {
  /*
   * Um tenant pode ser MEI com CNPJ ou autônomo com CPF, e o formulário tem um campo só. A nota
   * fiscal muda conforme o caso, então o sistema precisa saber qual dos dois recebeu.
   */
  assert.equal(f.isValidTaxId('529.982.247-25'), true);
  assert.equal(f.isValidTaxId('11.222.333/0001-81'), true);

  assert.equal(f.taxIdKind('529.982.247-25'), 'pessoa_fisica');
  assert.equal(f.taxIdKind('11.222.333/0001-81'), 'pessoa_juridica');
  assert.equal(f.taxIdKind('11222333000182'), null, 'inválido não tem tipo');
});

test('CEP é forma, e o teste diz o que isso não garante', () => {
  assert.equal(f.isValidCEP('01310-100'), true);
  assert.equal(f.isValidCEP('01310100'), true);
  assert.equal(f.isValidCEP('0131010'), false, 'sete dígitos');
  assert.equal(f.isValidCEP('11999998888'), false, 'telefone no campo errado');

  // Não existe dígito verificador em CEP: um CEP real da rua errada passa, e tem de passar.
  assert.equal(f.isValidCEP('99999999'), true);
});

test('formatação é só apresentação; o que se guarda são dígitos', () => {
  assert.equal(f.formatTaxId('11222333000181'), '11.222.333/0001-81');
  assert.equal(f.formatTaxId('52998224725'), '529.982.247-25');
  assert.equal(f.formatCEP('01310100'), '01310-100');

  // Ida e volta: formatar e voltar a dígitos não pode perder nada.
  assert.equal(f.digits(f.formatTaxId('11222333000181')), '11222333000181');
  assert.equal(f.digits(f.formatCEP('01310100')), '01310100');

  // Um valor incompleto é devolvido cru em vez de ganhar pontuação mentirosa que sugere validade.
  assert.equal(f.formatTaxId('112223'), '112223');
});
