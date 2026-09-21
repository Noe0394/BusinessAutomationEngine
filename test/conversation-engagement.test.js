// TEST — répondeur CONTEXTUEL : mémoire 7 jours, politique pilotable, décision d'engagement (naturel / business / présentation), groupes (mention, thème,
// échange entre membres, plafond), explication « pourquoi ? », vitesse. Aucun réseau : le modèle IA est simulé et le PROMPT est inspecté.
//   node --test test/conversation-engagement.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.AI_ENGINE_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-engage-'));
process.env.GITHUB_TOKEN = ''; process.env.AUTO_REPLY_DEBOUNCE_MS = '0'; process.env.GEMINI_API_KEY = 'test-key'; process.env.SPECIALISTS_ENABLED = 'false';
require('./helpers/auth').actAsAdmin();

const policy = require('../ai-engine/conversationPolicy');
const cctx = require('../ai-engine/conversationContext');
const engagement = require('../ai-engine/engagement');
const autoResponder = require('../ai-engine/autoResponder');
const businessServices = require('../ai-engine/businessServices');
const messageHistory = require('../ai-engine/messageHistory');
const conversationState = require('../ai-engine/jarvis/conversationState');
const toolRegistry = require('../ai-engine/toolRegistry');
const { ownerOf, authz } = require('./helpers/auth');

const MIN = 60 * 1000; let n = 0;
const tsAgo = (ms) => Math.floor((Date.now() - ms) / 1000);
async function hist(tenant, chatId, rows, opts) {
  const o = opts || {};
  for (const [dir, text, who, agoMs] of rows) {
    await messageHistory.record(tenant, { channel: 'WHATSAPP', direction: dir, party: chatId, chatId, name: who || null, text, ts: tsAgo(agoMs), isGroup: !!o.group, groupId: o.group ? chatId : undefined, groupName: o.group ? 'Grill Club' : undefined, senderId: dir === 'in' ? `${who || 'x'}@s.whatsapp.net` : undefined, senderName: dir === 'in' ? who : undefined, messageId: `h${++n}` });
  }
}
async function seed(T, opts) {
  const svc = await businessServices.create(T, { name: 'Formation Grillade', type: 'formation', products: [{ name: 'Cours de grillade', price: 5000 }], commercial: { price: 5000, description: 'apprendre la grillade de viande et les marinades', advantages: 'recettes pratiques grillade' } });
  if (opts && opts.linkGroup) await businessServices.update(T, svc.id, { groups: [{ channel: 'WHATSAPP', id: opts.linkGroup, name: 'Grill Club', verified: { admin: true } }] });
  return svc;
}
const prompts = []; const sent = [];
const llm = async (p) => { prompts.push(String(p)); return 'Réponse de test.'; };
const runtime = { sendMessageVerified: async (m) => { sent.push(m); return { status: 'SUCCESS', confirmationId: 'c' + sent.length }; } };
async function say(T, from, text, extra) {
  const before = sent.length; prompts.length = 0;
  const out = await autoResponder.handleIncoming(Object.assign({ tenantId: T, channel: 'WHATSAPP', from, name: 'Awa', text, messageId: 'm' + (++n) }, extra || {}), { runtime, llm, settings: Object.assign({ whatsapp: true }, (extra && extra.settings) || {}) });
  return { out, replied: sent.length > before, prompt: prompts[prompts.length - 1] || '' };
}

