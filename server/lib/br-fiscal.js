'use strict';

/*
 * CPF, CNPJ AND CEP — checked here, before they reach anybody else.
 *
 * WHY THIS EXISTS. These numbers travel to Asaas, and from Asaas onto a nota fiscal. A CNPJ with a
 * transposed digit is accepted by every text field it passes through and fails at the far end,
 * weeks later, as a rejected emission with a message from a municipal web service — at which point
 * the customer has paid, the invoice is settled, and the one person who could correct the number is
 * the one who typed it wrong and has long since closed the page.
 *
 * Both numbers carry their own check digits precisely so a typo can be caught at the keyboard. This
 * does that, offline, with no dependency and no network call.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: say whether the company EXISTS. A structurally valid CNPJ can
 * belong to nobody. Only Receita Federal can answer that, and the honest boundary is to reject what
 * is provably wrong and pass through what merely might be right.
 */

/* Digits only. Everything here works on the bare number; punctuation is presentation. */
const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');

/*
 * The shared check-digit algorithm. Both documents are a weighted sum mod 11, differing only in
 * the weights, so writing it twice would mean maintaining the same arithmetic in two places.
 */
function checkDigit(nums, weights) {
  const sum = weights.reduce((acc, w, i) => acc + nums[i] * w, 0);
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

function isValidCPF(value) {
  const d = digits(value);
  if (d.length !== 11) return false;
  // 111.111.111-11 and friends satisfy the arithmetic and are not real. Excluded explicitly,
  // because they are exactly what gets typed into a required field somebody wants past.
  if (/^(\d)\1{10}$/.test(d)) return false;

  const n = d.split('').map(Number);
  const first = checkDigit(n, [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (first !== n[9]) return false;
  const second = checkDigit(n, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return second === n[10];
}

function isValidCNPJ(value) {
  const d = digits(value);
  if (d.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(d)) return false;

  const n = d.split('').map(Number);
  const first = checkDigit(n, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (first !== n[12]) return false;
  const second = checkDigit(n, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return second === n[13];
}

/* Either document, by length. What a "CPF/CNPJ" field actually has to accept. */
function isValidTaxId(value) {
  const d = digits(value);
  if (d.length === 11) return isValidCPF(d);
  if (d.length === 14) return isValidCNPJ(d);
  return false;
}

/* 'pessoa_fisica' | 'pessoa_juridica' | null — which of the two this is, if it is either. */
function taxIdKind(value) {
  const d = digits(value);
  if (d.length === 11 && isValidCPF(d)) return 'pessoa_fisica';
  if (d.length === 14 && isValidCNPJ(d)) return 'pessoa_juridica';
  return null;
}

/*
 * A CEP is eight digits and nothing else. There is no check digit to verify against, so this is a
 * shape check: it catches the missing digit and the phone number in the wrong field, and cannot
 * catch a real CEP for the wrong street.
 */
function isValidCEP(value) {
  return /^\d{8}$/.test(digits(value));
}

/* As a person reads them back. Formatting is for display; storage stays bare digits. */
function formatTaxId(value) {
  const d = digits(value);
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return d;
}

function formatCEP(value) {
  const d = digits(value);
  return d.length === 8 ? d.replace(/(\d{5})(\d{3})/, '$1-$2') : d;
}

module.exports = {
  digits, isValidCPF, isValidCNPJ, isValidTaxId, taxIdKind, isValidCEP, formatTaxId, formatCEP,
};
