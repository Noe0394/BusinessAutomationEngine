// SÉLECTION DES SPÉCIALISTES — ai-engine/agents/specialistSelector.js
// ---------------------------------------------------------------------------
// Le Service Orchestrateur détermine D'ABORD les CAPACITÉS nécessaires à partir du CONTEXTE GLOBAL (qui parle, canal, intention et
// intentions secondaires, étape de la conversation, service métier concerné, médias joints, complexité de la demande), puis choisit les
// spécialistes du registre qui les couvrent. Ce n'est pas une table « mot-clé → agent » :
//   1. inferNeeds() : combine plusieurs signaux pondérés (jamais un mot isolé) en un profil de besoins {capacité → poids} ;
//   2. scoring    : capacités de l'agent × besoins + recouvrement sémantique avec sa description + recommandation du Service métier ;
//   3. filtres    : statut actif, audience (un client ne mobilise que des spécialistes vente/support), plateforme, niveau de risque ;
//   4. arbitrage IA (demandes du propriétaire ambiguës/complexes) : l'IA choisit PARMI la présélection uniquement (jamais hors registre),
//      via l'AI Gateway ; sans IA, repli déterministe sur le classement.
// Aucun spécialiste n'est appelé pour une salutation, une conversation privée, un remerciement, un refus, un contexte sensible ou un
// paiement (logique paiement existante) : « spécialiste uniquement si nécessaire ».
const registry = require('./agentRegistry');

const STOP = new Set('le la les un une des du de d l et ou à a au aux en dans sur pour par avec sans que qui quoi est sont ce cet cette ces mon ma mes ton ta tes son sa ses notre votre leur je tu il elle nous vous ils elles me te se ne pas plus très the of to and for with this that from you your'.split(' '));
const tokens = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t.length > 2 && !STOP.has(t));

// Étapes qui ne justifient aucun spécialiste côté client.
const NO_SPECIALIST_INTENTS = new Set(['GREETING', 'THANKS', 'UNKNOWN', 'CONFIRMATION', 'STOP', 'REFUSAL', 'DISINTEREST', 'CANCELLATION', 'PAYMENT_INTENT']);

function add(needs, cap, w) { needs[cap] = Math.min(1, (needs[cap] || 0) + w); }

// Besoins d'une CONVERSATION CLIENT (audience CUSTOMER) : intention + intentions secondaires + étape + sujets abordés.
function customerNeeds(ctx) {
  const needs = {};
  const cls = ctx.cls || {}; const flags = cls.flags || {}; const state = String(ctx.state || 'NEW');
  const intents = new Set([cls.intent].concat(cls.intents || []).filter(Boolean));
  if (flags.sensitive || flags.smalltalk) return needs;
  if (cls.intent && NO_SPECIALIST_INTENTS.has(cls.intent) && ![...intents].some((i) => ['PURCHASE_INTENT', 'OBJECTION', 'PRICE_OBJECTION', 'QUESTION'].includes(i))) return needs;
  if ((intents.has('PAYMENT_INTENT') || (flags.topics || []).includes('payment')) && !intents.has('OBJECTION') && !intents.has('PRICE_OBJECTION')) return needs; // paiement : logique existante
  const topics = flags.topics || [];
  if (intents.has('PURCHASE_INTENT')) { add(needs, 'sales.closing', 0.9); add(needs, 'sales.qualification', 0.2); }
  if (intents.has('OBJECTION') || intents.has('PRICE_OBJECTION')) { add(needs, 'sales.objection', 0.9); if (intents.has('PRICE_OBJECTION') || topics.includes('price')) add(needs, 'sales.negotiation', 0.5); }
  if (intents.has('INTEREST') || intents.has('REQUEST_INFORMATION') || intents.has('REQUEST_MORE_INFORMATION')) { add(needs, 'sales.discovery', 0.7); add(needs, 'sales.qualification', 0.3); }
  if (intents.has('QUESTION') && topics.some((t) => t !== 'location')) { add(needs, 'sales.discovery', 0.5); if (topics.includes('certificate') || topics.includes('advantages')) add(needs, 'sales.objection', 0.2); }
  if (intents.has('HESITATION') || intents.has('LATER')) { add(needs, 'sales.objection', 0.5); add(needs, 'sales.closing', 0.3); }
  if (intents.has('COMPLAINT') || intents.has('SUPPORT')) add(needs, 'support.customer', 0.9);
  // Étape du parcours : elle nuance le besoin (un prospect déjà intéressé qui pose une question est proche du closing).
  if (state === 'INTERESTED' && Object.keys(needs).length) add(needs, 'sales.closing', 0.25);
  if (state === 'OBJECTION' || state === 'NEGOTIATION') { add(needs, 'sales.objection', 0.3); add(needs, 'sales.negotiation', 0.3); }
  if (state === 'SUPPORT' || state === 'COMPLAINT') add(needs, 'support.customer', 0.4);
  return needs;
}

