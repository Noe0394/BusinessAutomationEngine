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

// Balayage PROACTIF (voir startIdleSweep plus bas) : jusqu'ici, une session
// inactive n'était jamais libérée tant que la limite MAX_ACTIVE_SESSIONS
// n'était pas atteinte par un AUTRE tenant (voir ensureCapacity) — adapté à
// Render/Koyeb en RAM contrainte, où peu de tenants tournent en parallèle et
// la pression mémoire ne vient quasiment que du nombre de sessions
// simultanées. Sur un serveur dédié long-terme (VPS), le vrai risque est
// plutôt l'accumulation lente de sessions JAMAIS revisitées (WhatsApp/
// Telegram connectés en permanence sans jamais être sollicités) qui ne
// libèrent donc jamais leur mémoire (sockets, timers) faute de pression de
// capacité. PROACTIVE_IDLE_DISCONNECT_MS (1h par défaut) déclenche la même
// libération douce (dispose(), PAS logout()) indépendamment de la capacité :
// les identifiants restent valides, la reconnexion à la prochaine action est
// transparente, sans réappairage QR — seul le connecteur réseau (socket
// Baileys/MTProto) est coupé pour rendre la mémoire correspondante tant
// qu'aucune activité ne le justifie.
const PROACTIVE_IDLE_DISCONNECT_MS = Math.max(60_000, parseInt(process.env.PROACTIVE_IDLE_DISCONNECT_MS, 10) || 60 * 60 * 1000);
const IDLE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

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

  // Ce premier palier (inactivité) ne filtre PAS hasActiveCampaign() comme le
  // second ci-dessous : une campagne en pause (réseau, FLOOD_WAIT de
  // plusieurs heures...) ne génère aucune activité pendant l'attente et
  // deviendrait donc éligible ici. Sans danger pour la campagne elle-même —
  // dispose() (voir whatsappManager.js/telegramManager.js) la met en pause
  // AVANT de couper la session plutôt que de l'abandonner, et elle reprend
  // dès la reconnexion de ce tenant (ou un clic sur "Reprendre").
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

// Libère (dispose(), jamais logout()) toute session non protégée inactive
// depuis plus de PROACTIVE_IDLE_DISCONNECT_MS, qu'il y ait ou non pression de
// capacité — voir le commentaire sur PROACTIVE_IDLE_DISCONNECT_MS ci-dessus.
// Une campagne en pause (FLOOD_WAIT de plusieurs heures, réseau...) reste
// éligible ici comme dans pickEvictionCandidate : dispose() la met en pause
// AVANT de couper la connexion, jamais abandonnée.
function sweepIdleSessions() {
  const now = Date.now();
  Array.from(registry.values())
    .filter((entry) => !entry.protected && now - entry.lastActivityAt > PROACTIVE_IDLE_DISCONNECT_MS)
    .forEach((entry) => {
      console.log(
        `Régulateur de sessions : libération proactive de ${entry.kind}/${entry.tenantId} (inactif depuis plus de ${Math.round(PROACTIVE_IDLE_DISCONNECT_MS / 60000)} min).`,
      );
      unregister(entry.kind, entry.tenantId);
      try {
        entry.dispose();
      } catch (err) {
        console.error(`Régulateur de sessions : erreur pendant la libération proactive de ${entry.kind}/${entry.tenantId} :`, err.message);
      }
      try {
        entry.onEvicted();
      } catch (err) {
        console.error(`Régulateur de sessions : erreur pendant le nettoyage post-libération de ${entry.kind}/${entry.tenantId} :`, err.message);
      }
    });
}

let sweepTimer = null;

// À appeler une seule fois au démarrage du process (voir index.js). Idempotent
// (un second appel n'ajoute pas un second timer).
function startIdleSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepIdleSessions, IDLE_SWEEP_INTERVAL_MS);
  if (sweepTimer.unref) sweepTimer.unref();
}

module.exports = {
  MAX_ACTIVE_SESSIONS,
  IDLE_EVICTION_MS,
  PROACTIVE_IDLE_DISCONNECT_MS,
  SessionLimitError,
  register,
  unregister,
  touch,
  ensureCapacity,
  startIdleSweep,
};