// ------------------------------------------------------------------ politique
test('POLITIQUE : valeurs validées, défauts simples, exceptions par discussion, lecture en français', async () => {
  const T = 'pol1';
  const d = await policy.get(T); assert.equal(d.private, 'auto'); assert.equal(d.group, 'topic'); assert.equal(d.presentServices, 'when-relevant');
  const p = await policy.set(T, { private: 'natural', group: 'nimporte', presentServices: 'never', override: { channel: 'WHATSAPP', id: '123@g.us', mode: 'addressed' } });
  assert.equal(p.private, 'natural'); assert.equal(p.group, 'topic', 'valeur inconnue ignorée'); assert.equal(p.presentServices, 'never');
  assert.equal(policy.resolveFor(p, 'WHATSAPP', '123@g.us', true).mode, 'addressed'); assert.equal(policy.resolveFor(p, 'WHATSAPP', '999@g.us', true).mode, 'topic');
  assert.ok(policy.describe(p).some((l) => /Exceptions/.test(l)));
  assert.equal((await policy.set(T, { override: { channel: 'WHATSAPP', id: '123@g.us', clear: true } })).overrides['WHATSAPP:123@g.us'], undefined);
  assert.equal(policy.fromSettings({ groupReplies: false }).group, 'addressed', 'ancien interrupteur respecté');
});

// ------------------------------------------------------------------ contexte 7 jours
test('CONTEXTE : thèmes, service concerné, température business et présentation récente tirés des 7 jours de mémoire', async () => {
  const T = 'ctx1'; await seed(T); const from = '22670010001@s.whatsapp.net';
  await hist(T, from, [['in', 'Bonjour, je veux apprendre la grillade de viande', 'Awa', 3 * 24 * 60 * MIN], ['out', 'Bonjour ! Notre Formation Grillade est à 5000 FCFA.', null, 3 * 24 * 60 * MIN - MIN], ['in', 'Et les marinades pour la grillade, vous les enseignez ?', 'Awa', 60 * MIN]]);
  const c = await cctx.analyze({ tenant: T, channel: 'WHATSAPP', from, isGroup: false, text: 'ok merci' });
  assert.ok(c.messages >= 3); assert.ok(c.themes.some((t) => t.term === 'grillade'));
  assert.equal(c.service.name, 'Formation Grillade'); assert.ok(c.service.affinity >= 0.5, `affinité ${c.service.affinity}`);
  assert.notEqual(c.business.temperature, 'cold');
  assert.equal(c.business.presentedRecently, false, 'présenté il y a 3 jours : pas récent (24 h)');
  const empty = await cctx.analyze({ tenant: T, channel: 'WHATSAPP', from: '22670099999@s.whatsapp.net', isGroup: false, text: 'salut' });
  assert.equal(empty.messages, 0); assert.match(cctx.summarize(empty), /première prise de contact/);
});

test('VITESSE : analyse du contexte + décision d\'engagement en quelques millisecondes (aucun réseau, aucune IA)', async () => {
  const T = 'speed1'; await seed(T); const from = '22670010002@s.whatsapp.net';
  const rows = []; for (let i = 0; i < 250; i += 1) rows.push([i % 2 ? 'out' : 'in', `message numéro ${i} sur la grillade et le prix`, 'Awa', (i + 1) * 20 * MIN]);
  await hist(T, from, rows);
  const t0 = Date.now(); const c = await cctx.analyze({ tenant: T, channel: 'WHATSAPP', from, isGroup: false, text: 'combien ?' });
  const cls = require('../ai-engine/jarvis/intentClassifier').classify('combien ?', { state: { memory: {} } });
  engagement.decide({ policy: policy.resolveFor(policy.DEFAULTS, 'WHATSAPP', from, false), ctx: c, cls, isGroup: false, text: 'combien ?', state: {} });
  assert.ok(Date.now() - t0 < 400, `${Date.now() - t0} ms`);
});

