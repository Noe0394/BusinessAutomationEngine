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
      price: null, promoPrice: null, currency: 'FCFA', description: '', advantages: '',
      objections: '', responses: '', paymentTerms: '', accessTerms: '', target: '',
    }, d.commercial || {}),
    products: Array.isArray(d.products) ? d.products : [],
    rules: Array.isArray(d.rules) ? d.rules : [],
    objectives: Array.isArray(d.objectives) ? d.objectives : [],
    capabilities: Array.isArray(d.capabilities) ? d.capabilities : [],
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

async function create(tenant, data) {
  const doc = await load(tenant);
  const service = normalizeService(data);
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
  }));
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
  setPermissions, summary, getEngineContext, syncOffersToProfile, syncToConnectors, NAMESPACE,
};
