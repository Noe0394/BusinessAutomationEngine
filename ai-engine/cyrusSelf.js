// AUTO-CONNAISSANCE DE CYRUS — ai-engine/cyrusSelf.js
// ---------------------------------------------------------------------------
// Cyrus sait ce qu'il peut faire PARCE QU'il interroge les registres réels (outils du Tool Registry autorisés au propriétaire, agents du registre
// Agency Agents, Services métiers du compte, sessions WhatsApp/Telegram connectées, réglages, quota) — jamais une liste écrite à la main qui
// mentirait. Il parle à la PREMIÈRE PERSONNE (« Je suis… », « Je peux… »). Il ne révèle jamais de modèle, fournisseur, clé ni détail technique
// interne, et n'invente ni fonctionnalité, ni prix, ni résultat, ni garantie.
const DOMAINS = [
  { id: 'conversation', label: 'répondre à vos clients (WhatsApp, Telegram, Web)', match: /^(sendMessage|replyTo|setAutoReply|getAutoReply|readConversation|searchMessages|getConversation)/i, example: 'je réponds à un client qui demande un prix, avec vos informations à vous' },
  { id: 'contacts', label: 'importer, nettoyer et organiser vos contacts', match: /contact|recipient|importContacts|crm|segment|tag/i, example: 'vous m\'envoyez un fichier Excel, je le nettoie et j\'enregistre les numéros valides' },
  { id: 'campaigns', label: 'préparer, programmer et lancer des campagnes', match: /campaign|schedule|broadcast/i, example: 'je rédige un message, je prépare le brouillon et j\'attends votre « oui » avant d\'envoyer' },
  { id: 'groups', label: 'gérer des groupes et découvrir des communautés', match: /group|communit|channel(?!s?$)|invite/i, example: 'je crée un groupe et j\'envoie les invitations par message privé' },
  { id: 'orders', label: 'suivre vos commandes, réservations et prestations', match: /^(recordOrder|updateOrderStatus|listOrders)$/, example: 'je passe une commande à « livrée » et je planifie le suivi' },
  { id: 'sav', label: 'gérer le service après-vente', match: /SavCase/, example: 'j\'ouvre un dossier de réclamation et je le suis jusqu\'à sa résolution' },
  { id: 'followups', label: 'relancer et suivre vos clients au bon moment', match: /followUp|FollowUp|whyFollow/, example: 'avant chaque relance, je vérifie que le client n\'a pas déjà répondu ni acheté' },
  { id: 'learning', label: 'accompagner vos apprenants avec vos supports de cours', match: /course|Course|faq/i, example: 'je réponds à une question sur un chapitre à partir de votre support' },
  { id: 'services', label: 'connaître votre activité (Services métiers)', match: /businessService|configureBusinessService|listBusinessServices|service/i, example: 'je retiens vos produits, vos prix et vos règles, et je m\'y tiens' },
  { id: 'reports', label: 'faire le point sur l\'activité et les résultats', match: /report|Report|activity|Activity|diagnos|alert|notif/i, example: 'je vous dis ce qui a été fait, ce qui bloque et ce qui est à améliorer' },
  { id: 'guide', label: 'vous guider pas à pas dans la configuration', match: /guideSetup/, example: 'je vous guide étape par étape et je vérifie chaque étape dans votre compte' },
];
const OWNER_ONLY_NOTE = 'Ce que je fais pour vos clients reste limité à ce que vous m\'avez configuré (Service métier, règles, autorisations).';

async function safe(fn, dflt) { try { return await fn(); } catch (e) { return dflt; } }

