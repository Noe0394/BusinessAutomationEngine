// ERREURS IA — lib/ai/aiErrors.js
// ---------------------------------------------------------------------------
// Trois responsabilités, toutes déterministes (aucun appel IA) :
//   1. classifyError() : une erreur de fournisseur est-elle RÉCUPÉRABLE (le même appel peut réussir dans un instant :
//      surcharge, 5xx, limite de débit passagère) ou DÉFINITIVE (clé invalide, modèle absent, modalité non supportée,
//      requête refusée) ? Le retry/backoff ne s'applique qu'aux erreurs récupérables — jamais de boucle sur une erreur
//      définitive.
//   2. redact() : masque tout secret (clés API, jetons, en-têtes d'autorisation) dans un texte destiné aux LOGS
//      internes. Les détails techniques n'existent que dans les logs, jamais côté utilisateur.
//   3. AiUnavailableError / safeUserMessage() : quand tous les modèles échouent, l'utilisateur ne voit QU'UN message
//      générique (aucun nom de modèle/fournisseur, code HTTP, quota, ordre de secours, stack…). Le message de l'erreur
//      elle-même est déjà le message générique : n'importe quel appelant qui l'affiche reste sûr par construction.

const GENERIC_USER_MESSAGE = 'Je rencontre momentanément un problème pour traiter votre demande. Veuillez réessayer un peu plus tard.';
const FILE_FAILED_USER_MESSAGE = "Je n'ai pas pu traiter ce fichier. Pouvez-vous le renvoyer ou réessayer un peu plus tard ?";

