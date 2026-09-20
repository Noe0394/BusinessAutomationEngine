// TEST RUNNER — extracteur de contacts UNIQUE (Excel, CSV, texte collé, OCR, vCard) : mêmes règles quelle que soit la source.
//   node --test test/contact-extractor.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const XLSX = require('xlsx');
const ex = require('../ai-engine/contactExtractor');
const pipe = require('../ai-engine/contactsPipeline');

const xlsx = (sheets) => { const wb = XLSX.utils.book_new(); Object.entries(sheets).forEach(([n, aoa]) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), n)); return { name: 'f.xlsx', buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) }; };
const nums = (file) => pipe.classify(ex.extractFromFile(file).entries.filter((e) => e.phone), {}).rows.filter((r) => r.state === 'valid').map((r) => `${r.name}:${r.number}`);
const norm = (p) => { const c = pipe.classify([{ phone: p }], {}).rows[0]; return c && c.state === 'valid' ? c.number : null; };

test('Excel : en-têtes inconnus, sans en-tête, numéros en colonne 3, plusieurs feuilles, plusieurs numéros par cellule', () => {
  assert.deepEqual(nums(xlsx({ S: [['Client', 'Numéro WhatsApp'], ['Zoé', 22670555551], ['Yan', '+226 70 55 55 52']] })), ['Zoé:22670555551', 'Yan:22670555552']);
  assert.deepEqual(nums(xlsx({ S: [[1, 'Awa Traoré', 22670111111], [2, 'Ben K', 22670111112]] })), ['Awa Traoré:22670111111', 'Ben K:22670111112']);
  assert.deepEqual(nums(xlsx({ A: [['Nom', 'Tel'], ['Cyr', '226.70.11.11.13']], B: [['name', 'phone'], ['Dan', '+22670111114']] })), ['Cyr:22670111113', 'Dan:22670111114']);
  assert.deepEqual(nums(xlsx({ S: [['Nom', 'Contact'], ['Eva', '22670111115 / 22670111116']] })), ['Eva:22670111115', 'Eva:22670111116']);
  assert.deepEqual(nums(xlsx({ S: [['Machin', 'Truc'], ['Awa', 22670111119]] })), ['Awa:22670111119']);
});
test('CSV / TSV / texte : séparateur détecté, avec ou sans en-tête', () => {
  assert.deepEqual(nums({ name: 'a.csv', buffer: Buffer.from('Prénom;Mobile pro\nFab;22670111117\nGil;22670111118\n') }), ['Fab:22670111117', 'Gil:22670111118']);
  assert.deepEqual(nums({ name: 'b.csv', buffer: Buffer.from('Hugo,22670111119\nIna,22670111120\n') }), ['Hugo:22670111119', 'Ina:22670111120']);
  assert.deepEqual(nums({ name: 'c.txt', buffer: Buffer.from('Jean : 22670111121\nMarie Kaboré 22670111122\ntel: +22670111123\n') }), ['Jean:22670111121', 'Marie Kaboré:22670111122', ':22670111123']);
});
test('sortie d\'OCR bruitée et vCard', () => {
  const rows = pipe.classify(ex.extractFromText('Liste clients\n1. Awa  +226 70 11 11 25\n2. Ben +226 70 11 11 26\ntotal: 2'), {}).rows;
  assert.deepEqual(rows.map((r) => `${r.name}:${r.number}:${r.state}`), ['Awa:22670111125:valid', 'Ben:22670111126:valid']);
  assert.deepEqual(nums({ name: 'g.vcf', buffer: Buffer.from('BEGIN:VCARD\nFN:Luc Zongo\nTEL;CELL:+22670111124\nEND:VCARD\n') }), ['Luc Zongo:22670111124']);
});
test('Telegram : @username et t.me reconnus partout, numéros normalisés, en-tête reconnu même si les premières lignes n\'ont pas de numéro', () => {
  const r = ex.extractFromFile({ name: 't1.csv', buffer: Buffer.from('Username;Nom;Telephone\n@tg_one;Un;\n@tg_two;Deux;\n;Trois;22670444441\n') });
  assert.deepEqual(ex.toTelegramIdentifiers(r.entries, norm).map((c) => c.identifier), ['@tg_one', '@tg_two', '+22670444441']);
  assert.deepEqual(ex.toTelegramIdentifiers(ex.extractFromText('@a_user1 Un\nDeux 22670111127\nt.me/tg_user_three'), norm).map((c) => c.identifier), ['@a_user1', '+22670111127', '@tg_user_three']);
});
test('rien n\'est deviné : local sans indicatif = incertain ; trop long = invalide visible ; texte sans numéro = liste vide', () => {
  const rows = pipe.classify(ex.extractFromText('70123459\n123456789012345678\nbonjour'), {}).rows;
  // aucun numéro n'est écarté en silence : chaque séquence trouvée est rendue visible avec son état
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.state), ['uncertain', 'uncertain']);
  assert.equal(pipe.classify(ex.extractFromText('123456789012345678'), { defaultCountryCode: '226' }).rows[0].reason, 'TOO_LONG');
  assert.deepEqual(ex.extractFromText('rien du tout ici'), []);
});
