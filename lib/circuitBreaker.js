// Supervision de santé réseau et coupe-circuit (Circuit Breaker & QoS
// Monitoring), partagée par les deux moteurs de campagne (voir
// queues/campaignEngine.js et queues/telegramCampaignEngine.js) : détecte les
// signes de surcharge du service distant (latence anormale, HTTP 429, reset
// de socket, timeout d'accusé de réception...) et met la file d'attente en
// pause plutôt que de continuer à insister sur un service qui signale déjà
// qu'il est débordé — c'est le comportement attendu par toute API bien
// documentée (respecter un 429), pas une technique d'évasion.

// Seuil de latence (ms) au-delà duquel une requête d'envoi est considérée
// comme anormalement lente.
const LATENCY_THRESHOLD_MS = 6000;

// Durée de suspension de la file après 2 requêtes consécutives dépassant
// LATENCY_THRESHOLD_MS (statut 'degraded_network').
const DEGRADED_NETWORK_PAUSE_MS = 15 * 60 * 1000;

// Palier de mise en veille progressif (Exponential Backoff) appliqué au
// statut 'circuit_open' : 15 min au 1er échec de surcharge, 45 min à partir
// du 2e — la dernière valeur du tableau sert de plafond pour tout échec
// suivant (pas de croissance indéfinie).
const CIRCUIT_BACKOFF_MS = [15 * 60 * 1000, 45 * 60 * 1000];

// Intervalle entre deux tentatives de health check tant que le signal n'est
// pas nominal à l'expiration du délai de mise en veille.
const HEALTH_RECHECK_INTERVAL_MS = 30 * 1000;

// Extrait la durée d'attente EXACTE exigée par Telegram pour une erreur
// FLOOD_WAIT_X (Rate Limit), en secondes converties en millisecondes.
// GramJS expose déjà cette durée sur `err.seconds` (voir FloodWaitError dans
// telegram/errors/RPCErrorList.js) ; le repli sur une extraction du message
// (FLOOD_WAIT_120, "A wait of 120 seconds is required"...) couvre le cas où
// l'erreur remonterait sous une autre forme (ex: rejetée par une couche
// intermédiaire qui ne préserverait pas la propriété `seconds`). Retourne
// null si l'erreur n'est pas un FLOOD_WAIT chiffré — le coupe-circuit retombe
// alors sur le palier générique (CIRCUIT_BACKOFF_MS) ci-dessous.
function getFloodWaitMs(err) {
  if (!err) return null;
  if (Number.isFinite(err.seconds) && err.seconds >= 0) {
    return err.seconds * 1000;
  }
  const text = String(err.message || err.errorMessage || '');
  const match = text.match(/FLOOD_WAIT_(\d+)/i) || text.match(/wait of (\d+) seconds?/i);
  return match ? parseInt(match[1], 10) * 1000 : null;
}

// Détecte, à partir de la forme (volontairement hétérogène) des erreurs
// remontées par Baileys (WhatsApp) et GramJS (Telegram), un signal de
// surcharge du service distant plutôt qu'une erreur "métier" (destinataire
// invalide, contenu refusé...) — seul le premier cas doit déclencher le
// coupe-circuit ; le second doit continuer à être compté comme un échec
// normal du destinataire courant.
function isOverloadError(err) {
  if (!err) return false;

  const status = err.status || err.statusCode || (err.output && err.output.statusCode);
  if (status === 429) return true;

  const code = String(err.code || '').toUpperCase();
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE' || code === 'ECONNABORTED') {
    return true;
  }

  const message = String(err.message || err.errorMessage || '').toUpperCase();
  return (
    message.includes('429')
    || message.includes('FLOOD') // Telegram FloodWaitError / FLOOD_WAIT_X
    || message.includes('RATE-OVERLIMIT') // Baileys (WhatsApp) rate limiting
    || message.includes('RATE LIMIT')
    || message.includes('TIMED OUT')
    || message.includes('TIMEOUT')
    || message.includes('ECONNRESET')
    || message.includes('SOCKET HANG UP')
    || message.includes('CONNECTION CLOSED')
  );
}

// État du coupe-circuit, une instance par moteur de campagne (pas persistée :
// c'est un signal de santé réseau "live", comme incomingPauseUntil dans les
// moteurs de campagne — un redémarrage du process reprend avec un compteur
// d'échecs à zéro plutôt que de figer une pause déjà entamée).
class CircuitBreakerState {
  constructor() {
    this.consecutiveSlowSends = 0;
    this.consecutiveOverloadFailures = 0;
    this.holdUntil = 0;
    // 'normal' | 'degraded_network' | 'circuit_open'
    this.networkStatus = 'normal';
  }