const MEDIA_MARK = /PIÈCES JOINTES|Image «|Vidéo «|Message audio «|Document PDF «|Document Word «|Tableur «/;
function mediaKindsOf(text, given) {
  const kinds = new Set(given || []);
  const t = String(text || '');
  if (/Image «/.test(t)) kinds.add('image'); if (/Vidéo «/.test(t)) kinds.add('video'); if (/Message audio «/.test(t)) kinds.add('audio');
  if (/Document (PDF|Word) «/.test(t)) kinds.add('document'); if (/Tableur «/.test(t)) kinds.add('spreadsheet');
  return [...kinds];
}

// Besoins d'une DEMANDE DU PROPRIÉTAIRE : plusieurs familles de signaux (action demandée × objet visé × médias joints × longueur).
const OWNER_SIGNALS = [
  // [regex, { capacité: poids }]
  [/(?:analys|examin|regarde|evalu|decrypt)\w*[^.?!]{0,60}(?:conversation|discussion|echange|dialogue|messages?)/i, { 'analysis.conversation': 0.8, 'sales.qualification': 0.4 }],
  [/(?:est[- ](?:il|elle)|sont[- ]ils)\s+(?:vraiment\s+)?int[ée]ress|potentiel (?:client|acheteur)|prospect chaud|va[- ]t[- ]il acheter/i, { 'sales.qualification': 0.8, 'analysis.conversation': 0.5 }],
  [/(?:analys|decortiqu|comprend)\w*[^.?!]{0,50}(?:publicit|\bpub\b|annonce|ad\b|creative|campagne)|pourquoi (?:cette|la) (?:pub|publicit|campagne)/i, { 'marketing.campaign': 0.8, 'marketing.strategy': 0.5, 'analysis.data': 0.3 }],
  [/(?:campagne|diffus|ciblage|audience|budget pub|facebook ads|meta ads)/i, { 'marketing.campaign': 0.6 }],
  [/(?:strat[ée]gie|plan d.action|feuille de route|positionnement|go.to.market|lancer (?:une|mon|ma))/i, { 'strategy.business': 0.6, 'marketing.strategy': 0.5 }],
  [/(?:closing|conclure la vente|finaliser la vente|pousser (?:a|à) l.achat)/i, { 'sales.closing': 0.8 }],
  [/(?:objection|il h[ée]site|trop cher|elle h[ée]site|pas convaincu)/i, { 'sales.objection': 0.8, 'sales.negotiation': 0.4 }],
  [/(?:n[ée]gocier|n[ée]gociation|remise|rabais|contre.?offre)/i, { 'sales.negotiation': 0.8 }],
  [/(?:suivi commercial|relance|relancer|nurturing|pipeline)/i, { 'sales.pipeline': 0.5, 'sales.outreach': 0.4, 'sales.closing': 0.3 }],
  [/(?:r[ée]dige|[ée]cris|cr[ée]e|propose)[^.?!]{0,40}(?:post|contenu|texte|article|accroche|script|newsletter|legende|caption)/i, { 'marketing.content': 0.8 }],
  [/(?:s[ée]curit[ée]|faille|vuln[ée]rabilit|piratage|attaque|audit de s[ée]cu)/i, { 'security.review': 0.8 }],
  [/(?:contrat|clause|juridique|conform|rgpd|mentions l[ée]gales)/i, { 'legal.compliance': 0.7, 'document.analysis': 0.4 }],
  [/(?:r[ée]sume|synth[èe]se|analyse)[^.?!]{0,30}(?:document|pdf|fichier|rapport|contrat)/i, { 'document.analysis': 0.7 }],
  [/(?:code|bug|api|serveur|base de donn[ée]es|d[ée]ploiement|technique|architecture|script)/i, { engineering: 0.5 }],
  [/(?:budget|tr[ée]sorerie|rentabilit|marge|pr[ée]vision financi|comptab)/i, { finance: 0.6, 'strategy.pricing': 0.3 }],
  [/(?:prix|tarif)[^.?!]{0,30}(?:strat[ée]g|optimis|fixer|d[ée]finir|analyser)/i, { 'strategy.pricing': 0.7 }],
  [/(?:traduis|traduction|translate|en (?:anglais|arabe|espagnol|portugais))/i, { 'language.translation': 0.7 }],
  [/(?:seo|r[ée]f[ée]rencement|mots.cl[ée]s)/i, { 'marketing.seo': 0.7 }],
  [/(?:r[ée]seaux sociaux|instagram|tiktok|linkedin|facebook)[^.?!]{0,40}(?:strat|calendrier|contenu|plan)/i, { 'marketing.social': 0.7 }],
];
function ownerNeeds(ctx) {
  const needs = {};
  const text = String(ctx.text || '');
  const plain = text.split(/PIÈCES JOINTES reçues dans ce message/)[0]; // la consigne de l'utilisateur, pas le contenu des fichiers
  for (const [re, caps] of OWNER_SIGNALS) if (re.test(plain)) for (const [c, w] of Object.entries(caps)) add(needs, c, w);
  const kinds = mediaKindsOf(text, ctx.mediaKinds);
  const asks = /(?:analys|explique|comprend|d[ée]cortique|regarde|[ée]valu|que (?:penses|dis)[- ]tu|utilise|exploite)/i.test(plain);
  if (kinds.includes('image') && asks) add(needs, 'vision', 0.5);
  if (kinds.includes('audio') && asks) add(needs, 'audio', 0.4);
  if (kinds.includes('video') && asks) add(needs, 'video', 0.5);
  if (kinds.includes('document') && asks) add(needs, 'document.analysis', 0.5);
  // Une demande de fond (longue, plusieurs objectifs) est un besoin de stratégie même sans signal explicite.
  if (plain.length > 350 && Object.keys(needs).length) add(needs, 'strategy.business', 0.2);
  return needs;
}