// ------------------------------------------------------------------ privé : quand parler business / naturel / présenter
test('PRIVÉ : discussion courante = NATURELLE (aucune offre dans le prompt) ; question sur l\'activité = business ; « que vendez-vous ? » = présentation', async () => {
  const T = 'priv1'; await seed(T); const from = '22670020001@s.whatsapp.net';
  let r = await say(T, from, 'Salut, ça va ? Tu as vu le match hier ?');
  assert.ok(r.replied); assert.equal(r.out.engagement.register, 'NATURAL'); assert.match(r.prompt, /n'est PAS le sujet/); assert.doesNotMatch(r.prompt, /5000|SERVICE PRIORITAIRE/);
  r = await say(T, from, 'Combien coûte le cours de grillade ?');
  assert.ok(r.replied); assert.match(r.out.engagement.register, /BUSINESS_ANSWER|PRESENT_SERVICE/); assert.match(r.prompt, /5000/); assert.match(r.prompt, /CONTEXTE/);
  const T2 = 'priv1b'; await seed(T2); const f2 = '22670020002@s.whatsapp.net';
  r = await say(T2, f2, 'Qu\'est-ce que vous vendez exactement ?');
  assert.equal(r.out.engagement.code, 'PRIVATE_ASKED_OFFER'); assert.equal(r.out.engagement.register, 'PRESENT_SERVICE'); assert.match(r.prompt, /Présente le service « Formation Grillade »/);
});

test('PRIVÉ : la mémoire 7 jours permet de reprendre le fil (salutation après une discussion business), sans relancer ni citer de prix', async () => {
  const T = 'priv2'; await seed(T); const from = '22670020003@s.whatsapp.net';
  await hist(T, from, [['in', 'Je suis intéressé par la formation grillade, quel prix ?', 'Awa', 2 * 24 * 60 * MIN], ['out', 'La Formation Grillade est à 5000 FCFA.', null, 2 * 24 * 60 * MIN - MIN]]);
  const r = await say(T, from, 'Bonjour !');
  assert.equal(r.out.engagement.code, 'PRIVATE_NATURAL_CONTINUITY'); assert.doesNotMatch(r.prompt, /SERVICE PRIORITAIRE/); assert.match(r.prompt, /rappeler en une courte phrase le sujet/);
});

test('PRIVÉ : politique « natural » = jamais de business même sur une question de prix ; « présenter : jamais » respecté ; exception par contact', async () => {
  const T = 'priv3'; await seed(T); const from = '22670020004@s.whatsapp.net';
  await policy.set(T, { override: { channel: 'WHATSAPP', id: from, mode: 'natural' } });
  const s = await require('../ai-engine/autoResponder').getSettings(T);
  const r = await say(T, from, 'Combien coûte le cours de grillade ?', { settings: { conversationPolicy: s.conversationPolicy } });
  assert.equal(r.out.engagement.code, 'PRIVATE_NATURAL_POLICY'); assert.doesNotMatch(r.prompt, /SERVICE PRIORITAIRE/);
  const cls = { intent: 'INTEREST', flags: {}, intents: ['INTEREST'] };
  const ctx = { messages: 3, windowDays: 7, themes: [], service: { name: 'X', affinity: 0.9, hits: [] }, business: { temperature: 'hot', presentedRecently: false }, current: {} };
  const e = engagement.decide({ policy: { mode: 'auto', presentServices: 'never' }, ctx, cls, isGroup: false, text: 'ça m\'intéresse', state: {} });
  assert.equal(e.present, false); assert.equal(e.register, 'BUSINESS_ANSWER');
});

test('PRIVÉ : présentation non répétée — déjà présenté il y a peu = réponse précise sans re-présenter', () => {
  const ctx = { messages: 4, windowDays: 7, themes: [], service: { name: 'Formation Grillade', affinity: 0.8, hits: [] }, business: { temperature: 'hot', presentedRecently: true }, current: { businessWords: true } };
  const e = engagement.decide({ policy: { mode: 'auto', presentServices: 'when-relevant' }, ctx, cls: { intent: 'QUESTION', flags: {}, intents: ['QUESTION'] }, isGroup: false, text: 'et la durée ?', state: {} });
  assert.equal(e.register, 'BUSINESS_ANSWER'); assert.equal(e.present, false); assert.match(e.why, /déjà fait récemment/);
});

// ------------------------------------------------------------------ groupes
const G = '120363001111@g.us';
test('GROUPE non lié à l\'activité : silence sur les conversations entre membres ; mention = réponse naturelle', async () => {
  const T = 'grp1'; await seed(T);
  await hist(T, G, [['in', 'On se voit samedi pour le foot ?', 'Ben', 30 * MIN], ['in', 'Oui je ramène les boissons', 'Chloé', 25 * MIN]], { group: true });
  let r = await say(T, G, 'Qui apporte le ballon ?', { senderId: 'Ben@s.whatsapp.net' });
  assert.equal(r.replied, false); assert.equal(r.out.engagement.code, 'GROUP_CASUAL');
  r = await say(T, G, 'Cyrus, tu peux nous donner une idée de jeu ?', { senderId: 'Ben@s.whatsapp.net', addressing: { mentioned: true } });
  assert.equal(r.replied, true); assert.equal(r.out.engagement.code, 'GROUP_ADDRESSED'); assert.doesNotMatch(r.prompt, /SERVICE PRIORITAIRE/);
});

test('GROUPE lié à l\'activité : répond brièvement à une VRAIE question sur le thème, se tait sur le bavardage, ne coupe pas un échange à deux, respecte le plafond', async () => {
  const T = 'grp2'; await seed(T, { linkGroup: G });
  await hist(T, G, [['in', 'La marinade pour la grillade, combien de temps ?', 'Ben', 50 * MIN]], { group: true });
  let r = await say(T, G, 'Quel est le prix du cours de grillade ?', { senderId: 'Chloé@s.whatsapp.net' });
  assert.equal(r.replied, true); assert.equal(r.out.engagement.code, 'GROUP_TOPIC_QUESTION'); assert.match(r.prompt, /BRÈVE/);
  r = await say(T, G, 'Haha trop drôle 😂', { senderId: 'Chloé@s.whatsapp.net' });
  assert.equal(r.replied, false); assert.equal(r.out.engagement.code, 'GROUP_OFF_TOPIC');
  // échange à deux (4 derniers messages alternés entre 2 membres)
  const T3 = 'grp3'; await seed(T3, { linkGroup: G });
  await hist(T3, G, [['in', 'tu viens ?', 'Ben', 9 * MIN], ['in', 'oui j\'arrive', 'Chloé', 8 * MIN], ['in', 'super, la grillade est prête', 'Ben', 7 * MIN], ['in', 'ok, à tout de suite', 'Chloé', 6 * MIN]], { group: true });
  r = await say(T3, G, 'Quel est le prix du cours de grillade ?', { senderId: 'Ben@s.whatsapp.net' });
  assert.equal(r.out.engagement.code, 'GROUP_DUO'); assert.equal(r.replied, false);
  // plafond de réponses
  const T4 = 'grp4'; await seed(T4, { linkGroup: G });
  await hist(T4, G, Array.from({ length: 4 }, (_, i) => ['out', `réponse ${i}`, null, (i + 1) * MIN]), { group: true });
  r = await say(T4, G, 'Quel est le prix du cours de grillade ?', { senderId: 'Awa@s.whatsapp.net' });
  assert.equal(r.out.engagement.code, 'GROUP_RATE_LIMIT'); assert.equal(r.replied, false);
});

test('GROUPE : mode « addressed » = silence même sur une question du thème ; mode « off » = silence total sauf formation liée ; exception par groupe', async () => {
  const T = 'grp5'; await seed(T, { linkGroup: G });
  await policy.set(T, { override: { channel: 'WHATSAPP', id: G, mode: 'addressed' } });
  const settings = await autoResponder.getSettings(T);
  let r = await say(T, G, 'Quel est le prix du cours de grillade ?', { senderId: 'Awa@s.whatsapp.net', settings: { conversationPolicy: settings.conversationPolicy } });
  assert.equal(r.out.engagement.code, 'GROUP_NOT_ADDRESSED'); assert.equal(r.replied, false);
  r = await say(T, G, 'Cyrus quel est le prix du cours de grillade ?', { senderId: 'Awa@s.whatsapp.net', settings: { conversationPolicy: settings.conversationPolicy } });
  assert.equal(r.replied, true);
  await policy.set(T, { group: 'off', override: { channel: 'WHATSAPP', id: G, clear: true } });
  const s2 = await autoResponder.getSettings(T);
  r = await say(T, G, 'Cyrus quel est le prix ?', { senderId: 'Awa@s.whatsapp.net', addressing: { mentioned: true }, settings: { conversationPolicy: s2.conversationPolicy } });
  assert.equal(r.out.engagement.code, 'GROUP_POLICY_OFF'); assert.equal(r.replied, false);
});

test('ADRESSAGE WhatsApp : mention de mon compte ou réponse à mon message détectées depuis le message Baileys', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const m = idx.match(/function waAddressing\(msg, session\) \{[\s\S]*?\r?\n\}\r?\n/); assert.ok(m, 'fonction présente');
  const waAddressing = new Function(`${m[0]}; return waAddressing;`)();
  const session = { getSelfIds: () => ({ pn: '22670000000@s.whatsapp.net', lid: '999111@lid' }) };
  assert.equal(waAddressing({ message: { extendedTextMessage: { text: '@bot salut', contextInfo: { mentionedJid: ['22670000000@s.whatsapp.net'] } } } }, session).mentioned, true);
  assert.equal(waAddressing({ message: { extendedTextMessage: { text: 'ok', contextInfo: { participant: '999111@lid', quotedMessage: {} } } } }, session).quotedFromBot, true);
  assert.equal(waAddressing({ message: { conversation: 'salut tout le monde' } }, session).mentioned, false);
});