// Instantané RÉEL de ce que je peux faire pour ce compte.
async function capabilities(tenant) {
  const registry = require('./toolRegistry'); const authz = require('./authz');
  let tools = [];
  try { const p = authz.issuePrincipal({ tenant, role: 'OWNER', source: 'self-knowledge' }); tools = registry.list({ principal: p }); } catch (e) { tools = registry.describe(); }
  const domains = DOMAINS.map((d) => { const names = tools.filter((t) => d.match.test(t.name)).map((t) => t.name); return { id: d.id, label: d.label, example: d.example, tools: names, available: names.length > 0 }; });
  const agents = await safe(async () => { const r = require('./agents/agentRegistry'); const s = r.summary(); return { total: s.total, divisions: Object.keys(s.perDivision).length, blocked: s.blocked.length }; }, { total: 0, divisions: 0, blocked: 0 });
  const services = await safe(async () => (await require('./businessServices').list(tenant)).map((s) => ({ id: s.id, name: s.name, type: s.type, lifecycle: s.lifecycle || 'active', products: (s.products || []).length, hasPrice: !!(s.commercial && s.commercial.price != null) || (s.products || []).some((p) => p && p.price != null), groups: (s.groups || []).length, supportRules: !!(s.commercial && s.commercial.supportRules), paymentTerms: !!(s.commercial && s.commercial.paymentTerms) })), []);
  const state = (mgr) => { try { const p = mgr.peek(tenant); const s = p && p.session; return !!(s && typeof s.isConnected === 'function' && s.isConnected()); } catch (e) { return false; } };
  const channels = { WHATSAPP: state(require('../adapters/whatsappManager')), TELEGRAM: state(require('../adapters/telegramManager')), WEB: true };
  const settings = await safe(() => require('./autoResponder').getSettings(tenant), {});
  const search = await safe(() => require('../lib/ai/llmFallbackEngine').isSearchAvailable(), false);
  const contacts = await safe(async () => (await require('./contactCrm').counts(tenant)) || {}, {});
  const life = await safe(() => require('./customerLifecycle').snapshot(tenant), { orders: [], cases: [], followUps: [] });
  return {
    domains, agents, services, channels,
    autoReply: { whatsapp: !!(settings && settings.whatsapp), telegram: !!(settings && settings.telegram) },
    followUpsAuthorized: (settings && settings.followUps === true) || process.env.FOLLOWUPS_ENABLED === 'true',
    webSearch: !!search,
    hourlyClientLimit: Number(process.env.CLIENT_AI_LIMIT_PER_HOUR) || 10,
    data: { contacts: contacts.total || 0, orders: life.orders.length, openCases: life.cases.filter((c) => c.status !== 'RESOLVED').length, followUps: life.followUps.length },
  };
}

// Peux-tu … ? → réponse vérifiée sur l'état réel : { can, because, missing[] }.
async function canDo(tenant, topic) {
  const cap = await capabilities(tenant); const t = String(topic || '').toLowerCase();
  const dom = (id) => cap.domains.find((d) => d.id === id);
  const anyChannel = cap.channels.WHATSAPP || cap.channels.TELEGRAM;
  const activeSvc = cap.services.filter((s) => s.lifecycle === 'active');
  const r = (can, because, missing) => ({ can, because, missing: missing || [] });
  if (/relanc|suivi|follow/.test(t)) {
    const miss = []; if (!dom('followups').available) miss.push('outil de relance'); if (!anyChannel) miss.push('un canal connecté (WhatsApp ou Telegram)'); if (!cap.followUpsAuthorized) miss.push('votre autorisation d\'envoyer des relances automatiques (sinon je prépare et vous validez)');
    return r(!miss.length, miss.length ? 'Je peux préparer et planifier des relances, mais pas encore les envoyer seul.' : 'Je peux relancer : je revérifie chaque relance avant de l\'envoyer.', miss);
  }
  if (/sav|apr[èe]s[- ]vente|r[ée]clamation/.test(t)) {
    const miss = []; if (!activeSvc.some((s) => s.supportRules)) miss.push('vos règles SAV dans un Service métier'); if (!anyChannel) miss.push('un canal connecté');
    return r(dom('sav').available && !miss.length, miss.length ? 'Je peux ouvrir et suivre des dossiers SAV, mais je manque de règles pour répondre seul.' : 'Je peux gérer votre SAV avec vos règles.', miss);
  }
  if (/groupe/.test(t)) {
    const g = cap.services.reduce((n, s) => n + s.groups, 0); const miss = []; if (!anyChannel) miss.push('un canal connecté');
    return r(anyChannel && dom('groups').available, g ? `${g} groupe(s) sont déjà liés à vos services.` : 'Aucun groupe n\'est encore lié à un service : je vérifie que je suis administrateur avant de le lier.', miss);
  }
  if (/campagne|diffus|envoi/.test(t)) { const miss = []; if (!anyChannel) miss.push('un canal connecté'); return r(dom('campaigns').available && anyChannel, 'Je prépare le brouillon, vous validez, puis j\'envoie avec la cadence de sécurité.', miss); }
  if (/recherche|internet|web/.test(t)) return r(cap.webSearch, cap.webSearch ? 'Je peux faire une recherche externe et vous citer les sources.' : 'La recherche externe n\'est pas disponible en ce moment : je vous le dirai au lieu d\'inventer.', cap.webSearch ? [] : ['recherche externe indisponible']);
  if (/vend|commande|client/.test(t)) { const miss = []; if (!activeSvc.length) miss.push('un Service métier actif'); if (!anyChannel) miss.push('un canal connecté'); return r(!miss.length, miss.length ? 'Il me manque de quoi présenter votre offre.' : 'Je peux présenter votre offre et répondre aux clients d\'après votre fiche.', miss); }
  return r(false, 'Je n\'ai pas de fonction vérifiée qui correspond exactement à cette demande : je préfère vous le dire plutôt que de promettre.', []);
}

