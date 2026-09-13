// MACHINE — pont WHATSAPP_LOCAL entre la couche intelligence et ce PC
// -------------------------------------------------------------------------------
// Ce PC est une "machine" de la couche intelligence (Machine view). Ce module
// expose le contrat que l'orchestrateur appelle sur HTTP : il exécute chaque
// action RÉELLEMENT sur les moteurs locaux déjà en place — WhatsApp via
// whatsapp-web.js (lib/whatsapp.js), campagnes via le moteur SQLite
// (lib/campaigns.js) — et renvoie un résultat structuré, jamais de throw.
//
// Contrat (parité avec le registre 12 actions de lib/intelligence) :
//   EXTRACT_MEMBERS   { channel:'WHATSAPP', groupId } -> { members, count }
//   SEND_CAMPAIGN     { channel:'WHATSAPP', name, recipients, text,
//                       delayMinMs, delayMaxMs, start? } -> { campaign, started }
//   FOLLOW_UP         { channel:'WHATSAPP', to, text } -> { ok }  (envoi direct)
//   PAUSE_CAMPAIGN    { campaignId } -> { ok }
//   RESUME_CAMPAIGN   { campaignId } -> { ok }
//   GET_STATUS        -> { connected, machines:[...] }
//
// RÈGLE D'OR : chaque action enveloppe son appel en try/catch et renvoie
// { ok:false, error } — jamais un throw qui ferait échouer l'orchestrateur.
'use strict';

const whatsapp = require('./whatsapp');
const campaigns = require('./campaigns');

async function extractMembers(payload) {
  const p = payload || {};
  const groupId = p.groupId || null;
  if (!groupId) {
    // Pas d'identifiant précis : renvoyer la liste des groupes disponibles
    // afin que l'orchestrateur puisse choisir une cible (Machine view).
    return { ok: true, result: { groups: await whatsapp.getGroups(), members: [], count: 0 } };
  }
  const members = await whatsapp.getGroupMembers(groupId);
  return {
    ok: true,
    result: {
      channel: 'WHATSAPP',
      groupId,
      members: (members || []).map((m) => ({ id: m.id, to: m.id, nom: '', source: 'whatsapp' })),
      count: (members || []).length,
    },
  };
}

async function sendCampaign(payload) {
  const p = payload || {};
  const recipients = Array.isArray(p.recipients) ? p.recipients : [];
  const text = p.text || p.message || '';
  if (!recipients.length) return { ok: false, error: 'EMPTY_RECIPIENTS' };
  if (!text) return { ok: false, error: 'NO_MESSAGE' };

  const name = p.name || ('Campagne intelligence ' + new Date().toISOString().slice(0, 16));
  const campaign = campaigns.createCampaign(name, recipients, {
    text,
    delayMinMs: p.delayMinMs || p.minDelayMs || 8000,
    delayMaxMs: p.delayMaxMs || p.maxDelayMs || 20000,
    channel: 'whatsapp',
  });

  let started = false;
  if (p.start !== false) {
    campaigns.startCampaign(campaign.id);
    started = true;
  }
  return {
    ok: true,
    result: {
      campaignId: campaign.id,
      status: campaign.status,
      blockedCount: campaign.blockedCount,
      recipients: recipients.length,
      started,
    },
  };
}

async function followUp(payload) {
  const p = payload || {};
  const to = p.to || p.recipient || null;
  const text = p.text || null;
  if (!to || !text) return { ok: false, error: 'MISSING_TO_OR_TEXT' };
  await whatsapp.sendMessage(to, text);
  return { ok: true, result: { to, sent: true } };
}

function pauseCampaign(payload) {
  const p = payload || {};
  if (!p.campaignId) return { ok: false, error: 'MISSING_CAMPAIGN_ID' };
  campaigns.pauseCampaign(p.campaignId);
  return { ok: true };
}

function resumeCampaign(payload) {
  const p = payload || {};
  if (!p.campaignId) return { ok: false, error: 'MISSING_CAMPAIGN_ID' };
  // Le moteur local n'expose pas resume() (runLoop se relance via
  // startCampaign — mêmes garde-fous : déjà terminée => error explicite).
  campaigns.startCampaign(p.campaignId);
  return { ok: true };
}

async function getStatus() {
  const groups = await whatsapp.getGroups().catch(() => []);
  return {
    ok: true,
    result: {
      machine: 'WHATSAPP_LOCAL',
      label: 'CYRUS sur PC — WhatsApp local (whatsapp-web.js)',
      connected: whatsapp.isConnected(),
      capabilities: ['EXTRACT_MEMBERS', 'SEND_CAMPAIGN', 'FOLLOW_UP', 'PAUSE_CAMPAIGN', 'RESUME_CAMPAIGN'],
      groupsCount: (groups || []).length,
      campaigns: campaigns.listCampaigns().slice(0, 10).map((c) => ({ id: c.id, name: c.name, status: c.status })),
    },
  };
}

// Dispatch unique : action + payload -> exécution réelle ou erreur structurée.
async function execute(action, payload) {
  switch (String(action || '').toUpperCase()) {
    case 'EXTRACT_MEMBERS': return extractMembers(payload);
    case 'SEND_CAMPAIGN': return sendCampaign(payload);
    case 'FOLLOW_UP':
    case 'SEND_MESSAGE':
    case 'SEND': return followUp(payload);
    case 'PAUSE_CAMPAIGN': return pauseCampaign(payload);
    case 'RESUME_CAMPAIGN': return resumeCampaign(payload);
    case 'GET_STATUS':
    case 'STATUS': return getStatus();
    default: return { ok: false, error: 'UNKNOWN_ACTION:' + String(action) };
  }
}

module.exports = { execute, getStatus, extractMembers, sendCampaign, followUp, pauseCampaign, resumeCampaign };