  // À appeler après CHAQUE requête d'envoi individuelle ayant abouti (même
  // lentement), avec son temps de réponse mesuré. Retourne true si cet appel
  // vient de déclencher la mise en pause 'degraded_network'.
  recordLatency(elapsedMs) {
    if (elapsedMs <= LATENCY_THRESHOLD_MS) {
      this.consecutiveSlowSends = 0;
      return false;
    }

    this.consecutiveSlowSends += 1;
    if (this.consecutiveSlowSends < 2) {
      return false;
    }

    this.consecutiveSlowSends = 0;
    this.networkStatus = 'degraded_network';
    this.holdUntil = Date.now() + DEGRADED_NETWORK_PAUSE_MS;
    return true;
  }

  // À appeler dès qu'un envoi aboutit normalement : réarme le compteur
  // d'échecs de surcharge à zéro. Ne touche PAS networkStatus/holdUntil —
  // l'envoi qui vient de déclencher recordLatency() (ci-dessus) est
  // lui-même réussi ; c'est seulement _waitForNetworkHold() (voir les
  // moteurs de campagne), à l'expiration effective de la pause ET après un
  // health check positif, qui doit repasser le statut à 'normal'.
  recordSuccess() {
    this.consecutiveOverloadFailures = 0;
  }

  // À appeler quand isOverloadError(err) est vrai pour l'erreur reçue.
  // Retourne la durée (ms) du palier de mise en veille appliqué. Si `err` est
  // un FLOOD_WAIT Telegram chiffré (voir getFloodWaitMs), la pause est
  // équivalente au temps EXACT exigé par l'API plutôt qu'au palier générique
  // ci-dessous — respecter Telegram à la lettre, sans attendre plus ni moins
  // que ce qu'il exige avant de reprendre la file d'attente.
  recordOverloadFailure(err) {
    this.consecutiveOverloadFailures += 1;
    const floodWaitMs = getFloodWaitMs(err);
    let backoffMs;
    if (floodWaitMs !== null) {
      backoffMs = floodWaitMs;
    } else {
      const tier = Math.min(this.consecutiveOverloadFailures, CIRCUIT_BACKOFF_MS.length) - 1;
      backoffMs = CIRCUIT_BACKOFF_MS[tier];
    }
    this.networkStatus = 'circuit_open';
    this.holdUntil = Date.now() + backoffMs;
    return backoffMs;
  }

  isHeld() {
    return Date.now() < this.holdUntil;
  }

  // Délai restant (secondes, arrondi au-dessus) avant la reprise automatique
  // de la file — exposé tel quel par getStatus() dans les deux moteurs de
  // campagne pour alimenter le décompte dynamique côté dashboard
  // ("Reprise automatique dans : MM min SS sec"). 0 tant qu'aucune pause de
  // sécurité n'est active.
  getRetryAfterSeconds() {
    if (!this.isHeld()) return 0;
    return Math.max(0, Math.ceil((this.holdUntil - Date.now()) / 1000));
  }

  // Sérialisation pour persistance (voir _buildRecord() dans les deux
  // moteurs de campagne) : un redéploiement/crash en pleine pause de
  // sécurité (jusqu'à 45 min pour un 2e échec de surcharge) ne doit pas
  // faire perdre ce délai — sans ça, le process relance l'envoi
  // immédiatement au redémarrage, aussi surchargé le service distant
  // soit-il encore.
  toJSON() {
    return {
      consecutiveSlowSends: this.consecutiveSlowSends,
      consecutiveOverloadFailures: this.consecutiveOverloadFailures,
      holdUntil: this.holdUntil,
      networkStatus: this.networkStatus,
    };
  }

  static fromJSON(data) {
    const state = new CircuitBreakerState();
    if (!data || typeof data !== 'object') return state;
    if (Number.isFinite(data.consecutiveSlowSends)) state.consecutiveSlowSends = data.consecutiveSlowSends;
    if (Number.isFinite(data.consecutiveOverloadFailures)) state.consecutiveOverloadFailures = data.consecutiveOverloadFailures;
    if (Number.isFinite(data.holdUntil)) state.holdUntil = data.holdUntil;
    if (['normal', 'degraded_network', 'circuit_open'].includes(data.networkStatus)) state.networkStatus = data.networkStatus;
    return state;
  }
}

module.exports = {
  isOverloadError,
  getFloodWaitMs,
  CircuitBreakerState,
  LATENCY_THRESHOLD_MS,
  DEGRADED_NETWORK_PAUSE_MS,
  CIRCUIT_BACKOFF_MS,
  HEALTH_RECHECK_INTERVAL_MS,
};
