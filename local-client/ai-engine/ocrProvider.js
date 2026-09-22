// OCR déterministe (aucune IA générative) : tesseract.js avec les données de langue embarquées
// (@tesseract.js-data/eng) — aucun téléchargement au moment de l'usage. Si le moteur est absent, échoue
// HONNÊTEMENT (code OCR_ENGINE_MISSING) au lieu d'inventer un résultat.
const path = require('path');

let workerPromise = null;

function available() {
  try { require.resolve('tesseract.js'); return true; } catch (e) { return false; }
}

function langPath() {
  try {
    const pkgDir = path.dirname(require.resolve('@tesseract.js-data/eng/package.json'));
    return path.join(pkgDir, '4.0.0_best_int');
  } catch (e) { return null; }
}

function getWorker() {
  if (!workerPromise) {
    const { createWorker } = require('tesseract.js');
    const lp = langPath();
    workerPromise = createWorker('eng', 1, lp ? { langPath: lp, gzip: true } : {}).catch((err) => { workerPromise = null; throw err; });
  }
  return workerPromise;
}

async function recognize(buffer) {
  if (!available()) {
    const e = new Error('Moteur OCR absent : installer le paquet tesseract.js (npm install tesseract.js).');
    e.code = 'OCR_ENGINE_MISSING';
    throw e;
  }
  let data;
  try {
    const worker = await getWorker();
    ({ data } = await worker.recognize(buffer));
  } catch (err) {
    const e = new Error(`Échec de l'OCR : ${err.message}`);
    e.code = 'OCR_FAILED';
    throw e;
  }
  // words[].confidence (0-100) : seules les valeurs réellement incertaines sont signalées par l'appelant
  const words = [];
  for (const block of data.blocks || []) for (const para of block.paragraphs || []) for (const line of para.lines || []) for (const w of line.words || []) words.push({ text: w.text, confidence: w.confidence });
  return { text: data.text || '', words: words.length ? words : (data.words || []).map((w) => ({ text: w.text, confidence: w.confidence })) };
}

async function terminate() {
  if (!workerPromise) return;
  const w = await workerPromise.catch(() => null);
  workerPromise = null;
  if (w) await w.terminate();
}

module.exports = { recognize, available, terminate };
