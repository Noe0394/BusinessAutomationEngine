const EventEmitter = require('events');
const aiStudioStore = require('../lib/aiStudioStore');

// ORCHESTRATEUR INTER-MODULES — ai-engine/platformOrchestrator.js
// ---------------------------------------------------------------------------
// §2 du cahier des charges : bus d'événements unifié pour connecter les
// modules SANS dépendance rigide entre eux — les moteurs de campagne
// (queues/campaignEngine.js, queues/telegramCampaignEngine.js) ÉMETTENT un
// événement à chaque transition de santé réseau (voir
// onNetworkStatusChange, câblé depuis adapters/{whatsappManager,
// telegramManager}.js), ce module ÉCOUTE et traduit ça en notification dans
// le tchat — aucun des deux ne connaît l'existence de l'autre directement.
//
// §1.1 "Gestion Intelligente des Campagnes & Basculement Anti-Spam" :
// lib/circuitBreaker.js détectait DÉJÀ les signaux de surcharge (429,
// FLOOD_WAIT Telegram, timeout, reset de socket...) et mettait la file en
// pause avec reprise automatique par palier — ce qui MANQUAIT : (1) prévenir
// l'utilisateur dans le tchat (2) reconnaître un trouble PERSISTANT (2e échec
// consécutif) et le distinguer d'un simple aléa réseau isolé pour proposer le
// Mode Semi-Automatique — voir campaign.assistedMode dans les deux moteurs de
// campagne, qui pointe vers l'onglet "Relance Manuelle Express" déjà existant
// (public/dashboard.html) plutôt que de réinventer un envoi manuel.
const bus = new EventEmitter();
bus.setMaxListeners(50);

function channelLabel(channel) {
  return channel === 'TELEGRAM' ? 'Telegram' : 'WhatsApp';
}

function formatNetworkStatusMessage(evt) {
  const label = channelLabel(evt.channel);
  if (evt.status === 'degraded_network') {
    return `⚠️ Ralentissement détecté sur ${label} — la campagne ralentit automatiquement (pause de sécurité) pour protéger votre compte.`;
  }
  if (evt.status === 'circuit_open') {
    const mins = Math.max(1, Math.round((evt.retryAfterSeconds || 0) / 60));
    const base = `⚠️ Détection de restriction réseau sur ${label}. La campagne continue en mode sécurisé/temporisé pour protéger vos comptes.`;
    if (evt.assistedMode) {
      return `${base}\n🖐️ Le risque persiste (${evt.consecutiveOverloadFailures} alertes consécutives) — je bascule en **Mode Semi-Automatique** : je vous recommande de continuer via l'onglet "Relance Manuelle Express" le temps que ça se stabilise. Reprise auto de la campagne prévue dans ~${mins} min.`;
    }
    return `${base} Reprise automatique prévue dans ~${mins} min.`;
  }
  if (evt.status === 'normal') {
    return `✅ Réseau stabilisé sur ${label} — la campagne${evt.campaignName ? ` "${evt.campaignName}"` : ''} reprend en mode automatique normal.`;
  }
  return null;
}

// Pousse la notification dans la discussion Copywriter Studio IA la plus
// récemment active du tenant (créée à la volée si aucune n'existe encore) —
// il n'existe pas de concept de "notification" séparé du tchat dans ce
// dépôt : l'y intégrer directement est la façon la plus simple de la rendre
// visible, cohérente avec "il informe l'utilisateur dans le chat" (§1.1).
async function notifyTenantChat(tenantId, text, actionLog) {
  // Filet de sécurité : aucun identifiant technique WhatsApp (JID/LID) ne doit atteindre l'utilisateur.
  text = require('./contactIdentity').scrubTechnicalIds(text);
  const sessions = await aiStudioStore.listSessions(tenantId);
  let sessionId = sessions[0] && sessions[0].id;
  if (!sessionId) {
    const created = await aiStudioStore.createSession(tenantId);
    sessionId = created.id;
  }
  await aiStudioStore.appendMessages(tenantId, sessionId, [
    { role: 'assistant', text, createdAt: new Date().toISOString(), actionLog: actionLog || null },
  ], null);
}

bus.on('campaign:network_status', (evt) => {
  const text = formatNetworkStatusMessage(evt);
  if (!text || !evt.tenantId) return;
  notifyTenantChat(evt.tenantId, text, [{
    icon: evt.status === 'normal' ? '✅' : '⚠️',
    label: `Campagne ${channelLabel(evt.channel)} — ${evt.status}${evt.assistedMode ? ' (assisté)' : ''}`,
    status: evt.status === 'normal' ? 'done' : 'warning',
  }]).catch((err) => {
    console.error(`platformOrchestrator — échec de notification anti-spam (tenant "${evt.tenantId}") :`, err.message);
  });
});

// Point d'entrée appelé par adapters/{whatsappManager,telegramManager}.js
// (4e argument du constructeur CampaignEngine/TelegramCampaignEngine) —
// jamais l'inverse : les moteurs de campagne ignorent totalement
// l'existence de ce module, ils appellent juste le callback qu'on leur a
// injecté (même patron déjà en place pour onActivity).
function onCampaignNetworkStatusChange(evt) {
  bus.emit('campaign:network_status', evt);
}

try { require('./campaignContinuity').attach(bus); } catch (err) { console.error('campaignContinuity non attaché :', err.message); }

module.exports = { bus, onCampaignNetworkStatusChange, notifyTenantChat, formatNetworkStatusMessage };
