// TEST RUNNER — campagnes Facebook Ads (Service Métier) : configuration par le Chat, détection d'origine, règle, envoi exact.
//   node --test test/ad-campaigns.test.js
'use strict';
require('./helpers/auth').actAsAdmin(); // identité authentifiée de test (deny-by-default : voir ai-engine/authz.js)
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.AI_ENGINE_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-ads-'));
const platformOrchestrator = require('../ai-engine/platformOrchestrator');
platformOrchestrator.notifyTenantChat = async () => {};
const alertCenter = require('../ai-engine/alertCenter');
alertCenter.setDeliverers([async () => ({ ok: true, channel: 't' })]);
const ads = require('../ai-engine/adCampaigns');
const parser = require('../ai-engine/adCampaignParser');
const businessServices = require('../ai-engine/businessServices');
const chatOrchestrator = require('../ai-engine/chatOrchestrator');
const contactCrm = require('../ai-engine/contactCrm');
const messageHistory = require('../ai-engine/messageHistory');
const conversationState = require('../ai-engine/jarvis/conversationState');
const contactIdentity = require('../ai-engine/contactIdentity');
const autoResponder = require('../ai-engine/autoResponder');

const MSG = 'Bienvenue ! 🎓 Voici la formation :\n- 8 modules\n- Certificat\nRéponds « OK » pour recevoir le programme.';
const ENTRY = 'Bonjour ! Puis-je en savoir plus à ce sujet ?';
const INSTRUCTION = `Cette semaine j'ai lancé une campagne Facebook Ads pour ma formation. Tous les nouveaux contacts provenant de cette campagne qui m'écrivent « ${ENTRY} » ou qui arrivent via le lien de cette publicité doivent recevoir exactement ce texte : « ${MSG} » Ensuite, continue normalement la conversation.`;

let seq = 0;
const jid = () => `2267000${String(++seq).padStart(4, '0')}@s.whatsapp.net`;
const waMsg = (text, remoteJid, contextInfo) => ({ key: { remoteJid, fromMe: false, id: 'M' + (++seq) }, pushName: 'Awa', message: contextInfo ? { extendedTextMessage: { text, contextInfo } } : { conversation: text } });
function sender() { const sent = []; return { sent, send: async (t) => { sent.push(t); return { status: 'SUCCESS', confirmationId: 'C' + sent.length }; } }; }
async function entry(tenant, text, opts) {
  const o = opts || {};
  const from = o.from || jid();
  const msg = o.msg || waMsg(text, from, o.contextInfo);
  const s = o.sender || sender();
  const identity = await contactIdentity.resolveContact(tenant, { jid: from, pushName: 'Awa' });
  const out = await ads.handleEntry({ tenantId: tenant, channel: 'WHATSAPP', from, messageId: msg.key.id, text, msg, identity }, { send: s.send });
  return { out, s, from, msg };
}
const llmStub = async () => JSON.stringify({ name: 'Formation — septembre', productName: 'Formation Pro', serviceName: '', adIds: '', sourceUrls: '', continuationRules: 'Ne jamais donner de prix avant la question ; proposer le paiement seulement si le contact le demande' });

test('parseur : le message exact et le message d\'entrée sont extraits sans altération', () => {
  const p = parser.extractInitialMessage(INSTRUCTION);
  assert.equal(p.message, MSG);
  assert.deepEqual(p.entryMessages, [ENTRY]);
  const free = parser.extractInitialMessage('Envoie exactement ce texte : Salut, voici le lien https://x.example/y ! Ensuite, continue.');
  assert.equal(free.message, 'Salut, voici le lien https://x.example/y !');
  assert.equal(parser.extractInitialMessage('Configure ma campagne Facebook Ads pour les nouveaux contacts').message, null);
});

test('Chat -> outil -> Service Métier : configuration réelle, message initial exact, période, variantes', async () => {
  const t = 'ad1';
  assert.equal(chatOrchestrator.detectIntent(INSTRUCTION, null), 'adcampaign');
  const out = await chatOrchestrator.handle({ text: INSTRUCTION, history: [], tenantId: t, sessionId: 's', lastAssistantMessage: null }, { llm: llmStub });
  assert.ok(out.toolCall && out.toolCall.name === 'configureFacebookAdCampaign' && out.toolCall.state === 'SUCCESS', JSON.stringify(out).slice(0, 400));
  assert.match(out.text, /Campagne Facebook Ads/);
  const services = await businessServices.list(t);
  assert.equal(services.length, 1, 'un Service Métier persistant a été créé');
  const camp = services[0].adCampaigns[0];
  assert.equal(camp.source, 'FACEBOOK_ADS');
  assert.equal(camp.initialMessage, MSG, 'message initial conservé au caractère près');
  assert.deepEqual(camp.criteria.entryMessages, [ENTRY]);
  assert.equal(camp.status, 'active');
  assert.ok(camp.startAt && camp.endAt && camp.endAt > camp.startAt, 'période « cette semaine » calculée');
  assert.ok(ads.statusOf(camp) === 'ACTIVE');
  assert.deepEqual(camp.continuation.rules.length, 2);
  // l'outil de liste voit la même donnée
  const list = await require('../ai-engine/toolRegistry').execute(t, 'listFacebookAdCampaigns', {}, {});
  assert.equal(list.result.count, 1);
});

