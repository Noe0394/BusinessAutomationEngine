// Service worker (MV3) — fait le pont entre la page CYRUS (externally_connectable)
// et l'onglet web.whatsapp.com / web.telegram.org (via content-relay.js +
// injected-bridge*.js). Un seul onglet géré par canal, réutilisé pour tous
// les envois de ce canal.

const CHANNELS = {
  whatsapp: { openUrl: 'https://web.whatsapp.com/', tabMatch: 'https://web.whatsapp.com/*', pageTarget: 'cyrus-wa-page' },
  telegram: { openUrl: 'https://web.telegram.org/k/', tabMatch: 'https://web.telegram.org/*', pageTarget: 'cyrus-tg-page' },
};

const SOURCE_TO_CHANNEL = { 'cyrus-wa-bridge': 'whatsapp', 'cyrus-tg-bridge': 'telegram' };

const SEND_TIMEOUT_MS = 25_000;
const GROUPS_TIMEOUT_MS = 15_000;

function freshState() {
  return { tabId: null, state: 'UNKNOWN', bridgeReady: false, pendingSend: null, pendingGroups: null, pendingGroupMembers: null };
}

const st = { whatsapp: freshState(), telegram: freshState() };

function channelForTab(tabId) {
  return Object.keys(st).find((ch) => st[ch].tabId === tabId) || null;
}

function resetChannelState(channel) {
  st[channel].tabId = null;
  st[channel].state = 'UNKNOWN';
  st[channel].bridgeReady = false;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const ch = channelForTab(tabId);
  if (ch) resetChannelState(ch);
});

async function ensureTab(channel, activate) {
  const s = st[channel];
  if (s.tabId) {
    try {
      const tab = await chrome.tabs.get(s.tabId);
      if (tab && !tab.discarded) {
        if (activate) await chrome.tabs.update(s.tabId, { active: true });
        return s.tabId;
      }
    } catch (e) {
      // Onglet fermé entre-temps — on en recrée un.
    }
    resetChannelState(channel);
  }
  const existing = await chrome.tabs.query({ url: CHANNELS[channel].tabMatch });
  if (existing.length) {
    s.tabId = existing[0].id;
    if (activate) await chrome.tabs.update(s.tabId, { active: true });
    return s.tabId;
  }
  const created = await chrome.tabs.create({ url: CHANNELS[channel].openUrl, active: !!activate });
  s.tabId = created.id;
  return s.tabId;
}

function sendCommandToPage(channel, type, payload) {
  const s = st[channel];
  if (!s.tabId) return;
  chrome.tabs.sendMessage(s.tabId, { target: CHANNELS[channel].pageTarget, type, payload }).catch(() => {
    // La page peut ne pas être prête (rechargement) — l'appelant a son propre timeout.
  });
}

// ---- Évènements remontés du pont (via content-relay.js) ----
chrome.runtime.onMessage.addListener((msg, sender) => {
  const channel = msg && SOURCE_TO_CHANNEL[msg.source];
  if (!channel) return;
  const s = st[channel];
  if (sender.tab) s.tabId = sender.tab.id;

  switch (msg.type) {
    case 'state':
      // WhatsApp expose un état direct (Socket.state, ex. 'CONNECTED') ;
      // Telegram expose seulement un booléen d'autorisation — normalisé ici
      // vers le même vocabulaire pour que le reste du fichier (et le
      // contrat côté CyrusEngine) ignore la différence entre les deux.
      if (channel === 'whatsapp') {
        s.state = (msg.payload && msg.payload.state) || 'UNKNOWN';
      } else {
        s.state = (msg.payload && msg.payload.authorized) ? 'CONNECTED' : 'UNPAIRED';
      }
      break;
    case 'bridge-ready':
      s.bridgeReady = true;
      break;
    case 'send-result':
      if (s.pendingSend) { s.pendingSend.resolve(msg.payload); s.pendingSend = null; }
      break;
    case 'groups':
      if (s.pendingGroups) { s.pendingGroups.resolve((msg.payload && msg.payload.groups) || []); s.pendingGroups = null; }
      break;
    case 'group-members':
      if (s.pendingGroupMembers) { s.pendingGroupMembers.resolve((msg.payload && msg.payload.members) || []); s.pendingGroupMembers = null; }
      break;
    case 'bridge-error':
      console.warn('[cyrus-bridge:' + channel + ']', msg.payload);
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
  const channel = message && message.channel === 'telegram' ? 'telegram' : 'whatsapp';
  const s = st[channel];

  if (action === 'ping') {
    return { ok: true, installed: true, waState: s.state, bridgeReady: s.bridgeReady, connected: s.state === 'CONNECTED' };
  }

  if (action === 'open') {
    await ensureTab(channel, true);
    return { ok: true };
  }

  if (action === 'getStatus') {
    if (!s.tabId) return { ok: true, connected: false, waState: 'UNKNOWN', bridgeReady: false };
    return { ok: true, connected: s.state === 'CONNECTED', waState: s.state, bridgeReady: s.bridgeReady };
  }

  if (action === 'sendMessage') {
    await ensureTab(channel, false);
    if (s.pendingSend) return { ok: false, error: 'ENVOI_DEJA_EN_COURS' };
    const result = await new Promise((resolve) => {
      s.pendingSend = { resolve };
      sendCommandToPage(channel, 'send', { to: message.to, text: message.text });
      setTimeout(() => {
        if (s.pendingSend) { s.pendingSend.resolve({ ok: false, error: 'TIMEOUT' }); s.pendingSend = null; }
      }, SEND_TIMEOUT_MS);
    });
    return Object.assign({ ok: !!result.ok }, result);
  }

  if (action === 'getGroups') {
    await ensureTab(channel, false);
    const groups = await new Promise((resolve) => {
      s.pendingGroups = { resolve };
      sendCommandToPage(channel, 'getGroups', {});
      setTimeout(() => {
        if (s.pendingGroups) { s.pendingGroups.resolve([]); s.pendingGroups = null; }
      }, GROUPS_TIMEOUT_MS);
    });
    return { ok: true, groups };
  }

  if (action === 'getGroupMembers') {
    await ensureTab(channel, false);
    const members = await new Promise((resolve) => {
      s.pendingGroupMembers = { resolve };
      sendCommandToPage(channel, 'getGroupMembers', { groupId: message.groupId });
      setTimeout(() => {
        if (s.pendingGroupMembers) { s.pendingGroupMembers.resolve([]); s.pendingGroupMembers = null; }
      }, GROUPS_TIMEOUT_MS);
    });
    return { ok: true, members };
  }

  return { ok: false, error: 'ACTION_INCONNUE:' + action };
}