// ------------------------------------------------------------------ pilotage + explication
test('PILOTAGE PAR LE CHAT : lire/régler la politique et une exception ; « pourquoi ? » explique la décision ; describeConversation résume la mémoire', async () => {
  const T = 'tools1'; await seed(T, { linkGroup: G });
  await hist(T, G, [['in', 'La grillade de viande, quelle marinade ?', 'Ben', 20 * MIN]], { group: true });
  const P = ownerOf(T); const call = (name, args) => authz.runAs(P, () => toolRegistry.execute(T, name, args, {}));
  let r = await call('getConversationPolicy', {}); assert.equal(r.state, 'SUCCESS'); assert.equal(r.result.policy.group, 'topic');
  r = await call('setConversationPolicy', { group: 'addressed' }); assert.equal(r.state, 'SUCCESS'); assert.equal(r.result.policy.group, 'addressed');
  r = await call('setConversationPolicy', { group: 'nimporte' }); assert.notEqual(r.state, 'SUCCESS');
  await hist(T, '22670030001@s.whatsapp.net', [['in', 'Bonjour', 'Awa Traoré', 5 * MIN]]);
  r = await call('setConversationPolicy', { conversation: 'Awa Traoré', mode: 'natural' }); assert.equal(r.state, 'SUCCESS', JSON.stringify(r.error)); assert.ok(r.result.exception && r.result.resume.some((l) => /Exceptions/.test(l)));
  r = await call('setConversationPolicy', { conversation: 'Grill Club', mode: 'business' }); assert.notEqual(r.state, 'SUCCESS', "business n'existe pas pour un groupe");
  r = await call('describeConversation', { conversation: 'Grill Club' }); assert.equal(r.state, 'SUCCESS'); assert.equal(r.result.type, 'groupe'); assert.match(r.result.resume, /Formation Grillade/);
  await require('../ai-engine/activityStore').record({ type: 'engagement', action: 'Pas de réponse', tenant: T, channel: 'WHATSAPP', target: G, detail: 'GROUP_OFF_TOPIC | Le message n\'est pas une question sur le thème du groupe.' });
  r = await call('explainReply', { conversation: 'Grill Club' }); assert.equal(r.state, 'SUCCESS'); assert.equal(r.result.decisions[0].code, 'GROUP_OFF_TOPIC'); assert.match(r.result.decisions[0].why, /thème du groupe/);
  const customer = authz.issuePrincipal({ tenant: T, role: 'CUSTOMER', channel: 'WHATSAPP', via: 'test' });
  const names = toolRegistry.list({ principal: customer }).map((t) => t.name);
  for (const nme of ['setConversationPolicy', 'getConversationPolicy', 'explainReply', 'describeConversation']) assert.ok(!names.includes(nme), `${nme} interdit à un client`);
});