test('Chat : sans message fourni, demande le texte exact puis le reprend verbatim', async () => {
  const t = 'ad2';
  const q = await chatOrchestrator.handle({ text: 'Configure ma campagne Facebook Ads : les nouveaux contacts doivent recevoir un message d\'accueil', history: [], tenantId: t, sessionId: 's', lastAssistantMessage: null }, { llm: llmStub });
  assert.equal(q.isPlanningQuestion, true);
  assert.equal(q.intent, 'adcampaign');
  assert.match(q.text, /texte EXACT/);
  const verbatim = '  Salut ! Voici tout : http://a.b/c  \n2e ligne';
  const done = await chatOrchestrator.handle({ text: verbatim, history: [], tenantId: t, sessionId: 's', lastAssistantMessage: { role: 'assistant', ...q } }, { llm: llmStub });
  assert.equal(done.toolCall.state, 'SUCCESS');
  const camp = (await businessServices.list(t))[0].adCampaigns[0];
  assert.equal(camp.initialMessage, verbatim.trim());
});

test('détection d\'origine : uniquement des données réelles', () => {
  const none = ads.extractAdOrigin(waMsg('Bonjour', 'x@s.whatsapp.net'));
  assert.equal(none.isMetaAd, false);
  assert.equal(none.platform, null);
  const real = ads.extractAdOrigin(waMsg('Bonjour', 'x@s.whatsapp.net', { externalAdReply: { sourceType: 'ad', sourceId: 'AD123', sourceUrl: 'https://fb.me/abc', ctwaClid: 'CLID' }, conversionSource: 'FB_Ads' }));
  assert.equal(real.isMetaAd, true);
  assert.equal(real.adId, 'AD123');
  assert.equal(real.ctwaClid, 'CLID');
  // un simple aperçu de lien n'est PAS une publicité
  const link = ads.extractAdOrigin(waMsg('Bonjour', 'x@s.whatsapp.net', { externalAdReply: { sourceType: 'url', sourceUrl: 'https://exemple.com' } }));
  assert.equal(link.isMetaAd, false);
});

test('variantes raisonnables du message d\'entrée', () => {
  const v = [ENTRY];
  for (const ok of [ENTRY, 'bonjour puis-je en savoir plus ?', 'Bonjour, je voudrais plus d\'informations', 'Salut, je veux en savoir plus à ce sujet', 'Bonjour ! Pouvez-vous me donner des infos ?']) assert.equal(ads.matchesEntryMessage(ok, v).matched, true, ok);
  for (const no of ['Bonjour', 'Tu es où ?', 'Voici mon reçu de paiement', 'Merci, à demain', 'Je voudrais annuler ma commande de pizza livrée hier soir à la maison svp merci beaucoup']) assert.equal(ads.matchesEntryMessage(no, v).matched, false, no);
});

async function setup(t, overrides) {
  const r = await ads.configure(t, Object.assign({ serviceName: 'Formation Pro', createService: true, name: 'Camp A', initialMessage: MSG, entryMessages: ENTRY, continuationRules: 'Ne pas donner de prix avant la question' }, overrides || {}));
  assert.ok(r.ok, JSON.stringify(r));
  return r.result;
}

test('nouveau contact + message d\'entrée exact, SANS donnée Facebook : message exact envoyé, source seulement « déclarée »', async () => {
  const t = 'ad3'; await setup(t);
  const { out, s, from } = await entry(t, ENTRY);
  assert.equal(out.handled, true);
  assert.equal(out.reason, 'INITIAL_MESSAGE_SENT');
  assert.equal(out.verified, false, 'aucune origine Facebook inventée');
  assert.deepEqual(s.sent, [MSG], 'texte EXACT, aucune reformulation');
  const crm = await contactCrm.getContact(t, 'WHATSAPP', from);
  assert.ok(crm.tags.includes(ads.TAG_DECLARED));
  assert.ok(!crm.tags.includes(ads.TAG_VERIFIED));
  assert.ok(crm.tags.some((x) => x.startsWith('campaign_')));
  const st = await conversationState.get(t, 'WHATSAPP', from);
  assert.equal(st.ad.initialSent, true);
  assert.equal(st.ad.sourceVerified, false);
});