// Ce que je ne peux PAS faire (réel, jamais gonflé).
async function limits(tenant) {
  const cap = await capabilities(tenant); const out = [];
  if (!cap.channels.WHATSAPP) out.push('Votre WhatsApp n\'est pas connecté : je ne peux pas y envoyer ni répondre.');
  if (!cap.channels.TELEGRAM) out.push('Votre Telegram n\'est pas connecté.');
  if (!cap.services.length) out.push('Je n\'ai aucun Service métier : je ne connais pas vos produits ni vos prix, donc je ne les cite pas.');
  if (!cap.followUpsAuthorized) out.push('Les relances automatiques ne sont pas autorisées : je les prépare, vous les validez.');
  if (!cap.webSearch) out.push('Je n\'ai pas de recherche Internet disponible en ce moment.');
  out.push('Je ne promets jamais un prix, un délai, un résultat ou une garantie que vous ne m\'avez pas donnés.', `Avec un même client, je limite mes réponses automatiques à ${cap.hourlyClientLimit} échanges par heure, puis je vous passe la main.`, 'Je ne modifie pas mon propre code ni mes permissions : un changement technique vous est toujours proposé pour validation.');
  return out;
}

const SECTOR = [
  { re: /form|cours|acad[ée]mie|[ée]cole|enseign|coach/i, id: 'formation', need: 'faire connaître votre formation et accompagner vos apprenants', does: ['répondre aux questions des futurs inscrits', 'accompagner les apprenants avec vos supports', 'relancer ceux qui hésitent'], example: 'un prospect demande le programme : je réponds d\'après votre fiche, puis je propose l\'inscription', benefit: 'vous gardez du temps pour enseigner' },
  { re: /restau|traiteur|snack|caf[ée]|cuisine|repas|livraison de repas|pizz/i, id: 'restaurant', need: 'prendre les commandes et les réservations sans rater un message', does: ['présenter votre carte et vos prix', 'prendre les commandes', 'suivre la livraison et demander si tout s\'est bien passé'], example: 'un client écrit « je veux 2 menus » : je récapitule la commande et je la confirme avec vous', benefit: 'moins de commandes perdues' },
  { re: /boutique|commerce|magasin|vente|vendre|mode|v[êe]tement|e-?commerce|en ligne|produits?/i, id: 'commerce', need: 'répondre vite aux acheteurs et suivre chaque commande', does: ['présenter vos produits et vos prix', 'enregistrer les commandes', 'suivre paiement et livraison, puis relancer'], example: 'un client demande « il reste en taille M ? » : je réponds d\'après votre catalogue et je propose de commander', benefit: 'plus de ventes conclues, moins de messages sans réponse' },
  { re: /prestation|service|artisan|r[ée]paration|conseil|consult|freelance|agence|coiffure|beaut[ée]|m[ée]nage|plomb|[ée]lectric/i, id: 'prestation', need: 'transformer les demandes en rendez-vous ou en devis', does: ['répondre aux demandes de prestation', 'proposer un rendez-vous ou un devis', 'faire le suivi après la prestation'], example: 'un client demande un rendez-vous : je note son besoin et je vous le transmets avec un résumé', benefit: 'aucune demande ne se perd' },
];
function sectorOf(text) { const t = String(text || ''); return SECTOR.find((s) => s.re.test(t)) || null; }