// Motifs de secrets (clés Google « AIza… » et « AQ.… », OpenAI/Anthropic « sk-… », Groq « gsk_… », Hugging Face « hf_… »,
// OpenRouter « sk-or-… », jetons « Bearer … », paramètres d'URL key=/token=/api_key=, en-têtes d'autorisation).
const SECRET_PATTERNS = [
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bAQ\.[0-9A-Za-z_-]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgsk_[A-Za-z0-9]{16,}/g,
  /\bhf_[A-Za-z0-9]{16,}/g,
  /\bsk_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /((?:x-goog-api-key|x-api-key|authorization|api[_-]?key|apikey|access[_-]?token|token|secret|key)["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{8,}/gi,
  /([?&](?:key|api_key|apikey|token|access_token)=)[^&\s"']+/gi,
];

// `strong` : uniquement les motifs sans ambiguïté (jetons/clés reconnaissables) — utilisé pour filtrer un texte destiné à
// l'utilisateur sans risquer de masquer du texte légitime ; le mode complet (logs) ajoute les motifs « clé=valeur ».
function redact(input, strong) {
  let s = String(input == null ? '' : input);
  for (const re of (strong ? SECRET_PATTERNS.slice(0, 8) : SECRET_PATTERNS)) s = s.replace(re, (m, p1) => (typeof p1 === 'string' ? `${p1}[REDACTED]` : '[REDACTED]'));
  // Valeurs réellement présentes dans l'environnement (au cas où un secret n'aurait aucun motif reconnaissable).
  for (const [k, v] of Object.entries(process.env)) {
    if (!/(KEY|TOKEN|SECRET|PASSWORD|HASH)/i.test(k)) continue;
    const val = String(v || '');
    if (val.length >= 12 && s.includes(val)) s = s.split(val).join('[REDACTED]');
  }
  return s;
}

// Statut HTTP éventuel d'une erreur axios/Boom/fetch.
function statusOf(err) {
  return (err && err.response && err.response.status) || (err && err.status) || (err && err.statusCode) || null;
}
function providerMessage(err) {
  const d = err && err.response && err.response.data;
  const m = d && (d.error && (d.error.message || d.error) || d.message);
  return String(m || (err && err.message) || '');
}

const NETWORK_RETRYABLE = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH', 'EAI_AGAIN', 'ETIMEDOUT']);

// Renvoie { retryable, kind, status, retryAfterMs }.
//   kind : 'rate_limit' | 'overloaded' | 'server' | 'timeout' | 'network' | 'quota' | 'auth' | 'not_found' |
//          'unsupported_modality' | 'bad_request' | 'empty' | 'unknown'
// « retryable » = même requête, même modèle, ré-essai raisonnable dans quelques centaines de millisecondes.
// Un timeout n'est PAS ré-essayé sur le même modèle (il est déjà lent) : on passe directement au suivant.
function classifyError(err) {
  const status = statusOf(err);
  const msg = providerMessage(err);
  const code = err && err.code;
  if (err && err.aiEmpty) return { retryable: false, kind: 'empty', status };
  if (code === 'ECONNABORTED' || /timeout/i.test(String((err && err.message) || ''))) return { retryable: false, kind: 'timeout', status };
  if (!status) {
    if (NETWORK_RETRYABLE.has(code)) return { retryable: true, kind: 'network', status };
    return { retryable: false, kind: 'unknown', status };
  }
  if (status === 400 && /modalit|not (?:enabled|supported)|unsupported|mime/i.test(msg)) return { retryable: false, kind: 'unsupported_modality', status };
  if (status === 429) {
    // Quota épuisé / facturation : inutile de ré-essayer ; limite de débit passagère : un ré-essai bref suffit.
    if (/quota|billing|exhaust|per day|daily|credit|balance/i.test(msg)) return { retryable: false, kind: 'quota', status };
    const ra = Number(err.response && err.response.headers && (err.response.headers['retry-after'] || err.response.headers['Retry-After']));
    return { retryable: true, kind: 'rate_limit', status, retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : null };
  }
  if (status === 503) return { retryable: true, kind: 'overloaded', status };
  if (status === 500 || status === 502 || status === 504 || status === 408) return { retryable: true, kind: 'server', status };
  if (status === 401 || status === 403) return { retryable: false, kind: 'auth', status };
  if (status === 404) return { retryable: false, kind: 'not_found', status };
  if (status === 402) return { retryable: false, kind: 'quota', status };
  if (status >= 400 && status < 500) return { retryable: false, kind: 'bad_request', status };
  return { retryable: false, kind: 'unknown', status };
}

// Ligne de LOG interne (redactée) décrivant l'échec d'un modèle.
function describeForLog(name, err) {
  const c = classifyError(err);
  const raw = redact(providerMessage(err)).replace(/\s+/g, ' ').slice(0, 160);
  return `${name}: ${c.kind}${c.status ? ` HTTP ${c.status}` : ''}${c.retryable ? ' (récupérable)' : ''}${raw ? ` — ${raw}` : ''}`;
}

// Erreur finale renvoyée quand plus aucun modèle ne peut répondre. `message` = texte générique SÛR pour l'utilisateur ;
// `internalDetail` (déjà redacté) ne doit aller que dans les logs.
class AiUnavailableError extends Error {
  constructor(internalDetail, reason) {
    super(GENERIC_USER_MESSAGE);
    this.name = 'AiUnavailableError';
    this.code = 'AI_UNAVAILABLE';
    this.reason = reason || 'ALL_FAILED';
    this.internalDetail = redact(internalDetail || '');
    this.userSafe = true;
  }
}

// Message affichable à un utilisateur pour N'IMPORTE QUELLE erreur : seule une erreur explicitement « sûre » garde son
// texte ; tout le reste devient le message générique (jamais err.message d'une erreur interne).
function safeUserMessage(err, fallback) {
  if (err && err.userSafe === true && err.message) return err.message;
  return fallback || GENERIC_USER_MESSAGE;
}

// Filtre de sortie : masque tout secret qui se serait glissé dans un texte destiné à l'utilisateur.
function scrubOutbound(text) {
  return redact(text, true);
}

module.exports = {
  GENERIC_USER_MESSAGE, FILE_FAILED_USER_MESSAGE, AiUnavailableError,
  classifyError, redact, describeForLog, safeUserMessage, scrubOutbound, statusOf,
};