function inferNeeds(ctx) { return String(ctx.audience).toUpperCase() === 'CUSTOMER' ? customerNeeds(ctx) : ownerNeeds(ctx); }

function lexical(agent, qTokens) {
  if (!qTokens.length) return 0;
  const desc = new Set(tokens(`${agent.name} ${agent.description}`));
  let hit = 0; for (const t of qTokens) if (desc.has(t)) hit += 1;
  return Math.min(0.5, hit / Math.max(6, qTokens.length) * 1.5);
}

// Divisions « verrouillées » : un agent d'ingénierie/sécurité/jeu/SIG… n'est pertinent que si le contexte exprime un besoin de SA famille
// (sinon il capte à tort des demandes non techniques parce que sa description cite « conversation » ou « security »).
const LOCKED_DIVISIONS = { engineering: ['engineering'], testing: ['testing', 'engineering'], security: ['security'], 'game-development': ['game'], gis: ['gis'], 'spatial-computing': ['spatial'], healthcare: ['healthcare'], finance: ['finance'], academic: ['research'] };
function lockedPenalty(agent, needs) {
  const fams = LOCKED_DIVISIONS[agent.division];
  if (!fams) return 1;
  return Object.keys(needs).some((c) => fams.includes(c.split('.')[0])) ? 1 : 0.25;
}

function scoreAgent(agent, needs, qTokens, ctx) {
  let s = 0; const matched = [];
  for (const [cap, w] of Object.entries(needs)) {
    if (agent.capabilities.includes(cap)) { s += w * 1.0; matched.push(cap); }
    else if (agent.capabilities.includes(cap.split('.')[0]) && cap.includes('.')) { s += w * 0.35; matched.push(cap.split('.')[0]); }
  }
  if (!matched.length) return { score: 0, matched };
  s += lexical(agent, qTokens);
  if (ctx.service && Array.isArray(ctx.service.recommendedSpecialists) && ctx.service.recommendedSpecialists.includes(agent.agentId)) s += 0.5;
  // Les agents spécialisés sur UNE compétence précise l'emportent sur les généralistes qui ont tout un peu.
  s += matched.length > 0 ? Math.max(0, 0.12 - agent.capabilities.length * 0.004) : 0;
  s *= lockedPenalty(agent, needs);
  return { score: Math.round(s * 1000) / 1000, matched };
}

const MIN_SCORE = 0.55;
async function shortlist(ctx, needs, limit) {
  const audience = String(ctx.audience).toUpperCase();
  const qTokens = tokens(String(ctx.text || '').split(/PIÈCES JOINTES reçues/)[0]).slice(0, 40);
  const out = [];
  for (const a of registry.all()) {
    if (!a.audiences.includes(audience)) continue;
    if (a.riskLevel === 'HIGH' && !(ctx.allowHighRisk === true && audience === 'OWNER')) continue;
    if (audience !== 'CUSTOMER' && ctx.channel && !a.platforms.includes(String(ctx.channel).toUpperCase()) && !a.platforms.includes('WEB')) continue;
    if ((await registry.statusOf(a.agentId, ctx.tenant)) !== 'active') continue;
    const r = scoreAgent(a, needs, qTokens, ctx);
    if (r.score >= MIN_SCORE) out.push({ agentId: a.agentId, name: a.name, description: a.description, score: r.score, matched: r.matched, capabilities: a.capabilities });
  }
  out.sort((x, y) => y.score - x.score || x.agentId.localeCompare(y.agentId));
  return out.slice(0, limit || 8);
}