const ASK_ACTIVITY = "Pour mieux vous aider, dites-moi d'abord votre activité : que vendez-vous ou quel service proposez-vous, et à qui ? Dès que je le sais, je m'adapte et je vous montre concrètement ce que je peux faire pour vous.";

// Présentation à la première personne ; structure BESOIN → CE QUE JE PEUX FAIRE → EXEMPLE → BÉNÉFICE → PROCHAINE ÉTAPE.
async function introduce(tenant, opts) {
  const o = opts || {}; const cap = await capabilities(tenant);
  const activity = o.activity || (cap.services.find((s) => s.lifecycle === 'active') || {}).name || null;
  if (!activity) return { known: false, text: ASK_ACTIVITY };
  const sector = sectorOf(`${o.activity || ''} ${cap.services.map((s) => `${s.name} ${s.type}`).join(' ')}`);
  const avail = (id) => (cap.domains.find((d) => d.id === id) || {}).available;
  // Uniquement des capacités RÉELLEMENT disponibles (outil présent) — jamais une promesse sur une fonction absente.
  const does = (sector ? sector.does : ['répondre à vos clients d\'après vos informations', 'suivre vos demandes', 'vous faire un point clair'])
    .filter((d) => !(/relanc|suivre/.test(d) && !avail('followups')));
  const missing = []; if (!cap.channels.WHATSAPP && !cap.channels.TELEGRAM) missing.push('connecter votre WhatsApp ou votre Telegram');
  if (!cap.services.length) missing.push('me décrire votre offre (Service métier)');
  const next = missing.length ? `Pour commencer : ${missing.join(', puis ')}. Voulez-vous que je vous guide pas à pas ?` : 'Souhaitez-vous que je vous explique, que je vous guide, ou que je le fasse pour vous ?';
  const text = [
    `Je suis Cyrus, votre assistant${sector ? '' : ' d\'activité'}. D'après ce que vous m'avez dit (${activity}) :`,
    `**Votre besoin** — ${sector ? sector.need : 'répondre plus vite à vos clients et ne rien laisser passer'}.`,
    `**Ce que je peux faire** — ${does.join(' ; ')}.`,
    `**Exemple** — ${sector ? sector.example : 'un client vous écrit : je réponds d\'après votre fiche, et je vous passe la main pour ce que je ne sais pas'}.`,
    `**Bénéfice** — ${sector ? sector.benefit : 'moins de temps perdu et plus de clients bien suivis'}.`,
    `**Prochaine étape** — ${next}`,
  ].join('\n');
  return { known: true, sector: sector ? sector.id : null, text };
}

// Les trois modes.
const MODES = {
  explain: { id: 'EXPLAIN', label: 'EXPLIQUE-MOI', re: /\b(explique|expliquer|comment (?:ça|ca) marche|c'est quoi|qu'est[- ]ce que|comprendre)\b/i },
  guide: { id: 'GUIDE', label: 'GUIDE-MOI', re: /\b(guide(?:z)?[- ]moi|guider|pas (?:à|a) pas|accompagne[- ]moi|aide[- ]moi (?:à|a) (?:configurer|mettre)|étape par étape|etape par etape)\b/i },
  do: { id: 'DO', label: 'FAIS-LE', re: /\b(fais[- ]le|fait[- ]le|fais[- ]moi ça|occupe[- ]toi de|je te laisse|fais-le pour moi)\b/i },
};
function detectMode(text) { const t = String(text || ''); for (const k of ['guide', 'do', 'explain']) if (MODES[k].re.test(t)) return MODES[k].id; return null; }

