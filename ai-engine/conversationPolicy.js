// POLITIQUE DU RÉPONDEUR — ai-engine/conversationPolicy.js
// ---------------------------------------------------------------------------
// C'est LE endroit qui se pilote : trois réglages simples, valables partout, avec des exceptions par conversation ou par groupe.
//
//   private          Discussions privées :   auto (défaut : je parle business quand le sujet s'y prête, sinon je discute naturellement)
//                                            natural (toujours naturel, jamais de vente)  |  business (toujours orienté activité)
//   group            Groupes :               topic (défaut : je réponds si on s'adresse à moi, ou à une vraie question sur le thème d'un groupe métier)
//                                            addressed (seulement si on me mentionne / me répond / m'appelle)  |  off (silence)
//   presentServices  Présenter mes services : when-relevant (défaut : quand le sujet s'y prête et pas déjà fait récemment)
//                                            on-request (seulement si on me le demande)  |  never
//
// Exceptions : overrides["WHATSAPP:<id de la discussion>"] = { mode?, presentServices? } — ex. un groupe en « addressed », un contact en « natural ».
// Rien d'autre : pas de règle cachée. Le résultat d'une décision est toujours expliqué (voir engagement.js → why).
const PRIVATE_MODES = ['auto', 'natural', 'business'];
const GROUP_MODES = ['topic', 'addressed', 'off'];
const PRESENT_MODES = ['when-relevant', 'on-request', 'never'];

const DEFAULTS = Object.freeze({
  private: 'auto', group: 'topic', presentServices: 'when-relevant',
  windowDays: 7, groupMaxRepliesPer10Min: 4, aiJudgment: true, overrides: {},
});

const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const keyOf = (channel, id) => `${String(channel || 'WHATSAPP').toUpperCase()}:${String(id || '').trim()}`;

// Nettoie/valide une politique brute (jamais de valeur inconnue enregistrée).
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const overrides = {};
  for (const [k, v] of Object.entries(r.overrides && typeof r.overrides === 'object' ? r.overrides : {}).slice(0, 200)) {
    if (!/^(WHATSAPP|TELEGRAM):.+/.test(k) || !v || typeof v !== 'object') continue;
    const o = {};
    if ([...PRIVATE_MODES, ...GROUP_MODES].includes(v.mode)) o.mode = v.mode;
    if (PRESENT_MODES.includes(v.presentServices)) o.presentServices = v.presentServices;
    if (Object.keys(o).length) overrides[k] = o;
  }
  return {
    private: PRIVATE_MODES.includes(r.private) ? r.private : DEFAULTS.private,
    group: GROUP_MODES.includes(r.group) ? r.group : DEFAULTS.group,
    presentServices: PRESENT_MODES.includes(r.presentServices) ? r.presentServices : DEFAULTS.presentServices,
    windowDays: clampInt(r.windowDays, 1, 7, DEFAULTS.windowDays),
    groupMaxRepliesPer10Min: clampInt(r.groupMaxRepliesPer10Min, 1, 30, DEFAULTS.groupMaxRepliesPer10Min),
    aiJudgment: r.aiJudgment === false ? false : true,
    overrides,
  };
}

// Politique effective d'un compte : réglage enregistré, ou — pour les comptes qui n'ont jamais rien choisi — l'ancien interrupteur groupReplies.
function fromSettings(settings) {
  const s = settings || {};
  const p = normalize(s.conversationPolicy);
  if (!s.conversationPolicy && s.groupReplies === false) p.group = 'addressed';
  if (!s.conversationPolicy && s.groupReplies === true) p.openGroups = true; // ancien réglage : réponses aux demandes commerciales dans tout groupe
  return p;
}
async function get(tenant) { return fromSettings(await require('./autoResponder').getSettings(tenant)); }

// Applique un patch { private?, group?, presentServices?, windowDays?, groupMaxRepliesPer10Min?, override?: {channel,id,mode?,presentServices?, clear?} }.
async function set(tenant, patch) {
  const ar = require('./autoResponder');
  const cur = fromSettings(await ar.getSettings(tenant));
  const p = patch || {};
  const next = Object.assign({}, cur);
  for (const k of ['private', 'group', 'presentServices', 'windowDays', 'groupMaxRepliesPer10Min', 'aiJudgment']) if (p[k] !== undefined) next[k] = p[k];
  if (p.override && p.override.id) {
    const k = keyOf(p.override.channel, p.override.id);
    const ov = Object.assign({}, cur.overrides);
    if (p.override.clear) delete ov[k]; else ov[k] = { mode: p.override.mode, presentServices: p.override.presentServices };
    next.overrides = ov;
  }
  const clean = normalize(next);
  await ar.setSettings(tenant, { conversationPolicy: clean });
  return clean;
}

// Politique appliquée à UNE discussion (réglage global + exception éventuelle).
function resolveFor(policy, channel, id, isGroup) {
  const p = policy || DEFAULTS; const ov = (p.overrides || {})[keyOf(channel, id)] || {};
  const mode = isGroup ? (GROUP_MODES.includes(ov.mode) ? ov.mode : p.group) : (PRIVATE_MODES.includes(ov.mode) ? ov.mode : p.private);
  return { mode, presentServices: ov.presentServices || p.presentServices, windowDays: p.windowDays, groupMaxRepliesPer10Min: p.groupMaxRepliesPer10Min, aiJudgment: p.aiJudgment !== false, openGroups: p.openGroups === true, overridden: !!Object.keys(ov).length };
}

const LABELS = {
  private: { auto: 'Automatique : je parle business quand le sujet s\'y prête, sinon je discute naturellement', natural: 'Toujours naturel : jamais de vente ni de présentation', business: 'Toujours orienté activité' },
  group: { topic: 'Je réponds si on s\'adresse à moi, ou à une vraie question sur le thème d\'un groupe lié à votre activité', addressed: 'Seulement si on me mentionne, me répond ou m\'appelle', off: 'Silence dans les groupes' },
  presentServices: { 'when-relevant': 'Quand le sujet s\'y prête (et pas déjà fait récemment)', 'on-request': 'Seulement si on me le demande', never: 'Jamais' },
};
function describe(policy) {
  const p = policy || DEFAULTS;
  return [
    `Discussions privées : ${LABELS.private[p.private]}.`,
    `Groupes : ${LABELS.group[p.group]}.`,
    `Présentation de vos services : ${LABELS.presentServices[p.presentServices]}.`,
    `Mémoire utilisée : ${p.windowDays} jour(s). Limite en groupe : ${p.groupMaxRepliesPer10Min} réponse(s) / 10 min.`,
    p.aiJudgment === false ? 'Cas ambigus : décidés par les règles seules (l\'IA ne tranche pas).' : 'Cas ambigus : c\'est l\'IA (cascade de modèles) qui tranche, en moins de 2 secondes, dans les limites de vos réglages.',
    Object.keys(p.overrides || {}).length ? `Exceptions : ${Object.entries(p.overrides).map(([k, v]) => `${k} → ${[v.mode, v.presentServices].filter(Boolean).join(' / ')}`).join(' ; ')}.` : 'Aucune exception par conversation.',
  ];
}

module.exports = { PRIVATE_MODES, GROUP_MODES, PRESENT_MODES, DEFAULTS, normalize, fromSettings, get, set, resolveFor, describe, keyOf };
