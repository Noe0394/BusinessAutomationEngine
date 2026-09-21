// TEST — AI Gateway : routage par capacités, chaîne Gemini (Gemma 4 → Gemma 4 → Flash) puis fournisseurs externes,
// retry uniquement sur erreurs récupérables, confidentialité des erreurs, redaction des secrets, aucun Gemini Pro automatique.
//   node --test test/ai-gateway.test.js
// axios est simulé : aucun appel réseau, on vérifie QUEL modèle est appelé, dans QUEL ordre, avec QUEL contenu.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.AI_ENGINE_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-gw-'));
process.env.AI_RETRY_BASE_MS = '0'; // pas d'attente réelle entre deux tentatives
const axios = require('axios');
const llm = require('../lib/ai/llmFallbackEngine');
const aiErrors = require('../lib/ai/aiErrors');

const KEYS = ['GROQ_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'HUGGINGFACE_API_KEY', 'OPENAI_API_KEY', 'MISTRAL_API_KEY', 'ANTHROPIC_API_KEY'];
function withKeys(keys) { for (const k of KEYS) delete process.env[k]; for (const k of keys) process.env[k] = 'test-' + k; llm._resetHealth(); }
const gem = (t, thought) => ({ data: { candidates: [{ content: { parts: (thought ? [{ text: 'raisonnement interne', thought: true }] : []).concat([{ text: t }]) } }] } });
const oai = (t) => ({ data: { choices: [{ message: { content: t }, finish_reason: 'stop' }] } });
const httpErr = (status, message, headers) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data: { error: { message: message || 'x' } }, headers: headers || {} } });
function mockAxios(handler) {
  const calls = [];
  const orig = axios.post; const origGet = axios.get;
  axios.post = async (url, body, cfg) => { calls.push({ url: String(url), body, headers: cfg && cfg.headers, timeout: cfg && cfg.timeout }); return handler(String(url), body, calls.length); };
  // Repli public sans clé (Pollinations, GET) : jamais d'appel réseau réel dans les tests.
  axios.get = async () => { throw httpErr(400, 'repli public simulé indisponible'); };
  return { calls, restore: () => { axios.post = orig; axios.get = origGet; } };
}
const model = (url) => (String(url).match(/models\/([^:]+):/) || [])[1];

test('ordre de priorité : Gemma 4 31B IT en premier, la clé Gemini passe en EN-TÊTE (jamais dans l\'URL)', async () => {
  withKeys(['GEMINI_API_KEY', 'GROQ_API_KEY']);
  const m = mockAxios(() => gem('bonjour'));
  try {
    const r = await llm.generateAIResponse('Salut', [], null);
    assert.equal(r.text, 'bonjour');
    assert.equal(r.provider, 'gemini-primary');
    assert.equal(model(m.calls[0].url), 'gemma-4-31b-it');
    assert.ok(!/key=/.test(m.calls[0].url), 'aucun secret dans l\'URL');
    assert.equal(m.calls[0].headers['x-goog-api-key'], 'test-GEMINI_API_KEY');
  } finally { m.restore(); }
});