// ------------------------------------------------------------------ l'IA (cascade) tranche les cas ambigus
test("ARBITRAGE PAR L'IA : cas ambigu de groupe/privé tranché par la cascade ; délai dépassé = règles ; règles dures jamais contournées ; option coupable", async () => {
  const isJudge = (p) => /décider s'il doit répondre/.test(p);
  // 1) groupe lié : « et pour la cuisson du poulet ? » (aucun mot-clé du service) → l'IA juge que c'est sur le thème
  const T = 'ai1'; await seed(T, { linkGroup: G });
  const judged = [];
  const runJudge = async (T0, from, text, judgeAnswer, opts) => {
    const before = sent.length; prompts.length = 0; judged.length = 0;
    const llmJ = async (p) => { if (isJudge(p)) { judged.push(p); return typeof judgeAnswer === 'function' ? judgeAnswer() : judgeAnswer; } prompts.push(String(p)); return 'Réponse de test.'; };
    const out = await autoResponder.handleIncoming(Object.assign({ tenantId: T0, channel: 'WHATSAPP', from, name: 'Awa', text, messageId: 'j' + (++n) }, opts || {}), { runtime, llm: llmJ, engagementLlm: async (p) => { if (isJudge(p)) { judged.push(p); return typeof judgeAnswer === 'function' ? judgeAnswer() : judgeAnswer; } return null; }, settings: Object.assign({ whatsapp: true }, (opts && opts.settings) || {}) });
    return { out, replied: sent.length > before, judged: judged.length };
  };
  let r = await runJudge(T, G, 'Et pour le poulet, il faut le retourner quand ?', '{"respond":true,"register":"GROUP_ANSWER","why":"question de cuisson au barbecue, thème du groupe"}', { senderId: 'Ben@s.whatsapp.net' });
  assert.equal(r.judged, 1); assert.equal(r.out.engagement.code, 'GROUP_AI_ON_TOPIC'); assert.equal(r.replied, true); assert.match(r.out.engagement.why, /L'IA juge/);
  // 2) l'IA confirme le silence
  r = await runJudge(T, G, 'Vous savez où se gare-t-on à la mairie ?', '{"respond":false,"register":"NATURAL","why":"hors sujet"}', { senderId: 'Ben@s.whatsapp.net' });
  assert.equal(r.replied, false); assert.match(r.out.engagement.why, /L'IA confirme le silence/);
  // 3) l'IA est trop lente : la décision par règles s'applique, sans retarder (< budget + marge)
  process.env.ENGAGEMENT_AI_BUDGET_MS = '150'; const t0 = Date.now();
  r = await runJudge(T, G, 'Et pour le poulet, il faut le retourner quand ?', () => new Promise(() => {}), { senderId: 'Ben@s.whatsapp.net' });
  delete process.env.ENGAGEMENT_AI_BUDGET_MS;
  assert.equal(r.replied, false); assert.equal(r.out.engagement.code, 'GROUP_OFF_TOPIC'); assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
  // 4) règles DURES : politique « addressed » — l'IA n'est même pas consultée
  await policy.set(T, { override: { channel: 'WHATSAPP', id: G, mode: 'addressed' } });
  const sA = await autoResponder.getSettings(T);
  r = await runJudge(T, G, 'Et pour le poulet, il faut le retourner quand ?', '{"respond":true,"register":"GROUP_ANSWER","why":"x"}', { senderId: 'Ben@s.whatsapp.net', settings: { conversationPolicy: sA.conversationPolicy } });
  assert.equal(r.judged, 0); assert.equal(r.replied, false);
  // 5) option « aiJudgment: false » : règles seules
  await policy.set(T, { aiJudgment: true, override: { channel: 'WHATSAPP', id: G, clear: true } });
  await policy.set(T, { aiJudgment: false }); const sB = await autoResponder.getSettings(T);
  r = await runJudge(T, G, 'Et pour le poulet, il faut le retourner quand ?', '{"respond":true,"register":"GROUP_ANSWER","why":"x"}', { senderId: 'Ben@s.whatsapp.net', settings: { conversationPolicy: sB.conversationPolicy } });
  assert.equal(r.judged, 0); assert.equal(r.replied, false);
  // 6) privé : après une discussion business, « et ça commence quand ? » = suite business tranchée par l'IA
  const T2 = 'ai2'; await seed(T2); const from = '22670040001@s.whatsapp.net';
  await hist(T2, from, [['in', 'Combien coûte le cours de grillade ?', 'Awa', 40 * MIN], ['out', 'Le cours de grillade coûte 5000 FCFA.', null, 39 * MIN]]);
  r = await runJudge(T2, from, 'et ça se passe comment ensuite ?', '{"respond":true,"register":"BUSINESS_ANSWER","why":"suite de la question sur le cours"}');
  assert.ok(r.replied); assert.match(r.out.engagement.register, /BUSINESS_ANSWER/);
});

test("TOUT PASSE PAR LA CASCADE : aucun appel direct à un fournisseur dans le répondeur, niveau « standard » (spontané) pour les clients", () => {
  const root = path.join(__dirname, '..');
  for (const f of ['ai-engine/autoResponder.js', 'ai-engine/engagement.js', 'ai-engine/conversationContext.js', 'ai-engine/jarvis/conversationEngine.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8'); assert.ok(!/require\(['"]axios['"]\)|fetch\(|generativelanguage|api\.groq|openrouter\.ai/.test(src), `${f} n'appelle aucun fournisseur en direct`);
  }
  const ar = fs.readFileSync(path.join(root, 'ai-engine/autoResponder.js'), 'utf8');
  assert.match(ar, /purpose: 'client_conversation'[\s\S]{0,200}?tier: 'standard'/); assert.match(ar, /purpose: 'engagement_judgment'[\s\S]{0,120}?tier: 'standard'/); assert.match(ar, /purpose: 'intent_arbitration'[\s\S]{0,120}?tier: 'reasoning'/, 'décision critique de refus : niveau raisonnement conservé');
});

test('CHAT (site, self WhatsApp/Telegram) : « pourquoi as-tu répondu ? » et « comportement du répondeur » répondent avec les vraies décisions/réglages', async () => {
  const orch = require('../ai-engine/chatOrchestrator'); const T = 'chatpol1'; await seed(T, { linkGroup: G });
  await hist(T, G, [['in', 'La grillade de viande, quelle marinade ?', 'Ben', 20 * MIN]], { group: true });
  await require('../ai-engine/activityStore').record({ type: 'engagement', action: 'Pas de réponse', tenant: T, channel: 'WHATSAPP', target: G, detail: "GROUP_DUO | Deux membres échangent entre eux : je ne les interromps pas." });
  const P = ownerOf(T); const run = (text) => orch.handle({ text, history: [], tenantId: T, sessionId: 's', principal: P }, {});
  assert.equal(orch.detectIntent('Pourquoi as-tu répondu à Grill Club ?'), 'convpolicy'); assert.equal(orch.detectIntent('Dans le groupe Grill Club, réponds seulement si on te mentionne'), 'convpolicy');
  let r = await run('Pourquoi le répondeur n\'a pas répondu dans le groupe Grill Club ?');
  assert.equal(r.intent, 'convpolicy'); assert.match(r.text, /Deux membres échangent entre eux/);
  r = await run('Montre le comportement du répondeur'); assert.match(r.text, /Discussions privées/); assert.match(r.text, /Groupes/);
  assert.equal(orch.detectIntent('Liste mes groupes WhatsApp'), 'groups'); assert.equal(orch.detectIntent('réponds-lui que je le rappelle'), 'reply');
});
