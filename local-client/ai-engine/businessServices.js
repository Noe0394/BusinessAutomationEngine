const storageAdapter = require('./storageAdapter');
const secretVault = require('./secretVault');

// SERVICES MÉTIERS — ai-engine/businessServices.js
// ---------------------------------------------------------------------------
// Registre PAR TENANT des services professionnels de l'utilisateur (projets,
// produits, plateformes, comptes, APIs, permissions, règles commerciales,
// objectifs). C'est la source structurée et contrôlable que l'onglet
// "Services Métiers" (public/dashboard.html) gère et que l'intelligence de
// Cyrus exploite — DISTINCTE de la mémoire sélective.
//
// Les secrets (clés API) ne sont PAS stockés ici : seul un `apiKeyRef` pointe
// vers le coffre chiffré (ai-engine/secretVault.js). L'intelligence reçoit les
// CAPACITÉS et le contexte commercial (getEngineContext), jamais les secrets.
//
// Lien mémoire (NB utilisateur) : à chaque création/mise à jour, les infos
// commerciales sont miroitées dans le profil business persistant
// (business_profiles) que le moteur de closing/campagne lit déjà — Cyrus y
// puise donc pour vendre et closer.

const NAMESPACE = 'business_services';
const PROFILE_NAMESPACE = 'business_profiles';

const STATUS = { DRAFT: 'DRAFT', CONFIGURED: 'CONFIGURED', CONNECTED: 'CONNECTED', ERROR: 'ERROR', DISCONNECTED: 'DISCONNECTED' };

