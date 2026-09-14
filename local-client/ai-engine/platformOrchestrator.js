// ADAPTATEUR local-client de ai-engine/platformOrchestrator.js (VPS) —
// même rôle (notifyTenantChat), mécanisme différent : pas de session de
// tchat persistée côté serveur ici (voir lib/aiGateway.js — le client
// garde l'historique, /api/ai/text est stateless), donc pas d'équivalent
// direct de lib/aiStudioStore.js à écrire dedans.
//
// À la place : une file d'attente EN MÉMOIRE de notifications, vidée par un
// nouvel endpoint GET /api/notifications (voir index.js) que le frontend
// (public/app.js) sonde périodiquement pour afficher un bandeau/toast —
// mono-poste, mono-utilisateur, aucun tenantId à distinguer (paramètre
// conservé pour garder EXACTEMENT la même signature que la version VPS,
// simplement ignoré ici).
//
// §1.1/§2 du cahier des charges "Orchestrateur Inter-Modules" (supervision
// anti-spam des campagnes) NON câblé ici : lib/campaigns.js (moteur de
// campagne local-client, whatsapp-web.js/GramJS) n'a pas d'équivalent du
// coupe-circuit lib/circuitBreaker.js du VPS — rien à superviser pour
// l'instant. `notifyTenantChat` reste utilisé par ai-engine/emotionalCloser.js
// (escalade prospect, remontée de feedback), pleinement fonctionnel.
'use strict';

const pendingNotifications = [];
const MAX_PENDING = 50;

function notifyTenantChat(tenantId, text, actionLog) {
  pendingNotifications.push({ text, actionLog: actionLog || null, at: new Date().toISOString() });
  if (pendingNotifications.length > MAX_PENDING) pendingNotifications.shift();
  return Promise.resolve();
}

// Consommée par GET /api/notifications — vide la file à chaque appel (les
// notifications ne sont montrées qu'une fois, comme un toast).
function drainNotifications() {
  return pendingNotifications.splice(0, pendingNotifications.length);
}

module.exports = { notifyTenantChat, drainNotifications };
