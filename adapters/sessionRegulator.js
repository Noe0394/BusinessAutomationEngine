// Régulateur intelligent de sessions, partagé par whatsappManager.js et
// telegramManager.js : sur une instance Render à faible RAM, on ne peut pas
// laisser un nombre illimité de sessions (WhatsApp + Telegram confondues)
// s'accumuler en mémoire indéfiniment — chaque session ouverte (socket
// Baileys ou client MTProto, timers de heartbeat/reconnexion/synchronisation
// GitHub) a un coût mémoire réel, même sans navigateur/Puppeteer impliqué.
//
// Politique appliquée quand la limite est atteinte et qu'un tenant encore
// jamais vu se connecte (voir ensureCapacity, appelée par getOrCreate AVANT
// de créer la nouvelle instance) :
//   1. Libérer une session inactive depuis plus de SESSION_IDLE_EVICTION_MS
//      (aucune requête ni aucun envoi de message depuis ce délai).
//   2. À défaut, libérer la session la plus ancienne SANS campagne en cours
//      d'envoi.
//   3. Si toutes les sessions actives ont une campagne en cours, refuser la
//      nouvelle connexion avec un message clair pour l'interface plutôt que
//      de saturer la RAM du process.
// Le tenant admin (voir ADMIN_TENANT_ID dans les deux gestionnaires) est
// exclu de l'éviction : c'est la session du propriétaire de la plateforme,
// jamais sacrifiée pour faire de la place à une clé de licence cliente.
const MAX_ACTIVE_SESSIONS = Math.max(1, parseInt(process.env.MAX_ACTIVE_SESSIONS, 10) || 8);
const IDLE_EVICTION_MS = Math.max(60_000, parseInt(process.env.SESSION_IDLE_EVICTION_MS, 10) || 15 * 60 * 1000);

const SESSION_LIMIT_MESSAGE = 'Serveur actuellement sollicité : la limite de sessions simultanées est atteinte. Veuillez patienter quelques minutes qu\'une place se libère.';

class SessionLimitError extends Error {
  constructor(message) {
    super(message);
    this.code = 'SESSION_LIMIT_REACHED';
  }
}

// Clé composite kind:tenantId — WhatsApp et Telegram comptent chacun pour un
// "slot" dans le même plafond global (la contrainte réelle est la RAM du
// process, pas le protocole utilisé), mais un même tenantId (même clé de
// licence) sur les deux canaux occupe bien deux entrées distinctes.
const registry = new Map();

function registryKey(kind, tenantId) {
  return `${kind}:${tenantId}`;
}

// descriptor = { hasActiveCampaign(), dispose(), onEvicted(), protected }
function register(kind, tenantId, descriptor) {
  const now = Date.now();
  registry.set(registryKey(kind, tenantId), {
    kind,
    tenantId,
    createdAt: now,
    lastActivityAt: now,
    ...descriptor,
  });
}

function unregister(kind, tenantId) {
  registry.delete(registryKey(kind, tenantId));
}

// À appeler à chaque interaction significative d'un tenant déjà actif : une
// requête HTTP entrante (voir attachWhatsapp/attachTelegram dans index.js)
// aussi bien qu'un message effectivement envoyé par une campagne en tâche de
// fond (voir le callback onActivity passé aux moteurs de campagne) — les deux
// signaux repoussent l'échéance d'inactivité de 15 minutes.
function touch(kind, tenantId) {
  const entry = registry.get(registryKey(kind, tenantId));
  if (entry) entry.lastActivityAt = Date.now();
}

function pickEvictionCandidate() {
  const now = Date.now();
  const candidates = Array.from(registry.values()).filter((c) => !c.protected);

  const idleCandidates = candidates
    .filter((c) => now - c.lastActivityAt > IDLE_EVICTION_MS)
    .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
  if (idleCandidates.length > 0) {
    return { entry: idleCandidates[0], reason: 'inactive depuis plus de 15 minutes' };
  }

  const withoutCampaign = candidates
    .filter((c) => !c.hasActiveCampaign())
    .sort((a, b) => a.createdAt - b.createdAt);
  if (withoutCampaign.length > 0) {
    return { entry: withoutCampaign[0], reason: 'la plus ancienne session sans campagne en cours' };
  }

  return null;
}

// Appelée par whatsappManager.getOrCreate/telegramManager.getOrCreate juste
// avant d'instancier une session pour un tenant pas encore dans le registre.
// Ne fait rien si ce tenant a déjà une entrée (reconnexion normale, pas une
// nouvelle session) ou si on est encore sous la limite. Lève SessionLimitError
// si la limite est atteinte et qu'aucune session n'est éligible à l'éviction.
function ensureCapacity(kind, tenantId) {
  if (registry.has(registryKey(kind, tenantId))) return;
  if (registry.size < MAX_ACTIVE_SESSIONS) return;

  const picked = pickEvictionCandidate();
  if (!picked) {
    throw new SessionLimitError(SESSION_LIMIT_MESSAGE);
  }

  const { entry, reason } = picked;
  console.log(
    `Régulateur de sessions : libération de la session ${entry.kind}/${entry.tenantId} (${reason}) pour céder la place à ${kind}/${tenantId}.`,
  );

  unregister(entry.kind, entry.tenantId);
  try {
    entry.dispose();
  } catch (err) {
    console.error(`Régulateur de sessions : erreur pendant la libération de ${entry.kind}/${entry.tenantId} :`, err.message);
  }
  try {
    entry.onEvicted();
  } catch (err) {
    console.error(`Régulateur de sessions : erreur pendant le nettoyage post-éviction de ${entry.kind}/${entry.tenantId} :`, err.message);
  }
}

module.exports = {
  MAX_ACTIVE_SESSIONS,
  IDLE_EVICTION_MS,
  SessionLimitError,
  register,
  unregister,
  touch,
  ensureCapacity,
};
