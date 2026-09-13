// Service worker (MV3) — fait le pont entre la page CYRUS (externally_connectable)
// et l'onglet web.whatsapp.com (via content-relay.js + injected-bridge.js).
// Un seul onglet WhatsApp Web géré, réutilisé pour tous les envois.

let waTabId = null;
let waState = 'UNKNOWN'; // reflète Socket.state de WhatsApp Web ('CONNECTED' = prêt)
let bridgeReady = false;
let pendingSend = null; // { resolve }
let pendingGroups = null;
let pendingGroupMembers = null;

const SEND_TIMEOUT_MS = 25_000;
const GROUPS_TIMEOUT_MS = 15_000;

function resetTabState() {
  waTabId = null;
  waState = 'UNKNOWN';
  bridgeReady = false;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === waTabId) resetTabState();
});

async function ensureWaTab(activate) {
  if (waTabId) {
    try {
      const tab = await chrome.tabs.get(waTabId);
      if (tab && !tab.discarded) {
        if (activate) await chrome.tabs.update(waTabId, { active: true });
        return waTabId;
      }
    } catch (e) {
      // Onglet fermé entre-temps — on en recrée un.
    }
    resetTabState();
  }
  const existing = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  if (existing.length) {
    waTabId = existing[0].id;
    if (activate) await chrome.tabs.update(waTabId, { active: true });
    return waTabId;
  }
  const created = await chrome.tabs.create({ url: 'https://web.whatsapp.com/', active: !!activate });
  waTabId = created.id;
  return waTabId;
}

function sendCommandToPage(type, payload) {
  if (!waTabId) return;
  chrome.tabs.sendMessage(waTabId, { target: 'cyrus-wa-page', type, payload }).catch(() => {
    // La page peut ne pas être prête (rechargement) — l'appelant a son propre timeout.
  });
}

// ---- Évènements remontés du pont (via content-relay.js) ----
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.source !== 'cyrus-wa-bridge') return;
  if (sender.tab) waTabId = sender.tab.id;

  switch (msg.type) {
    case 'state':
      waState = (msg.payload && msg.payload.state) || 'UNKNOWN';
      break;
    case 'bridge-ready':
      bridgeReady = true;
      break;
    case 'send-result':
      if (pendingSend) { pendingSend.resolve(msg.payload); pendingSend = null; }
      break;
    case 'groups':
      if (pendingGroups) { pendingGroups.resolve((msg.payload && msg.payload.groups) || []); pendingGroups = null; }
      break;
    case 'group-members':
      if (pendingGroupMembers) { pendingGroupMembers.resolve((msg.payload && msg.payload.members) || []); pendingGroupMembers = null; }
      break;
    case 'bridge-error':
      console.warn('[cyrus-wa-bridge]', msg.payload);
      break;
    default:
      break;
  }
});

// ---- Requêtes externes (page CYRUS, voir manifest.json#externally_connectable) ----
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  handleExternalMessage(message).then(sendResponse).catch((err) => {
    sendResponse({ ok: false, error: String((err && err.message) || err) });
  });
  return true; // réponse asynchrone
});

async function handleExternalMessage(message) {
  const action = message && message.action;

  if (action === 'ping') {
    return { ok: true, installed: true, waState, bridgeReady, connected: waState === 'CONNECTED' };
  }

  if (action === 'openWhatsApp') {
    await ensureWaTab(true);
    return { ok: true };
  }

  if (action === 'getStatus') {
    if (!waTabId) return { ok: true, connected: false, waState: 'UNKNOWN', bridgeReady: false };
    return { ok: true, connected: waState === 'CONNECTED', waState, bridgeReady };
  }

  if (action === 'sendMessage') {
    await ensureWaTab(false);
    if (pendingSend) return { ok: false, error: 'ENVOI_DEJA_EN_COURS' };
    const result = await new Promise((resolve) => {
      pendingSend = { resolve };
      sendCommandToPage('send', { to: message.to, text: message.text });
      setTimeout(() => {
        if (pendingSend) { pendingSend.resolve({ ok: false, error: 'TIMEOUT' }); pendingSend = null; }
      }, SEND_TIMEOUT_MS);
    });
    return Object.assign({ ok: !!result.ok }, result);
  }

  if (action === 'getGroups') {
    await ensureWaTab(false);
    const groups = await new Promise((resolve) => {
      pendingGroups = { resolve };
      sendCommandToPage('getGroups', {});
      setTimeout(() => {
        if (pendingGroups) { pendingGroups.resolve([]); pendingGroups = null; }
      }, GROUPS_TIMEOUT_MS);
    });
    return { ok: true, groups };
  }

  if (action === 'getGroupMembers') {
    await ensureWaTab(false);
    const members = await new Promise((resolve) => {
      pendingGroupMembers = { resolve };
      sendCommandToPage('getGroupMembers', { groupId: message.groupId });
      setTimeout(() => {
        if (pendingGroupMembers) { pendingGroupMembers.resolve([]); pendingGroupMembers = null; }
      }, GROUPS_TIMEOUT_MS);
    });
    return { ok: true, members };
  }

  return { ok: false, error: 'ACTION_INCONNUE:' + action };
}