// Diversité : pour plusieurs spécialistes, on prend le meilleur de chaque famille de besoin (pas trois variantes du même métier).
function diversify(list, max, needs) {
  // Pour chaque famille de besoin (par poids décroissant) : le meilleur candidat qui la couvre et n'est pas déjà retenu.
  const famWeight = {};
  for (const [c, w] of Object.entries(needs || {})) { const f = c.split('.')[0]; famWeight[f] = Math.max(famWeight[f] || 0, w); }
  const order = Object.entries(famWeight).sort((a, b) => b[1] - a[1]).map(([f]) => f);
  const picked = [];
  for (const fam of order) {
    if (picked.length >= max) break;
    const best = list.find((c) => !picked.includes(c) && c.capabilities.some((x) => x === fam || x.startsWith(fam + '.')) && c.score >= MIN_SCORE);
    if (best) picked.push(best);
  }
  if (!picked.length && list.length) picked.push(list[0]);
  return picked;
}

function extractJson(raw) {
  const s = String(raw || ''); const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

// ctx : { audience:'CUSTOMER'|'OWNER', tenant, channel, text, cls?, state?, mediaKinds?, service?, allowHighRisk?, useAI?, llm? }
async function select(ctx) {
  const audience = String(ctx.audience || 'OWNER').toUpperCase();
  const needs = inferNeeds(Object.assign({}, ctx, { audience }));
  if (!Object.keys(needs).length) return { agents: [], mode: 'none', method: 'none', needs, reason: 'AUCUN_BESOIN_DE_SPECIALISTE' };
  const cand = await shortlist(Object.assign({}, ctx, { audience }), needs, 30);
  if (!cand.length) return { agents: [], mode: 'none', method: 'none', needs, reason: 'AUCUN_SPECIALISTE_ADAPTE' };
  const families = new Set(Object.entries(needs).filter(([, w]) => w >= 0.5).map(([c]) => c.split('.')[0]));
  const maxAgents = audience === 'CUSTOMER' ? 1 : Math.min(3, Math.max(1, families.size));
  let chosen = diversify(cand, maxAgents, needs);
  let method = 'contextual-scoring'; let mode = chosen.length > 1 ? 'sequential' : 'single';
  // Arbitrage IA (propriétaire uniquement, quand le choix est réellement ambigu) : parmi la présélection, jamais hors registre.
  const ambiguous = audience === 'OWNER' && ctx.useAI !== false && cand.length >= 3 && (cand[0].score - cand[Math.min(2, cand.length - 1)].score) < 0.35;
  if (ambiguous) {
    try {
      const cards = cand.slice(0, 10).map((c) => `- ${c.agentId} : ${c.name} — ${String(c.description).slice(0, 150)}`).join('\n');
      const prompt = [
        'Tu es le Service Orchestrateur de Cyrus. Choisis, PARMI cette liste UNIQUEMENT, le ou les spécialistes les plus utiles pour la demande (1 à 3 maximum, complémentaires, jamais deux du même métier).',
        cards,
        `Demande du propriétaire (extrait) : "${String(ctx.text || '').split(/PIÈCES JOINTES reçues/)[0].slice(0, 500)}"`,
        `Besoins déduits du contexte : ${Object.entries(needs).map(([c, w]) => `${c}(${w.toFixed(1)})`).join(', ')}.`,
        'Réponds UNIQUEMENT en JSON : {"agents":[{"id":"...","why":"..."}],"mode":"single|sequential|parallel"}',
      ].join('\n');
      const gen = ctx.llm || ((p) => require('../../lib/ai/llmFallbackEngine').generateAIResponse(p, [], null, undefined, null, { purpose: 'specialist_selection', tier: 'standard', tenant: ctx.tenant, maxTokens: 300 }).then((r) => r.text));
      const parsed = extractJson(await gen(prompt));
      const byId = new Map(cand.slice(0, 10).map((c) => [c.agentId, c]));
      const picks = ((parsed && parsed.agents) || []).map((x) => byId.get(x && x.id)).filter(Boolean);
      if (picks.length) { chosen = [...new Set(picks)].slice(0, maxAgents); method = 'ai-arbitration'; if (parsed.mode === 'parallel' || parsed.mode === 'sequential') mode = chosen.length > 1 ? parsed.mode : 'single'; }
    } catch (e) { /* repli déterministe : jamais bloquant */ }
  }
  return { agents: chosen.map((c) => ({ agentId: c.agentId, name: c.name, score: c.score, why: `capacités : ${c.matched.join(', ')}` })), mode, method, needs, reason: 'OK' };
}

module.exports = { select, inferNeeds, shortlist, mediaKindsOf, tokens, MIN_SCORE, MEDIA_MARK };
