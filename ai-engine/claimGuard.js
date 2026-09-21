// GARDE-FOU « JAMAIS FAIT SANS PREUVE » — ai-engine/claimGuard.js
// ---------------------------------------------------------------------------
// Règle absolue : le système n'affirme JAMAIS qu'une action est faite (créé, configuré, supprimé, envoyé, activé…) sans preuve dans le MÊME tour.
// La preuve doit être du BON type :
//   • une lecture (liste, recherche, statut) n'est JAMAIS la preuve d'une écriture ;
//   • l'outil exécuté doit correspondre au verbe de la DEMANDE (supprimer ⇒ un outil de suppression ; créer ⇒ un outil de création ; envoyer ⇒ un outil d'envoi…) ;
//   • l'outil doit avoir réussi (état SUCCESS, donc vérifié quand il possède une vérification) — un échec ou un « non confirmé » ne prouve rien.
// Sans preuve, le texte est REMPLACÉ par un message honnête : soit la fonction existe (comment la déclencher), soit elle n'existe pas (dit clairement).
// Ne touche jamais aux refus, questions, propositions ni aux textes qui décrivent ce qui SERA fait.
const PART = "(?:cr[ée][ée]|configur[ée]|envoy[ée]|activ[ée]|ajout[ée]|enregistr[ée]|lanc[ée]|programm[ée]|import[ée]|publi[ée]|supprim[ée]|modifi[ée]|termin[ée]|effectu[ée]|retir[ée]|effac[ée]|restaur[ée]|renomm[ée]|mis(?:e)?\\s+en\\s+pause|d[ée]sactiv[ée])";
const CLAIM_RE = new RegExp([
  "c['’]est\\s+(?:bien\\s+)?(?:fait|" + PART + "e?|en\\s+ligne|mis\\s+en\\s+place|op[ée]rationnel(?:le)?)",
  "j['’]ai\\s+(?:bien\\s+|d[ée]j[àa]\\s+)?(?:" + PART + "|mis\\s+en\\s+place|mis\\s+[àa]\\s+jour|[ée]crit\\s+[àa])",
  "(?:est|sont|a\\s+[ée]t[ée]|ont\\s+[ée]t[ée])\\s+(?:bien\\s+|maintenant\\s+|d[ée]sormais\\s+)?(?:" + PART + "e?s?|mis(?:es?)?\\s+en\\s+place|en\\s+ligne)",
  "(?:[,;]|\\bet)\\s+(?:" + PART + "e?s?|en\\s+ligne)\\b",
  "message\\s+bien\\s+remis|c['’]est\\s+parti|mission\\s+accomplie|tout\\s+est\\s+(?:en\\s+place|pr[êe]t|configur[ée])",
].join("|"), "i");
const NEGATION_RE = /\b(?:pas|jamais|aucun|aucune|impossible|échou\w*|échec|n['’]ai\s+pas)\b/i;

// Une affirmation est-elle présente ? (précédée d'une condition « une fois / si / quand » ou d'une négation proche : ce n'est pas une affirmation)
function hasClaim(text) {
  const t = String(text || '');
  const m = t.match(CLAIM_RE);
  if (!m) return false;
  const before = t.slice(Math.max(0, m.index - 60), m.index);
  const around = t.slice(Math.max(0, m.index - 40), m.index + m[0].length + 20);
  if (/\b(?:une fois|dès que|quand|lorsque|si|pour que|afin que)\b[^.!?]*$/i.test(before)) return false;
  return !NEGATION_RE.test(around);
}

// Familles de verbes : ce que la demande exige ↔ l'outil qui l'accomplit réellement.
const FAMILIES = [
  { id: 'delete', req: /supprim|effac|retir|enlev|detrui/, tool: /delete|remove|cancel|stop|unlink|archive|purge|clear/i },
  { id: 'restore', req: /restaur|recuper|annul\w* la suppression/, tool: /restore|undelete/i },
  { id: 'create', req: /\bcre[ée]|ajout|enregistr|import|ingere/, tool: /create|configure|record|prepare|import|link|add|ingest|save|open|plan|schedule|attach|tag|generate|draft|promote|start/i },
  { id: 'send', req: /envoi|envoy|ecri\w* a\b|lanc|programm|planifi|publi/, tool: /send|launch|schedule|reply|campaign|publish|post|create|start/i },
  { id: 'update', req: /modifi|renomm|chang|mets? a jour|mettre a jour|corrig|remplac|configur/, tool: /update|set|configure|tag|link|rename|edit|status|policy/i },
  { id: 'toggle', req: /activ|desactiv|pause|reprend|suspend|bloqu/, tool: /status|pause|resume|activate|setAutoReply|specialist|suspend|block|policy/i },
];
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const READ_NAME_RE = /^(?:get|list|search|count|query|describe|explain|monitor|parse|extract|normalize|validate|deduplicate|analy[sz]e|activityReport|followUpCandidates|whyFollow|guideSetup|find|read|check)/i;

// Appels d'outils du tour (toutes les formes de résultat de l'Orchestrateur / de l'agent à outils).
function callsOf(out) {
  if (!out || typeof out !== 'object') return [];
  if (Array.isArray(out.toolCalls) && out.toolCalls.length) return out.toolCalls;
  if (Array.isArray(out.steps) && out.steps.length) return out.steps;
  return out.toolCall ? [out.toolCall] : [];
}
const isWrite = (c) => (c && c.risk ? c.risk !== 'READ' : !READ_NAME_RE.test(String((c && c.name) || '')));
const okCall = (c) => c && ['SUCCESS', 'VERIFIED'].includes(String(c.state || c.status || '').toUpperCase());
const hasDoneLog = (out) => !!(out && Array.isArray(out.actionLog) && out.actionLog.some((a) => a && a.status === 'done'));

// La preuve d'exécution est-elle du bon type pour cette demande ?
function hasEvidence(out, request) {
  if (!out || typeof out !== 'object') return false;
  const calls = callsOf(out);
  if (!calls.length) return hasDoneLog(out); // gestionnaire déterministe : l'action journalisée « done » est issue d'une opération réelle
  const writes = calls.filter((c) => okCall(c) && isWrite(c));
  if (!writes.length) return false; // des lectures (liste, statut…) ne prouvent jamais une écriture
  const req = norm(request); if (!req) return true;
  const needed = FAMILIES.filter((f) => f.req.test(req));
  if (!needed.length) return true;
  return needed.every((f) => writes.some((c) => f.tool.test(String(c.name || ''))));
}

const HONEST = "Je n'ai rien exécuté pour cette demande : aucune action n'a été lancée et vérifiée, donc je ne peux pas la déclarer faite. Dites-moi précisément ce que vous voulez (par exemple « crée le service métier <nom> : type, prix, description »), je l'exécute réellement puis je vous confirme avec la preuve (ce qui a été créé, référence, statut).";

// out : résultat du tour (peut être null pour une réponse de conversation libre). opts : { request } = le message de l'utilisateur. Renvoie { text, blocked }.
function guard(text, out, opts) {
  const t = String(text == null ? '' : text); const request = (opts && opts.request) || '';
  if (!hasClaim(t) || hasEvidence(out, request)) return { text: t, blocked: false };
  try { console.warn(`claimGuard — affirmation d'accomplissement SANS preuve adaptée bloquée : « ${t.replace(/\s+/g, ' ').slice(0, 120)} »`); } catch (e) { /* journal seulement */ }
  let msg = HONEST;
  try {
    const gap = require('./capabilityGap');
    if (request && gap.isActionRequest(request)) msg = gap.explain(request, require('./toolRegistry').describe());
  } catch (e) { msg = HONEST; }
  return { text: msg, blocked: true, original: t };
}

// Côté CLIENT (réponse automatique) : aucun outil n'est exécuté pendant la conversation, donc toute affirmation À LA PREMIÈRE PERSONNE d'une action accomplie
// (« j'ai enregistré votre commande », « c'est fait ») est non vérifiée. Regex volontairement étroite : « la formation est en ligne » reste permis.
const CUSTOMER_CLAIM_RE = new RegExp([
  /c['’]est\s+(?:bien\s+)?(?:fait|parti)/.source,
  /j['’]ai\s+(?:bien\s+|d[ée]j[àa]\s+)?/.source + '(?:' + PART + '|mis\\s+en\\s+place|mis\\s+[àa]\\s+jour|r[ée]serv[ée]|valid[ée]|confirm[ée])',
  /votre\s+(?:commande|inscription|r[ée]servation|paiement|demande)\s+(?:est|a\s+[ée]t[ée])\s+(?:bien\s+)?(?:enregistr[ée]e?|valid[ée]e?|confirm[ée]e?|prise?\s+en\s+compte|trait[ée]e?|envoy[ée]e?)/.source,
].join('|'), 'i');
const hasCustomerClaim = (text) => { const t = String(text || ''); const m = t.match(CUSTOMER_CLAIM_RE); if (!m) return false; return !NEGATION_RE.test(t.slice(Math.max(0, m.index - 40), m.index + m[0].length + 20)); };

module.exports = { guard, hasClaim, hasCustomerClaim, hasEvidence, callsOf, FAMILIES, HONEST };