test('donnée d\'annonce RÉELLE (referral) : source vérifiée, envoi même sans le message d\'entrée exact', async () => {
  const t = 'ad4'; await setup(t, { adIds: 'AD777' });
  const ci = { externalAdReply: { sourceType: 'ad', sourceId: 'AD777', ctwaClid: 'Z' } };
  const { out, s, from } = await entry(t, 'Salut', { contextInfo: ci });
  assert.equal(out.reason, 'INITIAL_MESSAGE_SENT');
  assert.equal(out.verified, true);
  assert.equal(out.how, 'ad_id');
  assert.deepEqual(s.sent, [MSG]);
  const crm = await contactCrm.getContact(t, 'WHATSAPP', from);
  assert.ok(crm.tags.includes(ads.TAG_VERIFIED));
  // autre annonce Meta, autre identifiant : pas de correspondance
  const other = await entry(t, 'Salut', { contextInfo: { externalAdReply: { sourceType: 'ad', sourceId: 'AD999' } } });
  assert.equal(other.out.handled, false);
  assert.equal(other.s.sent.length, 0);
});

test('requireAdReferral : le texte seul ne suffit pas quand la donnée Facebook est absente', async () => {
  const t = 'ad5'; await setup(t, { requireAdReferral: true, adIds: 'AD1' });
  const r = await entry(t, ENTRY);
  assert.equal(r.out.handled, false);
  assert.equal(r.s.sent.length, 0);
});

test('ancien contact qui revient : aucun message automatique', async () => {
  const t = 'ad6'; await setup(t);
  const from = jid();
  await messageHistory.record(t, { channel: 'WHATSAPP', direction: 'in', party: from, chatId: from, text: 'ancien message', messageId: 'OLD1', ts: Math.floor(Date.now() / 1000) - 3600 });
  const r = await entry(t, ENTRY, { from });
  assert.equal(r.out.handled, false);
  assert.equal(r.out.reason, 'EXISTING_CONTACT');
  assert.equal(r.s.sent.length, 0);
  // même chose si le CRM connaît déjà le contact
  const from2 = jid();
  await contactCrm.recordSeen(t, { channel: 'WHATSAPP', from: contactCrm.identityOf(from2), name: 'Vieux client' });
  const r2 = await entry(t, ENTRY, { from: from2 });
  assert.equal(r2.out.reason, 'EXISTING_CONTACT');
});

test('idempotence : redélivrance du même message, message suivant, envois concurrents', async () => {
  const t = 'ad7'; await setup(t);
  const from = jid();
  const msg = waMsg(ENTRY, from);
  const s = sender();
  const identity = await contactIdentity.resolveContact(t, { jid: from, pushName: 'Awa' });
  const run = () => ads.handleEntry({ tenantId: t, channel: 'WHATSAPP', from, messageId: msg.key.id, text: ENTRY, msg, identity }, { send: s.send });
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(s.sent.length, 1, 'un seul envoi malgré deux exécutions simultanées');
  assert.equal([a, b].filter((x) => x.reason === 'INITIAL_MESSAGE_SENT').length, 1);
  const again = await run();
  assert.equal(again.reason, 'DUPLICATE_DELIVERY');
  assert.equal(again.handled, true);
  assert.equal(s.sent.length, 1);
  // message suivant du même contact (même texte, autre id) : déjà envoyé -> conversation normale
  const next = await entry(t, ENTRY, { from, sender: s });
  assert.equal(next.out.handled, false);
  assert.equal(next.out.reason, 'INITIAL_MESSAGE_ALREADY_SENT');
  assert.equal(s.sent.length, 1);
});

test('campagne inactive / expirée / pas encore commencée', async () => {
  const t = 'ad8';
  const r = await setup(t);
  await ads.setStatus(t, r.campaignId, false);
  assert.equal((await entry(t, ENTRY)).out.reason, 'NO_ACTIVE_CAMPAIGN');
  await ads.setStatus(t, r.campaignId, true);
  assert.equal((await entry(t, ENTRY)).out.reason, 'INITIAL_MESSAGE_SENT');
  const t2 = 'ad8b'; await setup(t2, { startAt: Date.now() - 10 * 864e5, endAt: Date.now() - 864e5 });
  const exp = await entry(t2, ENTRY);
  assert.equal(exp.out.handled, false);
  assert.equal(exp.out.reason, 'CAMPAIGN_EXPIRED');
  assert.equal(exp.s.sent.length, 0);
  const t3 = 'ad8c'; await setup(t3, { startAt: Date.now() + 864e5 });
  assert.equal((await entry(t3, ENTRY)).s.sent.length, 0);
});

