// AUTORISATION — ai-engine/authz.js
// ---------------------------------------------------------------------------
// Le LLM n'est JAMAIS l'autorité de sécurité. Ce module est le point unique où s'établit « qui appelle » et « ce qu'il a le
// droit de faire », côté backend, indépendamment de tout texte (message, fichier, transcription, page web, réponse d'API,
// mémoire/RAG) : aucun contenu ne peut modifier un rôle, une permission ou une règle.
//
//   • PRINCIPAL : identité authentifiée { tenant, role, userId, channel, via }, émise UNIQUEMENT par du code serveur de
//     confiance (route authentifiée, self-chat vérifié du compte connecté, numéro propriétaire configuré). Un principal ne
//     se fabrique pas à partir d'un JSON/argument d'outil/sortie de modèle : seuls les objets émis par issuePrincipal()
//     (WeakSet privé, objet gelé) sont reconnus.
//   • RÔLES : OWNER, ADMIN, CUSTOMER, CONTACT (contact privé), GROUP. Chaque outil déclare les rôles autorisés ; par défaut
//     OWNER et ADMIN seulement (deny-by-default).
//   • CONTEXTE D'EXÉCUTION : le principal est porté par AsyncLocalStorage pendant tout le tour de conversation (runAs), ce
//     qui évite de le repasser à la main dans chaque handler — et interdit qu'un argument d'outil le remplace.
//   • CONTENU NON FIABLE (« teinté ») : quand le tour contient un fichier/média/transcription/donnée externe, toute action
//     d'écriture externe (envoi, campagne, connexion d'un service externe…) exige une confirmation explicite de l'humain,
//     même si le texte du fichier « ordonne » de la lancer.

const { AsyncLocalStorage } = require('async_hooks');

const ROLES = Object.freeze({ OWNER: 'OWNER', ADMIN: 'ADMIN', CUSTOMER: 'CUSTOMER', CONTACT: 'CONTACT', GROUP: 'GROUP' });
const DEFAULT_TOOL_ROLES = Object.freeze([ROLES.OWNER, ROLES.ADMIN]);

const issued = new WeakSet();
const als = new AsyncLocalStorage();

// Émet un principal. À n'appeler que depuis du code serveur qui a RÉELLEMENT authentifié l'appelant.
function issuePrincipal({ tenant, role, userId, channel, via }) {
  const r = String(role || '').toUpperCase();
  if (!ROLES[r]) throw new Error(`Rôle inconnu : ${role}`);
  const t = String(tenant || '').trim();
  if (!t) throw new Error('Un principal exige un tenant.');
  const p = Object.freeze({ tenant: t, role: r, userId: userId ? String(userId) : t, channel: channel ? String(channel).toUpperCase() : 'WEB', via: via || 'unknown' });
  issued.add(p);
  return p;
}
const isPrincipal = (p) => !!p && typeof p === 'object' && issued.has(p);

// Exécute `fn` avec ce principal. `opts.tainted` : le tour contient du contenu non fiable.
function runAs(principal, fn, opts) {
  if (!isPrincipal(principal)) throw new Error('Principal invalide : exécution refusée.');
  return als.run({ principal, tainted: !!(opts && opts.tainted) }, fn);
}
// Variante « à partir d'ici » (tests, scripts) : le reste du flux asynchrone courant s'exécute sous ce principal.
function enterAs(principal, opts) {
  if (!isPrincipal(principal)) throw new Error('Principal invalide : exécution refusée.');
  als.enterWith({ principal, tainted: !!(opts && opts.tainted) });
}
const currentStore = () => als.getStore() || null;
const currentPrincipal = () => { const s = als.getStore(); return s ? s.principal : null; };
// Marque le tour courant comme contenant du contenu non fiable (utilisable en cours de tour, ex. après un téléchargement).
function markTainted() { const s = als.getStore(); if (s) s.tainted = true; }
const isTainted = () => { const s = als.getStore(); return !!(s && s.tainted); };

// Décision d'autorisation pour un outil. Renvoie { allowed:true } ou { allowed:false, code, message }.
//   principal : celui du contexte (jamais un argument) ; `tenant` : le compte visé par l'appel.
function authorizeTool({ tool, toolName, tenant, principal }) {
  if (!isPrincipal(principal)) return { allowed: false, code: 'NOT_AUTHENTICATED', message: `Identité de l'appelant absente pour « ${toolName} ».` };
  const roles = (tool && Array.isArray(tool.roles) && tool.roles.length) ? tool.roles : DEFAULT_TOOL_ROLES;
  if (!roles.includes(principal.role)) return { allowed: false, code: 'ROLE_FORBIDDEN', message: `Le rôle ${principal.role} n'a pas accès à « ${toolName} ».` };
  // Un compte n'opère que sur lui-même ; seul un ADMIN peut cibler explicitement un autre compte (fonction d'administration existante).
  if (String(tenant) !== principal.tenant && principal.role !== ROLES.ADMIN) return { allowed: false, code: 'TENANT_MISMATCH', message: 'Ressource d\'un autre compte.' };
  return { allowed: true };
}

// Identifiants de ressources acceptés en argument (empêche toute traversée de chemin / injection dans un identifiant).
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const isSafeId = (v) => typeof v === 'string' && ID_RE.test(v);

module.exports = {
  ROLES, DEFAULT_TOOL_ROLES,
  issuePrincipal, isPrincipal, runAs, enterAs, currentStore, currentPrincipal, markTainted, isTainted,
  authorizeTool, isSafeId,
};
