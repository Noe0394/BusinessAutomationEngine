// TEST — OCR RÉEL (tesseract.js, données embarquées) sur une vraie image PNG générée avec des numéros.
//   node --test test/ocr-real.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const ocr = require('../ai-engine/ocrProvider');
const pipeline = require('../ai-engine/contactsPipeline');

function renderPng(lines) {
  const { Resvg } = require('@resvg/resvg-js');
  const fontFile = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
  const rows = lines.map((l, i) => `<text x="30" y="${70 + i * 60}" font-family="DejaVu Sans" font-size="38" fill="black">${l}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="820" height="${120 + lines.length * 60}"><rect width="100%" height="100%" fill="white"/>${rows}</svg>`;
  return new Resvg(svg, { font: { fontFiles: [fontFile], loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' }, fitTo: { mode: 'width', value: 1200 } }).render().asPng();
}

test('moteur OCR disponible et données de langue embarquées', () => {
  assert.equal(ocr.available(), true);
});

test('OCR réel : une photo de liste donne des numéros exploitables par le pipeline', { timeout: 90000 }, async (t) => {
  const png = renderPng(['Awa : +226 70 12 34 56', 'Koffi : +226 76 00 11 22', 'Marie : +226 50 12 34 56']);
  const res = await ocr.recognize(png);
  t.diagnostic('texte OCR : ' + res.text.replace(/\n/g, ' | '));
  const { rows, counts } = pipeline.classify(pipeline.extractPhoneNumbers(res.text).join('\n'), { defaultCountryCode: '226' });
  assert.ok(counts.valid >= 2, `au moins 2 numéros valides lus (obtenu ${counts.valid})`);
  const found = new Set(rows.filter((r) => r.state === 'valid').map((r) => r.number));
  const expected = ['22670123456', '22676001122', '22650123456'];
  assert.ok(expected.filter((n) => found.has(n)).length >= 2, `numéros attendus retrouvés : ${[...found].join(',')}`);
  await ocr.terminate();
});
