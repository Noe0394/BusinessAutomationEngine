// Scénarios Jarvis avec un VRAI modèle IA (cascade llmFallbackEngine, clés du .env) mais un
// transport SIMULÉ (aucun message WhatsApp/Telegram réellement envoyé). Stockage dans un dossier temporaire.
//   node scripts/jarvis-live-scenarios.js
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-live-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;
process.env.SECRET_VAULT_KEY = 'live-test-vault-key';
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
process.env.AI_ENGINE_STORAGE_DIR = TMP;
// Aucune écriture vers le dépôt GitHub de données pendant un test.
for (const k of Object.keys(process.env)) if (k.startsWith('GITHUB_')) delete process.env[k];

const businessServices = require('../ai-engine/businessServices');
const autoResponder = require('../ai-engine/autoResponder');
const conversationState = require('../ai-engine/jarvis/conversationState');
const contactCrm = require('../ai-engine/contactCrm');

const T = 'live';
const sent = [];
const runtime = { sendMessageVerified: async (p) => { sent.push(p); return { status: 'SUCCESS', confirmationId: 'SIM-' + sent.length }; } };
let n = 0;
const results = [];

async function say(from, text, opts) {
  const before = sent.length;
  const out = await autoResponder.handleIncoming({ tenantId: T, channel: 'WHATSAPP', from, name: 'Client', text, messageId: 'l' + (++n) }, Object.assign({ runtime, debounceMs: 0, notify: async () => {} }, opts || {}));
  return { out, reply: sent.length > before ? sent[sent.length - 1].text : null };
}
const PROVIDER_ERROR = /enough credits|top.?up|complete a quest|rate.?limit|unauthorized|api key/i;
function verdict(name, ok, detail) { ok = ok && !PROVIDER_ERROR.test(String(detail || '')); results.push({ name, ok }); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '\n     ' + String(detail).replace(/\n/g, ' ').slice(0, 260) : ''}`); }

(async () => {
  await businessServices.create(T, { name: 'Formation Épicerie', type: 'formation', products: [{ name: 'Formation Épicerie et Bouillon', price: 8000 }], commercial: { currency: 'FCFA' } });
  await autoResponder.setSettings(T, { whatsapp: true });
  const SALES = /souhaitez[- ]vous|(?:voulez|veux|souhaites|souhaitez)[^?.!]*(?:inscrire|payer|acheter|commander)[^?]*\?|profiter de l'offre|inscrivez[- ]vous|je vous inscris/i;

  let r = await say('A1', 'Bonjour, combien coûte la formation ?');
  verdict('1. Question prix -> prix configuré (8000)', !!r.reply && /8\s?000/.test(r.reply), r.reply);

  r = await say('A1', 'Quelle est la date exacte de la prochaine session ?');
  verdict('2. Date absente -> aucune date inventée', !!r.reply && !/\b(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|\d{1,2}\s+(?:janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)|\d{1,2}\/\d{1,2})/i.test(r.reply), r.reply);

  r = await say('B1', 'Combien coûte la formation ?');
  r = await say('B1', 'Non merci, ça ne m\'intéresse pas.');
  verdict('3. Refus -> clôture sans relance ni prix', !!r.reply && !SALES.test(r.reply) && !/8\s?000/.test(r.reply), r.reply);
  const before = sent.length;
  await say('B1', 'J\'ai dit non.'); await say('B1', 'Merci');
  verdict('3b. Après refus : silence total', sent.length === before);
  verdict('3c. Opt-out enregistré', await contactCrm.isOptedOut(T, 'WHATSAPP', 'B1'));

  r = await say('C1', 'C\'est trop cher pour moi.');
  verdict('4. Objection prix -> pas de répétition mécanique du prix / pas de remise inventée', !!r.reply && !/\d+\s?%/.test(r.reply), r.reply);

  r = await say('D1', 'Je vais réfléchir.');
  verdict('5. Hésitation -> aucune relance de vente', !!r.reply && !SALES.test(r.reply) && (await conversationState.get(T, 'WHATSAPP', 'D1')).state === 'WAITING', r.reply);

  r = await say('E1', 'Je veux m\'inscrire mais demain.');
  const st = await conversationState.get(T, 'WHATSAPP', 'E1');
  verdict('6. Achat reporté -> mémorisé, pas de « voulez-vous vous inscrire »', !!r.reply && !SALES.test(r.reply) && st.state === 'WAITING' && !!st.memory.waiting, r.reply);

  const rec0 = sent.length;
  const res = await Promise.all(['Bonjour', 'Je voudrais', 'connaître le prix'].map((t) => say('F1', t, { debounceMs: 400 })));
  verdict('7. Trois messages rapides -> UNE seule réponse', sent.length - rec0 === 1, sent[sent.length - 1] && sent[sent.length - 1].text);

  r = await say('G1', 'Finalement, comment se passe l\'inscription ?');
  verdict('8. Changement de sujet -> répond à l\'inscription', !!r.reply, r.reply);

  r = await say('H1', 'Oui j\'ai compris, merci.');
  verdict('9. « Oui j\'ai compris, merci » -> ne recommence pas la présentation', !r.reply || (r.reply.length < 120 && !/8\s?000/.test(r.reply)), r.reply || '(aucune réponse)');

  const a = await say('I1', 'Ça fait trois fois que je demande le prix…');
  verdict('10. Client frustré par la répétition -> réponse directe avec le prix', !!a.reply && /8\s?000/.test(a.reply), a.reply);

  const x = await say('J1', 'Vous faites la formation en ligne ?');
  const y = await say('J1', 'Vous faites la formation en ligne ?');
  const z = await say('J1', 'Vous faites la formation en ligne ?');
  verdict('11. Même question 3 fois -> réponses toutes différentes', !!x.reply && !!y.reply && x.reply !== y.reply && (!z.reply || (z.reply !== y.reply && z.reply !== x.reply)), [x.reply, y.reply, z.reply].join(' || '));

  const ok = results.filter((r2) => r2.ok).length;
  console.log(`\n${ok}/${results.length} scénarios conformes (modèle réel, transport simulé)`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(ok === results.length ? 0 : 2);
})().catch((e) => { console.error('ERREUR', e.message); process.exit(1); });
