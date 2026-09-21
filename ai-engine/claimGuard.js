// GARDE-FOU « JAMAIS FAIT SANS PREUVE » — ai-engine/claimGuard.js
// ---------------------------------------------------------------------------
// Règle absolue : le système n'affirme JAMAIS qu'une action est faite (créé, configuré, envoyé, activé, lancé…) sans preuve dans le MÊME tour :
// un appel d'outil réellement exécuté avec succès (état SUCCESS) ou une action journalisée « done ». Une réponse de conversation libre du modèle
// ne compte pas comme preuve. Si le texte annonce un accomplissement sans preuve, il est REMPLACÉ par un message honnête (rien n'a été exécuté).
// Ne touche jamais aux refus, questions, propositions ni aux textes qui décrivent ce qui SERA fait.
const PART = "(?:cr[ée][ée]|configur[ée]|envoy[ée]|activ[ée]|ajout[ée]|enregistr[ée]|lanc[ée]|programm[ée]|import[ée]|publi[ée]|supprim[ée]|modifi[ée]|termin[ée]|effectu[ée])";
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

// Preuve d'exécution dans le résultat du tour (objet renvoyé par l'Orchestrateur / l'agent à outils).
function hasEvidence(out) {
  if (!out || typeof out !== 'object') return false;
  const ok = (c) => c && ['SUCCESS', 'VERIFIED'].includes(String(c.state || c.status || '').toUpperCase());
  if (ok(out.toolCall)) return true;
  if (Array.isArray(out.toolCalls) && out.toolCalls.some(ok)) return true;
  if (Array.isArray(out.actionLog) && out.actionLog.some((a) => a && a.status === 'done')) return true;
  return false;
}

const HONEST = "Je n'ai rien exécuté pour cette demande : aucune action n'a été lancée et vérifiée, donc je ne peux pas la déclarer faite. Dites-moi précisément ce que vous voulez (par exemple « crée le service métier <nom> : type, prix, description »), je l'exécute réellement puis je vous confirme avec la preuve (ce qui a été créé, référence, statut).";

// out : résultat du tour (peut être null pour une réponse de conversation libre). Renvoie { text, blocked }.
function guard(text, out) {
  const t = String(text == null ? '' : text);
  if (!hasClaim(t) || hasEvidence(out)) return { text: t, blocked: false };
  try { console.warn(`claimGuard — affirmation d'accomplissement SANS preuve bloquée : « ${t.replace(/\s+/g, ' ').slice(0, 120)} »`); } catch (e) { /* journal seulement */ }
  return { text: HONEST, blocked: true, original: t };
}

// Côté CLIENT (réponse automatique) : aucun outil n'est exécuté pendant la conversation, donc toute affirmation À LA PREMIÈRE PERSONNE d'une action accomplie
// (« j'ai enregistré votre commande », « c'est fait ») est non vérifiée. Regex volontairement étroite : « la formation est en ligne » reste permis.
const CUSTOMER_CLAIM_RE = new RegExp([
  /c['’]est\s+(?:bien\s+)?(?:fait|parti)/.source,
  /j['’]ai\s+(?:bien\s+|d[ée]j[àa]\s+)?/.source + '(?:' + PART + '|mis\\s+en\\s+place|mis\\s+[àa]\\s+jour|r[ée]serv[ée]|valid[ée]|confirm[ée])',
  /votre\s+(?:commande|inscription|r[ée]servation|paiement|demande)\s+(?:est|a\s+[ée]t[ée])\s+(?:bien\s+)?(?:enregistr[ée]e?|valid[ée]e?|confirm[ée]e?|prise?\s+en\s+compte|trait[ée]e?|envoy[ée]e?)/.source,
].join('|'), 'i');
const hasCustomerClaim = (text) => { const t = String(text || ''); const m = t.match(CUSTOMER_CLAIM_RE); if (!m) return false; return !NEGATION_RE.test(t.slice(Math.max(0, m.index - 40), m.index + m[0].length + 20)); };

module.exports = { guard, hasClaim, hasCustomerClaim, hasEvidence, HONEST };