test('plusieurs campagnes actives : la plus précise gagne ; à égalité, rien n\'est envoyé et le propriétaire est alerté', async () => {
  const t = 'ad9';
  await setup(t, { name: 'Camp générique', initialMessage: 'MSG GENERIQUE' });
  await setup(t, { name: 'Camp annonce X', initialMessage: 'MSG ANNONCE X', adIds: 'ADX', entryMessages: '' });
  // même message d'entrée pour deux campagnes : ambigu
  const a = await entry(t, ENTRY);
  assert.equal(a.out.handled, true, 'une seule correspond au texte : la générique');
  assert.deepEqual(a.s.sent, ['MSG GENERIQUE']);
  // annonce ADX + texte identique : la correspondance annonce (plus forte) l'emporte
  const b = await entry(t, ENTRY, { contextInfo: { externalAdReply: { sourceType: 'ad', sourceId: 'ADX' } } });
  assert.deepEqual(b.s.sent, ['MSG ANNONCE X']);
  // deux campagnes avec le même message d'entrée et rien de plus précis
  const t2 = 'ad9b';
  await setup(t2, { name: 'C1', initialMessage: 'M1' });
  await setup(t2, { name: 'C2', initialMessage: 'M2' });
  const amb = await entry(t2, ENTRY);
  assert.equal(amb.out.reason, 'AMBIGUOUS_CAMPAIGNS');
  assert.equal(amb.s.sent.length, 0);
  const alerts = await alertCenter.list(t2);
  assert.ok(alerts.some((x) => /plusieurs campagnes/.test(x.title)));
});

test('échec d\'envoi : la conversation continue normalement, nouvelle tentative au message suivant (max 2)', async () => {
  const t = 'ad10'; await setup(t);
  const from = jid();
  const failing = { sent: [], send: async () => ({ status: 'FAILED', error: 'NOT_CONNECTED' }) };
  const r1 = await entry(t, ENTRY, { from, sender: failing });
  assert.equal(r1.out.handled, false);
  assert.equal(r1.out.reason, 'SEND_FAILED');
  const ok = sender();
  const r2 = await entry(t, ENTRY, { from, sender: ok });
  assert.equal(r2.out.reason, 'INITIAL_MESSAGE_SENT');
  assert.deepEqual(ok.sent, [MSG]);
});

test('poursuite normale : le contexte du service, le message déjà envoyé et les règles sont fournis au Chat Intelligent', async () => {
  const t = 'ad11'; await setup(t);
  const r = await entry(t, ENTRY);
  const ctx = await ads.continuationContext(t, 'WHATSAPP', r.from);
  assert.match(ctx, /campagne Facebook Ads « Camp A »/);
  assert.ok(ctx.includes(MSG), 'message déjà envoyé mentionné (à ne pas répéter)');
  assert.match(ctx, /Ne pas donner de prix avant la question/);
  assert.match(ctx, /non vérifiée par Facebook/);
  // le prompt réellement construit pour la réponse suivante contient ce contexte
  let captured = '';
  await autoResponder.composeReply({ tenant: t, channel: 'WHATSAPP', from: r.from, name: 'Awa', text: 'Combien ça coûte ?', llm: async (p) => { captured = p; return 'réponse'; } });
  assert.ok(captured.includes('campagne Facebook Ads « Camp A »'));
  assert.ok(captured.includes('Combien ça coûte ?'));
  // un contact issu de la campagne ne repart pas vers le routage privé : la conversation reste commerciale
  const assistantLayer = require('../ai-engine/assistantLayer').create({ autoResponder: { getSettings: async () => ({ whatsapp: true }), isEnabled: () => true, isGroupChat: () => false }, getRuntime: () => null });
  const routed = await assistantLayer.route({ tenantId: t, channel: 'WHATSAPP', text: 'Tu es où ?', from: r.from, messageId: 'Q', identity: null });
  assert.equal(routed.reason, 'AD_CONTACT');
});

test('aucune campagne configurée : aucun effet sur les contacts', async () => {
  const r = await entry('ad12', ENTRY);
  assert.equal(r.out.reason, 'NO_CAMPAIGN_CONFIGURED');
  assert.equal(r.s.sent.length, 0);
});