test('chaîne interne : Gemma 31B indisponible → autre Gemma 4 → Gemini Flash → Groq → OpenRouter → Hugging Face', async () => {
  withKeys(['GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'HUGGINGFACE_API_KEY']);
  const seen = [];
  const m = mockAxios((url) => {
    const id = /generativelanguage/.test(url) ? model(url) : (/groq/.test(url) ? 'groq' : (/openrouter/.test(url) ? 'openrouter' : 'hf'));
    if (!seen.includes(id)) seen.push(id);
    if (id === 'hf') return oai('réponse HF');
    throw httpErr(400, 'refus définitif de ' + id); // erreur définitive : aucun retry, on passe au suivant
  });
  try {
    const r = await llm.generateAIResponse('Salut', [], null);
    assert.equal(r.text, 'réponse HF');
    assert.deepEqual(seen, ['gemma-4-31b-it', 'gemma-4-26b-a4b-it', 'gemini-flash-latest', 'groq', 'openrouter', 'hf']);
  } finally { m.restore(); }
});

test('Gemini PRO n\'est jamais utilisé automatiquement (ni au niveau standard, ni au raisonnement)', async () => {
  withKeys(['GEMINI_API_KEY']);
  process.env.GEMINI_PRO_MODEL = 'gemini-pro-latest';
  const m = mockAxios(() => { throw httpErr(400, 'refus'); });
  try {
    for (const tier of ['standard', 'reasoning']) {
      await assert.rejects(() => llm.generateAIResponse('Décision', [], null, undefined, null, { tier }));
    }
    assert.ok(m.calls.length >= 6);
    assert.ok(m.calls.every((c) => !/pro/i.test(model(c.url))), 'aucun appel à un modèle Pro : ' + m.calls.map((c) => model(c.url)).join(','));
  } finally { m.restore(); delete process.env.GEMINI_PRO_MODEL; }
});

test('les « pensées » internes de Gemma ne sont jamais renvoyées (parties thought filtrées)', async () => {
  withKeys(['GEMINI_API_KEY']);
  const m = mockAxios(() => gem('Voici la vraie réponse', true));
  try {
    const r = await llm.generateAIResponse('Salut', [], null);
    assert.equal(r.text, 'Voici la vraie réponse');
    assert.ok(!/raisonnement interne/.test(r.text));
  } finally { m.restore(); }
});

test('CAPACITÉS — audio : Gemma 4 n\'est jamais appelé (modalité refusée), seul Gemini Flash reçoit l\'audio', async () => {
  withKeys(['GEMINI_API_KEY', 'GROQ_API_KEY']);
  const m = mockAxios((url) => gem('transcription'));
  try {
    const r = await llm.generateAIResponse('Transcris', [], null, undefined, null, { media: [{ mimeType: 'audio/ogg; codecs=opus', data: Buffer.from('audio') }] });
    assert.equal(r.provider, 'gemini-flash');
    assert.equal(m.calls.length, 1);
    assert.equal(model(m.calls[0].url), 'gemini-flash-latest');
    const part = m.calls[0].body.contents[0].parts.find((p) => p.inlineData);
    assert.equal(part.inlineData.mimeType, 'audio/ogg');
  } finally { m.restore(); }
});

test('CAPACITÉS — image : les modèles texte seul (Groq, Hugging Face, DeepSeek) ne sont JAMAIS choisis', async () => {
  withKeys(['GROQ_API_KEY', 'HUGGINGFACE_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY']);
  const urls = [];
  const m = mockAxios((url) => { urls.push(url); throw httpErr(400, 'refus'); });
  try {
    await assert.rejects(() => llm.generateAIResponse('Décris', [], null, undefined, null, { media: [{ mimeType: 'image/png', data: Buffer.from('x') }] }));
    assert.ok(urls.every((u) => /generativelanguage/.test(u)), 'seuls les modèles multimodaux : ' + urls.join(' | '));
  } finally { m.restore(); }
});

test('CAPACITÉS — aucun modèle configuré capable : erreur générique, aucun appel réseau', async () => {
  withKeys(['GROQ_API_KEY']); // texte seul
  const m = mockAxios(() => oai('x'));
  try {
    await assert.rejects(() => llm.generateAIResponse('Analyse', [], null, undefined, null, { media: [{ mimeType: 'video/mp4', data: Buffer.from('v') }] }),
      (e) => { assert.equal(e.message, aiErrors.GENERIC_USER_MESSAGE); assert.equal(e.reason, 'NO_CAPABLE_MODEL'); return true; });
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }
});

test('image jointe : envoyée en données intégrées à Gemini, en image_url à OpenRouter', async () => {
  withKeys(['OPENROUTER_API_KEY']);
  const m = mockAxios(() => oai('vu'));
  try {
    const r = await llm.generateAIResponse('Décris', [], null, undefined, null, { media: [{ mimeType: 'image/jpeg', data: Buffer.from('jpg') }] });
    assert.equal(r.provider, 'openrouter');
    const content = m.calls[0].body.messages[1].content;
    assert.ok(Array.isArray(content));
    assert.equal(content[1].type, 'image_url');
    assert.match(content[1].image_url.url, /^data:image\/jpeg;base64,/);
  } finally { m.restore(); }
});

test('RETRY : une erreur récupérable (503) est ré-essayée UNE fois sur le même modèle, puis succès', async () => {
  withKeys(['GEMINI_API_KEY']);
  let n = 0;
  const m = mockAxios(() => { n += 1; if (n === 1) throw httpErr(503, 'high demand'); return gem('ok après retry'); });
  try {
    const r = await llm.generateAIResponse('Salut', [], null);
    assert.equal(r.text, 'ok après retry');
    assert.equal(r.provider, 'gemini-primary');
    assert.equal(m.calls.length, 2);
    assert.equal(model(m.calls[0].url), model(m.calls[1].url));
  } finally { m.restore(); }
});

test('RETRY : erreur définitive (400/401/403/404) et timeout → AUCUN ré-essai, passage direct au suivant', async () => {
  for (const make of [() => httpErr(400, 'bad'), () => httpErr(401, 'clé invalide'), () => httpErr(403, 'interdit'), () => httpErr(404, 'modèle absent'), () => Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' }), () => httpErr(429, 'quota exceeded per day')]) {
    withKeys(['GEMINI_API_KEY']);
    const m = mockAxios(() => { throw make(); });
    try {
      await assert.rejects(() => llm.generateAIResponse('Salut', [], null));
      assert.equal(m.calls.length, 3, 'un seul essai par modèle (3 modèles Gemini), jamais de boucle : ' + m.calls.length);
    } finally { m.restore(); }
  }
});

test('RETRY : limite de débit passagère (429 sans quota) ré-essayée une fois ; jamais plus', async () => {
  withKeys(['GEMINI_API_KEY']);
  const m = mockAxios(() => { throw httpErr(429, 'Too many requests'); });
  try {
    await assert.rejects(() => llm.generateAIResponse('Salut', [], null));
    assert.equal(m.calls.length, 6, '2 tentatives × 3 modèles Gemini');
  } finally { m.restore(); }
});

test('DISJONCTEUR : un modèle en échec répété est mis de côté (pas d\'attente inutile au message suivant)', async () => {
  withKeys(['GEMINI_API_KEY']);
  const m = mockAxios((url) => { if (model(url) === 'gemma-4-31b-it') throw Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' }); return gem('via Gemma 26B'); });
  try {
    await llm.generateAIResponse('1', [], null); await llm.generateAIResponse('2', [], null); // 2 échecs du primaire
    m.calls.length = 0;
    const r = await llm.generateAIResponse('3', [], null);
    assert.equal(r.text, 'via Gemma 26B');
    assert.equal(m.calls.length, 1, 'le primaire est écarté temporairement');
    assert.equal(model(m.calls[0].url), 'gemma-4-26b-a4b-it');
  } finally { m.restore(); }
});

test('CONFIDENTIALITÉ : échec total → message générique SEUL (aucun modèle, fournisseur, code HTTP, quota, clé, ordre de secours)', async () => {
  withKeys(KEYS);
  const m = mockAxios((url) => { throw httpErr(429, 'Quota exceeded for gemma-4-31b-it, key=AIzaSyDUMMYDUMMYDUMMYDUMMYDUMMY12345 https://x'); });
  const warn = console.warn; const err = console.error; const logs = [];
  console.warn = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push(a.join(' '));
  try {
    await assert.rejects(() => llm.generateAIResponse('Salut', [], null), (e) => {
      assert.equal(e.message, 'Je rencontre momentanément un problème pour traiter votre demande. Veuillez réessayer un peu plus tard.');
      assert.equal(aiErrors.safeUserMessage(e), e.message);
      const visible = `${e.message} ${e.name}`;
      assert.ok(!/gemma|gemini|groq|openrouter|huggingface|claude|openai|mistral|deepseek|HTTP|429|quota|API|key|token/i.test(visible), 'fuite : ' + visible);
      assert.match(e.internalDetail, /gemini-primary/); // le détail existe, mais réservé aux logs
      return true;
    });
    const all = logs.join('\n');
    assert.ok(!/AIzaSy/.test(all), 'la clé ne doit pas apparaître dans les logs');
    assert.match(all, /REDACTED|quota/);
  } finally { m.restore(); console.warn = warn; console.error = err; }
});

test('safeUserMessage : une erreur INTERNE quelconque n\'expose jamais son message', () => {
  assert.equal(aiErrors.safeUserMessage(new Error('ECONNRESET api.groq.com key=abc')), aiErrors.GENERIC_USER_MESSAGE);
  assert.equal(aiErrors.safeUserMessage(null), aiErrors.GENERIC_USER_MESSAGE);
});

test('redaction : clés Google (AIza…, AQ.…), Groq, OpenAI, Hugging Face, Bearer, en-têtes et paramètres d\'URL', () => {
  const dirty = 'k1=AIzaSyABCDEFGHIJKLMNOPQRSTUV k2=AQ.FakeFakeFakeFakeFakeFakeFake1234 gsk_abcdefghijklmnop1234 sk-abcdefghijklmnopqrstu hf_abcdefghijklmnopqrst Authorization: Bearer abcdef1234567890xyz ?key=SECRETVALUE99 x-api-key: 12345678abcdef';
  const clean = aiErrors.redact(dirty);
  for (const s of ['AIzaSyABCDEF', 'AQ.FakeFake', 'gsk_abcdef', 'sk-abcdef', 'hf_abcdef', 'abcdef1234567890xyz', 'SECRETVALUE99', '12345678abcdef']) assert.ok(!clean.includes(s), `${s} non masqué : ${clean}`);
});

test('état des connexions : ordre par niveau, capacités déclarées, modèles forts manquants signalés', () => {
  withKeys(['GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'HUGGINGFACE_API_KEY']);
  const s = llm.getProviderStatus();
  assert.deepEqual(s.standard, ['gemini-primary', 'gemini-secondary', 'gemini-flash', 'groq', 'openrouter', 'huggingface', 'pollinations']);
  assert.deepEqual(s.reasoning.slice(0, 4), ['gemini-primary', 'gemini-secondary', 'gemini-flash', 'groq']);
  assert.deepEqual(s.capabilities['gemini-flash'].sort(), ['audio', 'complex', 'document', 'image', 'search', 'text', 'tools', 'video']);
  assert.ok(!s.capabilities['gemini-primary'].includes('audio'));
  assert.ok(!s.capabilities.groq.includes('image'));
  assert.deepEqual(s.missingStrongModels, ['claude', 'openai']);
});

test('le Chat intelligent ne dépend d\'aucun nom de modèle : aucun module métier ne cite un modèle Gemini/Gemma', () => {
  const root = path.join(__dirname, '..');
  const offenders = [];
  for (const dir of ['ai-engine', 'lib/intelligence']) {
    for (const f of fs.readdirSync(path.join(root, dir), { recursive: true })) {
      if (!/\.js$/.test(f)) continue;
      const src = fs.readFileSync(path.join(root, dir, f), 'utf8');
      if (/gemma-4|gemini-(flash|pro|[0-9])|generativelanguage\.googleapis/i.test(src)) offenders.push(`${dir}/${f}`);
    }
  }
  // voiceProcessor garde son transcripteur Gemini historique dédié à l'audio : listé ici pour ne pas l'oublier.
  // aiUsageLedger : simple table de coûts/étiquettes de journal (aucune décision de routage).
  assert.deepEqual(offenders.filter((f) => !/aiUsageLedger/.test(f)), [], 'noms de modèle hors du gateway : ' + offenders.join(', '));
});

test.after(() => { try { fs.rmSync(process.env.AI_ENGINE_STORAGE_DIR, { recursive: true, force: true }); } catch (e) { /* nettoyage */ } });