function sanitize(id) { return String(id || '').trim().replace(/[^A-Za-z0-9_-]/g, '_') || 'default'; }
function uid() { return 'svc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

async function load(tenant) {
  return storageAdapter.get(NAMESPACE, sanitize(tenant), { tenant: sanitize(tenant), services: [] });
}
function save(tenant, doc) {
  doc.updatedAt = new Date().toISOString();
  return storageAdapter.set(NAMESPACE, sanitize(tenant), doc);
}
function findIdx(doc, id) { return (doc.services || []).findIndex((s) => s.id === id); }

function publicView(s) {
  // Vue renvoyée à l'UI : jamais de secret, seulement la PRÉSENCE d'une clé.
  const conn = s.connection || {};
  return Object.assign({}, s, {
    connection: {
      kind: conn.kind || 'none',
      connectorType: conn.connectorType || null,
      baseUrl: conn.baseUrl || null,
      authHeader: conn.authHeader || null,
      endpoints: conn.endpoints || null,
      hasKey: !!conn.apiKeyRef,
    },
  });
}

async function list(tenant) {
  const doc = await load(tenant);
  return (doc.services || []).map(publicView);
}
async function get(tenant, id) {
  const doc = await load(tenant);
  const s = (doc.services || []).find((x) => x.id === id);
  return s ? publicView(s) : null;
}

function normalizeService(data) {
  const d = data || {};
  const conn = d.connection || {};
  return {
    id: d.id || uid(),
    name: String(d.name || 'Service sans nom').slice(0, 120),
    type: d.type || 'autre',
    project: d.project || null,
    connection: {
      kind: conn.kind || 'none', // 'api' | 'account' | 'none'
      connectorType: conn.connectorType || null, // platform_gateway | systemio | accounting | generic
      baseUrl: conn.baseUrl || null,
      authHeader: conn.authHeader || 'X-API-Key',
      endpoints: conn.endpoints || null,
      apiKeyRef: conn.apiKeyRef || null,
    },
    scopes: Array.isArray(d.scopes) ? d.scopes : [],
    commercial: Object.assign({
      // MÉMOIRE MÉTIER EN TEXTE LIBRE (refonte 2026-09-23, demande utilisateur) : source PRINCIPALE côté
      // utilisateur — il peut coller ici tout ce qui concerne son activité (nom, produits, prix, promos,
      // horaires, dates, règles, livraison, FAQ, moyens de paiement...) sans jamais avoir à remplir les champs
      // structurés un par un. Conservée VERBATIM (jamais perdue, même si l'extraction automatique ci-dessous
      // rate une nuance) et injectée telle quelle dans le contexte IA (voir renderService) — les champs structurés
      // ci-dessous restent une INDEXATION dérivée pour la recherche rapide, pas la seule source de vérité.
      memo: '',
      price: null, promoPrice: null, currency: 'FCFA', description: '', advantages: '',
      objections: '', responses: '', paymentTerms: '', accessTerms: '', target: '',
      // Champs de pilotage de la conversation commerciale (tous facultatifs, jamais inventés) :
      audience: '', period: '', source: '', initialMessage: '', closing: '', escalation: '', knowledge: '', supportRules: '',
    }, d.commercial || {}),
    // Spécialistes recommandés pour ce service (identifiants du registre d'agents) et cycle de vie : active | paused | disabled.
    specialists: Array.isArray(d.specialists) ? d.specialists.map(String).slice(0, 8) : [],
    lifecycle: ['active', 'paused', 'disabled'].includes(d.lifecycle) ? d.lifecycle : 'active',
    products: Array.isArray(d.products) ? d.products : [],
    rules: Array.isArray(d.rules) ? d.rules : [],
    objectives: Array.isArray(d.objectives) ? d.objectives : [],
    capabilities: Array.isArray(d.capabilities) ? d.capabilities : [],
    // Campagnes d'entrée (Facebook Ads…) rattachées à ce service : voir ai-engine/adCampaigns.js.
    adCampaigns: Array.isArray(d.adCampaigns) ? d.adCampaigns : [],
    // Groupes (WhatsApp/Telegram) liés à ce service APRÈS vérification réelle (groupe existant, compte connecté, statut admin) : voir toolsExtra#linkServiceGroup.
    groups: Array.isArray(d.groups) ? d.groups.slice(0, 50) : [],
    status: d.status || STATUS.DRAFT,
    lastTest: d.lastTest || null,
    history: Array.isArray(d.history) ? d.history : [],
    createdAt: d.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function addHistory(service, event) {
  service.history = Array.isArray(service.history) ? service.history : [];
  service.history.push({ at: new Date().toISOString(), event });
  service.history = service.history.slice(-100);
}

// Champs structurés qu'on tente de déduire automatiquement du mémo libre — UNIQUEMENT ceux encore VIDES
// (jamais une valeur déjà renseignée explicitement n'est écrasée par cette extraction, quel que soit ce que dit
// le mémo : en cas de désaccord, le champ structuré explicite prime, le mémo reste consultable tel quel).
const MEMO_EXTRACT_FIELDS = ['price', 'promoPrice', 'currency', 'description', 'advantages', 'paymentTerms', 'target', 'period', 'accessTerms'];

// Extraction LLM best-effort du mémo libre vers les champs structurés encore vides (voir MEMO_EXTRACT_FIELDS) —
// point de passage UNIQUE pour "comprendre" un mémo, appelé par create()/update() ci-dessous. JAMAIS bloquant :
// une extraction ratée/partielle/indisponible (pas de clé IA configurée...) n'empêche jamais la création/mise à
// jour du service — le mémo brut reste de toute façon injecté verbatim dans le contexte IA (voir renderService),
// donc rien n'est perdu même si cette extraction ne trouve rien. JAMAIS d'invention : seuls les champs que le
// modèle retrouve EXPLICITEMENT dans le texte sont retenus (consigne dans le prompt + validation programmatique
// du type de chaque champ ci-dessous).
async function extractFromMemo(memo, currentCommercial) {
  const text = String(memo || '').trim();
  if (!text) return {};
  const missing = MEMO_EXTRACT_FIELDS.filter((k) => currentCommercial[k] == null || currentCommercial[k] === '');
  if (!missing.length) return {};
  try {
    const llmFallbackEngine = require('../lib/ai/llmFallbackEngine');
    const prompt = [
      'Tu extrais des informations commerciales STRUCTURÉES à partir d\'un texte libre décrivant une activité (mémoire métier écrite par le vendeur lui-même).',
      `Champs à extraire, UNIQUEMENT s'ils sont EXPLICITEMENT présents dans le texte (sinon null — n'invente RIEN, ne déduis rien qui ne soit pas écrit) : ${missing.join(', ')}.`,
      'price/promoPrice : nombre seul, sans devise ni texte. currency : code ou nom court de la devise (ex: FCFA, XOF, EUR). period : dates/durée/validité en texte libre tel qu\'écrit. paymentTerms : reprends TEXTUELLEMENT les moyens/numéros/titulaires de paiement mentionnés, sans reformuler ni compléter.',
      `Réponds UNIQUEMENT avec un objet JSON strict, exactement ces clés (valeur null si absente du texte) : ${JSON.stringify(missing)}.`,
      `Texte à analyser :\n${text.slice(0, 4000)}`,
    ].join('\n');
    const res = await llmFallbackEngine.generateAIResponse(prompt, [], null, undefined, null, { purpose: 'business_memo_extraction', tier: 'standard', maxTokens: 500, jsonOutput: true });
    const raw = String((res && res.text) || '{}').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    const parsed = JSON.parse(raw);
    const out = {};
    for (const k of missing) {
      const v = parsed[k];
      if (v === null || v === undefined || v === '') continue;
      if (k === 'price' || k === 'promoPrice') { const n = Number(v); if (Number.isFinite(n)) out[k] = n; }
      else out[k] = String(v).slice(0, 600);
    }
    return out;
  } catch (e) {
    return {}; // extraction indisponible/échouée : jamais bloquant, le mémo brut reste consultable tel quel
  }
}

async function create(tenant, data) {
  const doc = await load(tenant);
  const service = normalizeService(data);
  if (service.commercial.memo) Object.assign(service.commercial, await extractFromMemo(service.commercial.memo, service.commercial));
  addHistory(service, 'Service créé');
  doc.services = Array.isArray(doc.services) ? doc.services : [];
  doc.services.push(service);
  save(tenant, doc);
  await syncOffersToProfile(tenant).catch(() => {});
  return publicView(service);
}

async function update(tenant, id, patch) {
  const doc = await load(tenant);
  const i = findIdx(doc, id);
  if (i < 0) return null;
  const before = doc.services[i];
  const merged = normalizeService(Object.assign({}, before, patch, { id, createdAt: before.createdAt, history: before.history, connection: Object.assign({}, before.connection, patch.connection || {}) }));
  // Mémo modifié dans ce patch : tente de remplir les champs structurés encore vides à partir du texte à jour
  // (jamais ceux déjà renseignés — voir extractFromMemo). Le mémo précédent n'est jamais "réextrait" à chaque
  // update() : seulement quand CE patch touche réellement le mémo, pour ne pas refaire un appel IA à chaque
  // modification d'un champ sans rapport (ex: changer juste le prix).
  if (patch.commercial && patch.commercial.memo !== undefined && merged.commercial.memo) {
    Object.assign(merged.commercial, await extractFromMemo(merged.commercial.memo, merged.commercial));
  }
  addHistory(merged, 'Service modifié');
  doc.services[i] = merged;
  save(tenant, doc);
  await syncOffersToProfile(tenant).catch(() => {});
  await syncToConnectors(tenant).catch(() => {});
  return publicView(merged);
}

async function remove(tenant, id) {
  const doc = await load(tenant);
  const i = findIdx(doc, id);
  if (i < 0) return { ok: false, error: 'NOT_FOUND' };
  const svc = doc.services[i];
  if (svc.connection && svc.connection.apiKeyRef) {
    await secretVault.revoke(tenant, svc.connection.apiKeyRef).catch(() => {});
  }
  doc.services.splice(i, 1);
  save(tenant, doc);
  await syncOffersToProfile(tenant).catch(() => {});
  return { ok: true, removed: id };
}

// Connecte une API : stocke la clé DANS LE COFFRE (jamais dans le service),
// enregistre juste la référence. Ne teste pas ici (voir testConnection).
async function connectApi(tenant, id, { apiKey, baseUrl, authHeader, connectorType, endpoints }) {
  const doc = await load(tenant);
  const i = findIdx(doc, id);
  if (i < 0) return { ok: false, error: 'NOT_FOUND' };
  const svc = doc.services[i];
  const ref = `service_${id}`;
  if (apiKey) {
    const v = await secretVault.setSecret(tenant, ref, apiKey);
    if (!v.ok) return { ok: false, error: 'VAULT_ERROR' };
    svc.connection.apiKeyRef = ref;
  }
  svc.connection.kind = 'api';
  if (baseUrl) svc.connection.baseUrl = baseUrl;
  if (authHeader) svc.connection.authHeader = authHeader;
  if (connectorType) svc.connection.connectorType = connectorType;
  if (endpoints) svc.connection.endpoints = endpoints;
  svc.status = STATUS.CONFIGURED;
  addHistory(svc, 'API connectée (clé stockée dans le coffre chiffré)');
  save(tenant, doc);
  await syncToConnectors(tenant).catch(() => {});
  return { ok: true, hasKey: !!svc.connection.apiKeyRef };
}

// TEST RÉEL de la connexion : effectue une vraie requête et rapporte le
// résultat réel. Jamais un "connecté" fictif.
async function testConnection(tenant, id) {
  const doc = await load(tenant);
  const i = findIdx(doc, id);
  if (i < 0) return { ok: false, error: 'NOT_FOUND' };
  const svc = doc.services[i];
  const conn = svc.connection || {};
  let result;

  if (conn.kind !== 'api' || !conn.baseUrl) {
    result = { status: 'CONFIGURATION_INCOMPLETE', detail: 'Aucune API configurée (baseUrl manquant).' };
  } else if (typeof fetch !== 'function') {
    result = { status: 'ERROR', detail: 'NO_HTTP_TRANSPORT' };
  } else {
    const apiKey = conn.apiKeyRef ? await secretVault.getSecret(tenant, conn.apiKeyRef) : null;
    const authHeader = conn.authHeader || 'X-API-Key';
    const base = String(conn.baseUrl).replace(/\/+$/, '');
    try {
      if (conn.connectorType === 'platform_gateway') {
        // Test non destructif : suspend d'un email inexistant -> 404 attendu
        // (prouve auth + endpoint réel sans rien modifier).
        const ep = (conn.endpoints && conn.endpoints.suspend) || '/api/v1/agent-gateway/suspend-student';
        const res = await fetch(base + ep, {
          method: 'POST', headers: { 'Content-Type': 'application/json', [authHeader]: apiKey || '' },
          body: JSON.stringify({ email: 'cyrus-connection-test@example.invalid' }),
        });
        if (res.status === 404) result = { status: 'CONNECTED', detail: 'Authentifié, API joignable (compte test introuvable, attendu).', httpStatus: 404 };
        else if (res.status === 401) result = { status: 'AUTHENTICATION_FAILED', detail: 'Clé API invalide.', httpStatus: 401 };
        else if (res.status === 403) result = { status: 'CONNECTED_LIMITED', detail: 'Authentifié mais permission manquante pour cette opération.', httpStatus: 403 };
        else if (res.ok) result = { status: 'CONNECTED', detail: 'Authentifié et joignable.', httpStatus: res.status };
        else result = { status: 'PARTIAL', detail: `Réponse inattendue (HTTP ${res.status}).`, httpStatus: res.status };
      } else {
        // Générique : GET la base avec l'en-tête d'auth, interprète le code.
        const res = await fetch(base, { method: 'GET', headers: apiKey ? { [authHeader]: apiKey } : {} });
        if (res.status === 401 || res.status === 403) result = { status: 'AUTHENTICATION_FAILED', detail: `Authentification refusée (HTTP ${res.status}).`, httpStatus: res.status };
        else if (res.status >= 500) result = { status: 'SERVICE_UNAVAILABLE', detail: `Service indisponible (HTTP ${res.status}).`, httpStatus: res.status };
        else result = { status: 'CONNECTED', detail: `Joignable (HTTP ${res.status}).`, httpStatus: res.status };
      }
    } catch (err) {
      result = { status: 'SERVICE_UNAVAILABLE', detail: String((err && err.message) || err) };
    }
  }

  svc.lastTest = Object.assign({ at: new Date().toISOString() }, result);
  svc.status = (result.status === 'CONNECTED' || result.status === 'CONNECTED_LIMITED') ? STATUS.CONNECTED
    : (result.status === 'CONFIGURATION_INCOMPLETE' ? STATUS.CONFIGURED : STATUS.ERROR);
  addHistory(svc, `Test de connexion : ${result.status}`);
  save(tenant, doc);
  return { ok: true, result: svc.lastTest, status: svc.status };
}

async function setPermissions(tenant, id, scopes) {
  return update(tenant, id, { scopes: Array.isArray(scopes) ? scopes : [] });
}

// Résumé lisible de ce que Cyrus connaît réellement d'un service.
function summary(service) {
  const s = service || {};
  const c = s.commercial || {};
  return {
    name: s.name, activite: s.type, projet: s.project,
    produits: (s.products || []).map((p) => p.name || p),
    prix: c.price != null ? `${c.price} ${c.currency || ''}` : null,
    promo: c.promoPrice != null ? `${c.promoPrice} ${c.currency || ''}` : null,
    plateforme: (s.connection && s.connection.baseUrl) || null,
    connexion: (s.connection && s.connection.kind) || 'none',
    cle_configuree: !!(s.connection && s.connection.apiKeyRef),
    capacites: (s.scopes || []),
    regles: (s.rules || []),
    objectifs: (s.objectives || []),
    statut: s.status,
  };
}

// Contexte NON SECRET exploitable par l'intelligence (closing/campagnes) —
// c'est le lien "mémoire" demandé : Cyrus y puise produits, prix, règles,
// objectifs, capacités, SANS jamais voir les secrets.
async function getEngineContext(tenant) {
  const doc = await load(tenant);
  return (doc.services || []).map((s) => ({
    name: s.name, type: s.type, project: s.project,
    products: s.products || [], commercial: Object.assign({}, s.commercial, {}),
    rules: s.rules || [], objectives: s.objectives || [], scopes: s.scopes || [],
    connected: s.status === STATUS.CONNECTED,
    active: s.active !== false && (s.lifecycle || 'active') === 'active', createdAt: s.createdAt || '',
    specialists: s.specialists || [], lifecycle: s.lifecycle || 'active',
  }));
}

// Rendu TEXTE compact et lisible du contexte ci-dessus, prêt à être injecté
// dans un prompt LLM (le chat intelligent y répond aux questions factuelles du
// vendeur — prix, produits, règles, objectifs, capacités — SANS rien inventer).
// C'est le maillon "DONNÉES → INTELLIGENCE" : sans lui, le chat ne peut pas
// lire ce que le vendeur a configuré dans l'onglet Services Métiers. Renvoie
// une chaîne vide s'il n'y a aucun service (le chat le dit alors franchement).
async function getEngineContextText(tenant) {
  const ctx = await getEngineContext(tenant);
  if (!ctx.length) return '';
  return ctx.map(renderService).join('\n\n');
}

function renderService(s) {
  {
    const c = s.commercial || {};
    const cur = c.currency || '';
    const lines = [`• Service « ${s.name} » (${s.type}${s.project ? `, projet : ${s.project}` : ''})${s.connected ? ' — plateforme connectée' : ''}`];
    // Mémoire métier en texte libre : SOURCE BRUTE écrite par le vendeur — à consulter pour tout détail non
    // repris explicitement dans les champs structurés ci-dessous (une extraction automatique imparfaite ne fait
    // jamais perdre une information, elle reste lisible ici telle quelle).
    if (c.memo) lines.push(`  Mémoire de l'activité (texte du vendeur, source complète) : ${c.memo}`);
    if (c.description) lines.push(`  Description : ${c.description}`);
    if (c.price != null) lines.push(`  Prix : ${c.price} ${cur}`.trim() + (c.promoPrice != null ? ` (promo : ${c.promoPrice} ${cur})`.replace(/\s+\)/, ')') : ''));
    if (c.target) lines.push(`  Cible : ${c.target}`);
    const products = (s.products || []).map((p) => {
      const name = p && (p.name || p);
      const price = p && p.price != null ? ` : ${p.price} ${cur}`.trim() : '';
      return `${name}${price}`;
    });
    if (products.length) lines.push(`  Produits : ${products.join(' ; ')}`);
    if (c.advantages) lines.push(`  Avantages : ${c.advantages}`);
    if (c.objections) lines.push(`  Objections & réponses : ${c.objections}`);
    if (c.responses) lines.push(`  Réponses préparées : ${c.responses}`);
    // Instructions de paiement / d'accès configurées par le vendeur : à donner EXACTEMENT, jamais complétées ni inventées.
    if (c.paymentTerms) lines.push(`  INSTRUCTIONS DE PAIEMENT (seuls moyens/numéros valides, à donner tels quels) : ${c.paymentTerms}`);
    else lines.push('  Instructions de paiement : NON CONFIGURÉES (ne cite aucun numéro, lien ni moyen de paiement).');
    if (c.audience) lines.push(`  Audience visée : ${c.audience}`);
    if (c.period) lines.push(`  Période / dates : ${c.period}`);
    if (c.closing) lines.push(`  Consignes de closing : ${c.closing}`);
    if (c.escalation) lines.push(`  Quand passer la main au propriétaire : ${c.escalation}`);
    if (c.knowledge) lines.push(`  Connaissances complémentaires : ${c.knowledge}`);
    if (c.supportRules) lines.push(`  Règles d'accompagnement des apprenants : ${c.supportRules}`);
    if (c.accessTerms) lines.push(`  Conditions d'accès / livraison : ${c.accessTerms}`);
    if ((s.rules || []).length) lines.push(`  Règles commerciales : ${s.rules.join(' | ')}`);
    if ((s.objectives || []).length) lines.push(`  Objectifs : ${s.objectives.join(' | ')}`);
    if ((s.scopes || []).length) lines.push(`  Capacités autorisées (outils réels) : ${s.scopes.join(', ')}`);
    return lines.join('\n');
  }
}

// CONVERSATION COMMERCIALE : ordre de présentation des offres à un prospect.
//   1. SERVICE PRIORITAIRE = celui qui correspond au contexte (campagne / sujet déjà évoqué : `hint`), sinon le Service métier ACTIF
//      le plus RÉCENT ;
//   2. les autres services actifs ne sont donnés qu'en SUGGESTIONS COMPLÉMENTAIRES (résumé court) ;
//   3. tout vient des données configurées : rien n'est inventé. Renvoie { text, priority, others, count }.
function pickPriority(services, hint) {
  const active = services.filter((s) => s.active !== false);
  const pool = active.length ? active : services;
  const h = String(hint || '').trim().toLowerCase();
  if (h) {
    const hit = pool.find((s) => String(s.name || '').toLowerCase() === h) || pool.find((s) => h.includes(String(s.name || '').toLowerCase()) && String(s.name || '').length >= 3);
    if (hit) return hit;
  }
  return pool.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
}
async function getPrioritizedContext(tenant, opts) {
  const services = await getEngineContext(tenant);
  if (!services.length) return { text: '', priority: null, others: [], count: 0, recommendedSpecialists: [] };
  const prio = pickPriority(services, opts && opts.hint);
  const others = services.filter((s) => s !== prio && s.active !== false);
  const brief = (s) => { const c = s.commercial || {}; return `• ${s.name}${c.price != null ? ` — ${c.price} ${c.currency || ''}`.trimEnd() : ''}${c.description ? ` : ${String(c.description).slice(0, 140)}` : ''}`; };
  const parts = [`SERVICE PRIORITAIRE À PRÉSENTER (le plus pertinent pour ce contact — présente-le en premier et réponds à toutes ses questions dessus) :\n${renderService(prio)}`];
  if (others.length) parts.push(`AUTRES OFFRES DU VENDEUR (à proposer UNIQUEMENT comme suggestions complémentaires, quand c'est pertinent — jamais avant d'avoir répondu au sujet du service prioritaire) :\n${others.map(brief).join('\n')}`);
  return { text: parts.join('\n\n'), priority: prio.name, others: others.map((s) => s.name), count: services.length, recommendedSpecialists: prio.specialists || [] };
}

// Miroir des infos commerciales vers le profil business persistant que le
// moteur de closing/campagne lit déjà (ai-engine/emotionalCloser.js,
// offerClarifier.js). Ne touche PAS aux offres saisies via le chat (source
// 'chat') : on ne remplace que les offres issues des Services Métiers.
async function syncOffersToProfile(tenant) {
  const doc = await load(tenant);
  const profile = await storageAdapter.get(PROFILE_NAMESPACE, sanitize(tenant), { tenantId: sanitize(tenant), offers: [], faq: [] });
  const kept = (profile.offers || []).filter((o) => o.source !== 'service_metier');
  const fromServices = [];
  for (const s of (doc.services || [])) {
    const c = s.commercial || {};
    if (c.description || c.price != null || (s.products || []).length) {
      fromServices.push({
        source: 'service_metier', serviceId: s.id,
        name: s.name, category: s.type, price: c.price != null ? `${c.price} ${c.currency || ''}`.trim() : null,
        description: c.description || '', options: (s.products || []).map((p) => p.name || p).join(', '),
        advantages: c.advantages || '', objections: c.objections || '',
      });
    }
  }
  profile.offers = kept.concat(fromServices);
  storageAdapter.set(PROFILE_NAMESPACE, sanitize(tenant), profile);
  return profile.offers.length;
}

// Synchronise les services "API" de types de connecteur connus vers la config
// des connecteurs (namespace lu par ai-engine/connectors/connectorManager.js) —
// c'est ce qui rend un service configuré via l'onglet RÉELLEMENT utilisable par
// l'intelligence (getToolsForTenant), avec sa clé (apiKeyRef -> coffre) et ses
// permissions (scopes). Ne touche qu'aux types configurés : les défauts
// (active_connectors.json) restent appliqués pour les autres.
async function syncToConnectors(tenant) {
  const doc = await load(tenant);
  const override = await storageAdapter.get('connectors', sanitize(tenant), { connectors: {} });
  override.connectors = override.connectors || {};
  for (const s of (doc.services || [])) {
    const conn = s.connection || {};
    if (conn.kind !== 'api' || !conn.connectorType) continue;
    if (conn.connectorType === 'accounting') {
      override.connectors.accounting = { enabled: true, label: s.name, scopes: (s.scopes && s.scopes.length) ? s.scopes : ['accounting:write'] };
      continue;
    }
    override.connectors[conn.connectorType] = {
      enabled: true,
      label: s.name,
      baseUrl: conn.baseUrl || undefined,
      apiKeyRef: conn.apiKeyRef || undefined,
      authHeader: conn.authHeader || 'X-API-Key',
      endpoints: conn.endpoints || undefined,
      scopes: (s.scopes && s.scopes.length) ? s.scopes : undefined,
    };
  }
  storageAdapter.set('connectors', sanitize(tenant), override);
  return override.connectors;
}

module.exports = {
  STATUS, list, get, create, update, remove, connectApi, testConnection,
  setPermissions, summary, getEngineContext, getEngineContextText, getPrioritizedContext, syncOffersToProfile, syncToConnectors, NAMESPACE,
};