// Questions d'auto-connaissance (« que peux-tu faire ? », « quels agents ? », « quels services actifs ? »…) → réponse construite sur les registres réels.
const SELF_RE = /(?:^|\b)(?:qui es[- ]tu|pr[ée]sente[- ]toi|que (?:peux|sais)[- ]tu faire|qu'est[- ]ce que tu (?:peux|sais) faire|quels? (?:sont )?(?:tes|les) (?:outils|fonctions|fonctionnalit[ée]s|capacit[ée]s|agents|services|modules)|quels? (?:agents|outils|services)|que ne peux[- ]tu pas|quelles? sont tes limites|tes limites|comment (?:tu )?(?:t')?am[ée]liores?|peux[- ]tu (?:relancer|g[ée]rer|utiliser|faire|vendre|r[ée]pondre))/i;
function isSelfQuestion(text) { return SELF_RE.test(String(text || '')); }

async function answer(tenant, question) {
  const q = String(question || ''); const cap = await capabilities(tenant);
  if (/que ne peux[- ]tu pas|limites/i.test(q)) return { kind: 'limits', text: 'Voici mes limites réelles aujourd\'hui :\n- ' + (await limits(tenant)).join('\n- ') };
  if (/quels? (?:sont )?(?:tes |les )?agents/i.test(q)) return { kind: 'agents', text: cap.agents.total ? `J'ai ${cap.agents.total} spécialistes à ma disposition (${cap.agents.divisions} domaines : marketing, vente, support, stratégie, analyse…). Je m'en sers en coulisse pour préparer mes réponses et mes analyses ; c'est toujours moi qui vous réponds, et ils ne peuvent rien envoyer ni modifier seuls.` : 'Je n\'ai aucun spécialiste chargé pour le moment.' };
  if (/quels? (?:sont )?(?:tes |les |mes )?services/i.test(q)) {
    const act = cap.services.filter((s) => s.lifecycle === 'active');
    return { kind: 'services', text: act.length ? `Services métiers actifs pour votre compte : ${act.map((s) => `${s.name}${s.products ? ` (${s.products} produit(s))` : ''}`).join(', ')}.` : 'Je n\'ai aucun Service métier actif : décrivez-moi votre activité et je le crée avec vous.' };
  }
  if (/quels? (?:sont )?(?:tes |les )?(?:outils|fonctions|fonctionnalit|capacit|modules)|que (?:peux|sais)[- ]tu faire|qu'est[- ]ce que tu (?:peux|sais) faire/i.test(q)) {
    const lines = cap.domains.filter((d) => d.available).map((d) => `- ${d.label}`);
    return { kind: 'capabilities', text: `Voici ce que je peux faire pour vous aujourd'hui :\n${lines.join('\n')}\n${OWNER_ONLY_NOTE}` };
  }
  if (/comment (?:tu )?(?:t')?am[ée]liores?/i.test(q)) return { kind: 'improve', text: 'Je regarde ce qui s\'est réellement passé (conversations, relances, dossiers), je repère ce qui coince, et je vous propose une amélioration. Ce qui est sans risque et que vous avez autorisé, je l\'applique et je mesure le résultat ; tout changement technique ou sensible, je vous le propose seulement — je ne me modifie jamais seul.' };
  const m = q.match(/peux[- ]tu\s+(.+?)\s*\??$/i);
  if (m) { const r = await canDo(tenant, m[1]); return { kind: 'canDo', can: r.can, text: `${r.can ? 'Oui. ' : 'Pas encore. '}${r.because}${r.missing.length ? ' Il me manque : ' + r.missing.join(', ') + '.' : ''}` }; }
  if (/qui es[- ]tu|pr[ée]sente[- ]toi/i.test(q)) { const i = await introduce(tenant); return { kind: 'intro', text: i.text }; }
  return { kind: 'unknown', text: 'Je peux vous dire ce que je sais faire, mes limites, mes spécialistes ou vos services actifs. Que voulez-vous savoir ?' };
}

// Contrôle de style : la présentation de soi ne doit jamais parler de Cyrus à la 3e personne.
const THIRD_PERSON_RE = /\bCyrus\s+(?:est|peut|permet|fait|sait|va|vous|automatise|g[èe]re)\b/i;
const isFirstPerson = (text) => !THIRD_PERSON_RE.test(String(text || ''));

module.exports = { DOMAINS, capabilities, canDo, limits, introduce, answer, detectMode, isSelfQuestion, sectorOf, isFirstPerson, ASK_ACTIVITY, MODES };
