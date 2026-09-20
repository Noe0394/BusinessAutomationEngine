// TEST RUNNER — normalisation des numéros importés (format international sans « + », comme le produit Excel).
//   node --test test/contacts-normalization.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const p = require('../ai-engine/contactsPipeline');
const st = (n, o) => p.classify([{ phone: n }], o || {}).rows[0];

test('international SANS « + » (Excel, JID) : accepté ; local ambigu : jamais deviné', () => {
  for (const n of ['22670123456', '2250700112233', '237699112233', '221771234567', '33612345678', '+22670123458', '0022670123457']) assert.equal(st(n).state, 'valid', n);
  for (const n of ['70123459', '0701234567', '2126612345', '3312345678', '123']) assert.equal(st(n).state, 'uncertain', n);
  assert.equal(st('abc').state, 'invalid');
});
test('avec indicatif par défaut : les numéros locaux deviennent valides', () => {
  assert.equal(st('70123459', { defaultCountryCode: '226' }).number, '22670123459');
  assert.equal(st('070123459', { defaultCountryCode: '226' }).number, '22670123459');
});
test('un nombre Excel brut (sans guillemets) est bien lu', () => {
  assert.equal(p.classify([{ phone: 22670123456 }], {}).rows[0].state, 'valid');
});
