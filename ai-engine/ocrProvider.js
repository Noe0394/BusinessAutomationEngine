// OCR déterministe (aucune IA générative). Utilise tesseract.js s'il est installé ; sinon échoue HONNÊTEMENT
// (code OCR_ENGINE_MISSING) au lieu d'inventer un résultat.
let engine = null;
function available() { try { require.resolve('tesseract.js'); return true; } catch (e) { return false; } }

async function recognize(buffer, opts) {
  if (!available()) {
    const e = new Error('Moteur OCR absent : installer le paquet tesseract.js (npm install tesseract.js).');
    e.code = 'OCR_ENGINE_MISSING';
    throw e;
  }
  const { createWorker } = require('tesseract.js');
  if (!engine) engine = await createWorker((opts && opts.lang) || 'eng');
  const { data } = await engine.recognize(buffer);
  // words[].confidence (0-100) permet de signaler uniquement les valeurs réellement incertaines
  return { text: data.text || '', words: (data.words || []).map((w) => ({ text: w.text, confidence: w.confidence })) };
}

module.exports = { recognize, available };
