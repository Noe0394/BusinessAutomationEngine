// GUIDAGE PAS À PAS (GUIDED_SETUP / TUTORIAL_MODE) — ai-engine/guidedSetup.js
// ---------------------------------------------------------------------------
// OBJECTIF → PLAN → ÉTAPE → VALIDATION → ÉTAPE SUIVANTE → VÉRIFICATION → FIN. Chaque étape est VÉRIFIÉE sur l'état RÉEL du compte (Services métiers,
// contacts, campagnes, connexions, réglages…) : une étape n'est « faite » que si la donnée existe réellement — jamais parce que l'utilisateur le dit.
// Les plans sont indépendants du métier (commerce, restaurant, prestation, formation…). Les textes sont écrits à la PREMIÈRE PERSONNE (Cyrus parle).
const storageAdapter = require('./storageAdapter');

const NS = 'guided_setup';
const sanitize = (id) => String(id || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'default';

const svcs = async (t) => { try { return await require('./businessServices').list(t); } catch (e) { return []; } };
const hasSvcField = async (t, f) => (await svcs(t)).some((s) => { const v = (s.commercial || {})[f]; return v !== undefined && v !== null && String(v).trim() !== ''; });
const yes = (done, detail) => ({ done: !!done, detail: detail || null });
const connected = (mgr, t) => { try { const p = mgr.peek ? mgr.peek(t) : null; const s = p && p.session; return !!(s && typeof s.isConnected === 'function' && s.isConnected()); } catch (e) { return false; } };

// deps injectables pour les tests : { connected: { WHATSAPP(t), TELEGRAM(t) } }
const PLANS = {
  'create-service': {
    title: 'Créer votre Service métier', keywords: /service m[ée]tier|mon activit[ée]|configurer mon (?:commerce|activit|entreprise)|cr[ée]er mon service/i,
    explain: 'Je commence par votre Service métier : c\'est la fiche de votre activité (ce que vous vendez ou faites, les prix, les conditions de paiement, vos règles). C\'est à partir de cette fiche que je réponds à vos clients sans rien inventer. Je vérifie chaque étape dans votre compte avant de passer à la suivante.',
    steps: [
      { id: 'name', title: 'Décrire votre activité', instruction: 'Dites-moi le nom de votre activité et ce que vous vendez ou le service que vous proposez : je crée la fiche pour vous.', tools: ['configureBusinessService'], check: async (t) => yes((await svcs(t)).length > 0, `${(await svcs(t)).length} Service(s) métier`) },
      { id: 'prices', title: 'Renseigner les prix ou les produits', instruction: 'Donnez-moi vos prix (ou la liste de vos produits avec leur prix) : je ne citerai jamais un prix qui n\'est pas dans cette fiche.', tools: ['configureBusinessService'], check: async (t) => yes((await svcs(t)).some((s) => (s.commercial && s.commercial.price != null) || (s.products || []).length > 0)) },
      { id: 'payment', title: 'Indiquer comment vos clients paient', instruction: 'Dites-moi les moyens de paiement acceptés (numéro Mobile Money, virement, paiement à la livraison…) : je les donnerai exactement tels quels.', tools: ['configureBusinessService'], check: async (t) => yes(await hasSvcField(t, 'paymentTerms')) },
      { id: 'answers', title: 'Préparer les réponses aux objections et questions fréquentes', instruction: 'Donnez-moi les objections habituelles de vos clients et vos réponses (prix trop élevé, délai, qualité…) : je m\'en servirai pour répondre naturellement.', tools: ['configureBusinessService'], check: async (t) => yes((await hasSvcField(t, 'objections')) || (await hasSvcField(t, 'responses')) || (await hasSvcField(t, 'knowledge'))) },
      { id: 'active', title: 'Vérifier que le service est actif', instruction: 'Je vérifie que votre service est actif (ni en pause, ni désactivé) : sinon je ne le présente pas aux clients.', tools: [], check: async (t) => { const l = await svcs(t); return yes(l.some((s) => (s.lifecycle || 'active') === 'active')); } },
    ],
  },
  catalogue: {
    title: 'Configurer votre catalogue (produits, prestations, prix)', keywords: /catalogue|produits?\b.*(?:ajouter|configurer)|ajouter (?:des |mes )?produits/i,
    explain: 'Je range vos produits ou prestations dans votre Service métier, avec leur prix. Ensuite je peux les présenter, répondre aux questions et enregistrer les commandes sans me tromper de prix.',
    steps: [
      { id: 'service', title: 'Avoir un Service métier', instruction: 'Il me faut d\'abord votre Service métier : dites-moi votre activité et je le crée.', tools: ['configureBusinessService'], check: async (t) => yes((await svcs(t)).length > 0) },
      { id: 'products', title: 'Ajouter vos produits ou prestations', instruction: 'Envoyez-moi la liste « Nom | Prix » (ou un fichier Excel/PDF/photo de votre catalogue) : je l\'enregistre.', tools: ['configureBusinessService'], check: async (t) => yes((await svcs(t)).some((s) => (s.products || []).length > 0), 'produits enregistrés') },
      { id: 'priced', title: 'Vérifier que chaque produit a un prix', instruction: 'Je contrôle que chaque produit a bien un prix ; s\'il en manque, je vous les demande un par un.', tools: [], check: async (t) => { const all = (await svcs(t)).flatMap((s) => s.products || []); return yes(all.length > 0 && all.every((p) => p && p.price != null && !Number.isNaN(Number(p.price))), `${all.filter((p) => p && p.price == null).length} sans prix`); } },
    ],
  },
  'import-contacts': {
    title: 'Importer vos contacts (Excel, CSV, photo, texte)', keywords: /import\w*.*contacts?|contacts?.*(?:excel|csv)|importer (?:mes |une )?liste/i,
    explain: 'Vous m\'envoyez un fichier Excel/CSV, une photo de liste ou du texte collé. Je nettoie (numéros, doublons, invalides), je vous montre le rapport, puis j\'enregistre les contacts valides.',
    steps: [
      { id: 'send', title: 'M\'envoyer la liste', instruction: 'Envoyez-moi votre fichier (Excel, CSV, image, texte) ici, même dans ce chat.', tools: ['prepareContactsFromSource'], check: async (t) => { try { const d = await storageAdapter.get('campaign_drafts', sanitize(t), { drafts: {} }); return yes(Object.values(d.drafts).some((x) => x.kind === 'recipients'), 'liste préparée'); } catch (e) { return yes(false); } } },
      { id: 'saved', title: 'Enregistrer les contacts valides', instruction: 'Confirmez et j\'importe les contacts valides dans votre base.', tools: ['importContactsFromFile'], check: async (t) => { try { const c = await require('./contactCrm').counts(t); return yes(((c && c.total) || 0) > 0); } catch (e) { return yes(false); } } },
    ],
  },
  'create-campaign': {
    title: 'Créer une campagne', keywords: /campagne/i,
    explain: 'Je prépare une campagne en trois temps : une liste de destinataires validée, un message (que je peux rédiger avec vous), puis un brouillon que vous validez. Je ne lance rien sans votre accord, et je respecte la cadence pour protéger votre compte.',
    steps: [
      { id: 'recipients', title: 'Préparer les destinataires', instruction: 'Envoyez-moi la liste de destinataires (fichier ou texte) : je la nettoie et je vous montre le rapport.', tools: ['prepareContactsFromSource'], check: async (t) => { try { const d = await storageAdapter.get('campaign_drafts', sanitize(t), { drafts: {} }); return yes(Object.values(d.drafts).some((x) => x.kind === 'recipients')); } catch (e) { return yes(false); } } },
      { id: 'draft', title: 'Rédiger et enregistrer le brouillon', instruction: 'Dites-moi l\'objectif et l\'offre : je rédige le message et je crée le brouillon (rien n\'est envoyé).', tools: ['createCampaignDraft'], check: async (t) => { try { const d = await storageAdapter.get('campaign_drafts', sanitize(t), { drafts: {} }); return yes(Object.values(d.drafts).some((x) => x.kind === 'campaign')); } catch (e) { return yes(false); } } },
      { id: 'launched', title: 'Lancer la campagne (avec votre confirmation)', instruction: 'Quand vous êtes prêt, dites « lance » : je vous montre l\'aperçu et j\'attends votre « oui » avant d\'envoyer.', tools: ['launchCampaign'], check: async (t) => { try { const d = await storageAdapter.get('campaign_drafts', sanitize(t), { drafts: {} }); return yes(Object.values(d.drafts).some((x) => x.kind === 'campaign' && ['launched', 'scheduled'].includes(x.status))); } catch (e) { return yes(false); } } },
    ],
  },
  'schedule-campaign': {
    title: 'Programmer une campagne', keywords: /programm\w*.*campagne|campagne.*programm/i,
    explain: 'Je crée le brouillon puis je le programme à la date et à l\'heure voulues : la file durable l\'envoie même si votre écran est fermé.',
    steps: [
      { id: 'draft', title: 'Avoir un brouillon de campagne', instruction: 'Je prépare d\'abord le brouillon (liste + message).', tools: ['createCampaignDraft'], check: async (t) => { try { const d = await storageAdapter.get('campaign_drafts', sanitize(t), { drafts: {} }); return yes(Object.values(d.drafts).some((x) => x.kind === 'campaign')); } catch (e) { return yes(false); } } },
      { id: 'scheduled', title: 'Choisir la date et l\'heure', instruction: 'Donnez-moi la date et l\'heure d\'envoi : je programme (avec votre confirmation).', tools: ['scheduleCampaign'], check: async (t) => { try { const d = await storageAdapter.get('campaign_drafts', sanitize(t), { drafts: {} }); return yes(Object.values(d.drafts).some((x) => x.kind === 'campaign' && (x.status === 'scheduled' || x.scheduledTaskId || x.runAt))); } catch (e) { return yes(false); } } },
    ],
  },
  'connect-whatsapp': {
    title: 'Connecter votre WhatsApp', keywords: /connecter (?:mon )?whatsapp|lier whatsapp|whatsapp.*connect/i,
    explain: 'Vous ouvrez l\'onglet « Connexions & Intégrations », vous scannez le QR code (ou vous saisissez le code d\'association sur mobile) : dès que WhatsApp valide, je vois la connexion et je peux répondre à vos clients.',
    steps: [{ id: 'paired', title: 'Scanner le QR code ou saisir le code d\'association', instruction: 'Ouvrez « Connexions & Intégrations », bloc WhatsApp, et scannez le QR code depuis WhatsApp > Appareils connectés (ou utilisez le code d\'association).', tools: [], check: async (t, deps) => yes(deps && deps.connected ? deps.connected.WHATSAPP(t) : connected(require('../adapters/whatsappManager'), t), 'connexion WhatsApp') }],
  },
  'connect-telegram': {
    title: 'Connecter votre Telegram', keywords: /connecter (?:mon )?telegram|telegram.*connect/i,
    explain: 'Dans « Connexions & Intégrations », bloc Telegram : vous saisissez votre numéro, puis le code reçu sur Telegram (et votre mot de passe 2FA si vous en avez un). Ensuite je peux répondre et envoyer depuis ce compte.',
    steps: [{ id: 'logged', title: 'Vous connecter avec votre numéro et le code Telegram', instruction: 'Dans « Connexions & Intégrations », bloc Telegram : saisissez votre numéro puis le code reçu.', tools: [], check: async (t, deps) => yes(deps && deps.connected ? deps.connected.TELEGRAM(t) : connected(require('../adapters/telegramManager'), t), 'connexion Telegram') }],
  },
  'configure-sav': {
    title: 'Configurer votre SAV (service après-vente)', keywords: /\bsav\b|apr[èe]s[- ]vente|r[ée]clamation/i,
    explain: 'Le SAV, c\'est ce que je fais quand un client a un problème : j\'écoute, je m\'appuie sur vos règles et vos données, je propose la solution, j\'ouvre un dossier suivi jusqu\'à sa résolution, et je vous prévenais quand j\'ai besoin de vous. Il me faut donc vos règles SAV (retours, remboursements, délais) et l\'autorisation de répondre.',
    steps: [
      { id: 'service', title: 'Avoir un Service métier', instruction: 'Je m\'appuie sur votre Service métier : s\'il n\'existe pas encore, dites-moi votre activité.', tools: ['configureBusinessService'], check: async (t) => yes((await svcs(t)).length > 0) },
      { id: 'rules', title: 'Donner vos règles SAV', instruction: 'Dites-moi vos règles : retours, échanges, remboursements, délais, ce que je peux promettre et ce que je dois vous transmettre.', tools: ['configureBusinessService'], check: async (t) => yes((await hasSvcField(t, 'supportRules')) || (await hasSvcField(t, 'escalation'))) },
      { id: 'reply', title: 'Autoriser les réponses automatiques', instruction: 'Activez la réponse automatique de votre compte pour que je puisse répondre aux clients.', tools: ['setAutoReply'], check: async (t) => { try { const s = await require('./autoResponder').getSettings(t); return yes(!!(s && (s.whatsapp || s.telegram))); } catch (e) { return yes(false); } } },
    ],
  },
  'configure-followups': {
    title: 'Configurer le suivi et les relances', keywords: /relance|suivi/i,
    explain: 'Après une livraison ou une prestation, je peux revenir vers le client (« tout s\'est bien passé ? »), relancer un paiement en attente ou un prospect resté sans suite. Avant CHAQUE envoi je revérifie : statut, dernier échange, action déjà faite, désinscription, service actif et votre autorisation.',
    steps: [
      { id: 'orders', title: 'Enregistrer vos commandes ou prestations', instruction: 'Dites-moi les commandes/prestations (client, ce qui a été commandé) : je les suis jusqu\'à la livraison — c\'est ce qui me permet de déclencher le suivi.', tools: ['recordOrder'], check: async (t) => yes((await require('./customerLifecycle').listOrders(t)).length > 0) },
      { id: 'allowed', title: 'Autoriser les relances automatiques', instruction: 'Confirmez que j\'ai le droit d\'envoyer les relances et suivis (je peux aussi vous demander une validation avant chaque envoi).', tools: ['setAutoReply'], check: async (t) => { try { const s = await require('./autoResponder').getSettings(t); return yes(s && s.followUps === true); } catch (e) { return yes(false); } } },
    ],
  },
  'manage-groups': {
    title: 'Gérer vos groupes', keywords: /groupes?/i,
    explain: 'Je peux créer et remplir un groupe (avec respect de la vie privée des membres), découvrir des groupes publics de votre secteur, et répondre dans un groupe lié à votre Service métier — à condition d\'y être administrateur.',
    steps: [
      { id: 'linked', title: 'Lier un groupe à votre Service métier', instruction: 'Dites-moi quel groupe lier à quel service : je vérifie que je suis bien administrateur avant de l\'enregistrer.', tools: ['linkServiceGroup'], check: async (t) => yes((await svcs(t)).some((s) => (s.groups || []).length > 0)) },
    ],
  },
};

const load = (t) => storageAdapter.get(NS, sanitize(t), { tenant: sanitize(t), active: null, history: [] });
const listPlans = () => Object.entries(PLANS).map(([id, p]) => ({ id, title: p.title, steps: p.steps.length }));
const planForText = (text) => {
  const t = String(text || '');
  const order = ['schedule-campaign', 'connect-whatsapp', 'connect-telegram', 'configure-sav', 'import-contacts', 'catalogue', 'manage-groups', 'create-service', 'configure-followups', 'create-campaign'];
  return order.find((id) => PLANS[id].keywords.test(t)) || null;
};
function explain(planId) { const p = PLANS[planId]; return p ? { id: planId, title: p.title, text: p.explain, steps: p.steps.map((s) => s.title) } : null; }

async function evaluate(tenant, planId, deps) {
  const p = PLANS[planId]; if (!p) return null;
  const steps = [];
  for (const s of p.steps) { let r; try { r = await s.check(tenant, deps || {}); } catch (e) { r = { done: false, detail: null }; } steps.push({ id: s.id, title: s.title, instruction: s.instruction, tools: s.tools, done: r.done, detail: r.detail }); }
  const idx = steps.findIndex((s) => !s.done);
  return { planId, title: p.title, steps, current: idx < 0 ? null : idx, done: steps.filter((s) => s.done).length, total: steps.length, finished: idx < 0 };
}
async function start(tenant, planId, deps) {
  if (!PLANS[planId]) { const e = new Error('Plan inconnu.'); e.code = 'UNKNOWN_PLAN'; throw e; }
  const doc = await load(tenant); doc.active = { planId, startedAt: Date.now() };
  await storageAdapter.set(NS, sanitize(tenant), doc);
  return status(tenant, deps);
}
async function status(tenant, deps) {
  const doc = await load(tenant); if (!doc.active) return null;
  const ev = await evaluate(tenant, doc.active.planId, deps);
  if (ev && ev.finished) { doc.history.push({ planId: ev.planId, completedAt: Date.now() }); doc.active = null; await storageAdapter.set(NS, sanitize(tenant), doc); }
  return ev;
}
// Message à la PREMIÈRE PERSONNE pour l'état courant (jamais « c'est fait » sans vérification réelle).
function render(ev) {
  if (!ev) return "Je n'ai pas de guidage en cours. Dites-moi ce que vous voulez mettre en place (Service métier, catalogue, contacts, campagne, SAV, relances, groupes, connexion WhatsApp/Telegram) et je vous guide pas à pas.";
  if (ev.finished) return `C'est vérifié : « ${ev.title} » est en place (${ev.total}/${ev.total} étapes contrôlées dans votre compte). Voulez-vous que j'enchaîne avec la suite ?`;
  const s = ev.steps[ev.current];
  const doneLines = ev.steps.slice(0, ev.current).filter((x) => x.done).map((x) => `✅ ${x.title}`).join('\n');
  return `${doneLines ? doneLines + '\n' : ''}Étape ${ev.current + 1}/${ev.total} — ${s.title}.\n${s.instruction}${s.tools && s.tools.length ? '' : ''}\nDès que c'est fait, dites-moi « suivant » : je vérifie moi-même dans votre compte avant de passer à l'étape suivante.`;
}

module.exports = { PLANS, listPlans, planForText, explain, evaluate, start, status, render };
