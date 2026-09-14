// RUNTIME local-client — bras d'exécution du registre d'actions partagé
// (lib/intelligence/action-executor.js) pour le PC, MONO-POSTE (une seule
// session WhatsApp/Telegram, pas de multi-tenant comme
// lib/intelligence/runtimes/vps-runtime.js côté VPS — bien plus simple).
//
// Même garantie qu'côté VPS : ZÉRO effet de bord par défaut, chaque méthode
// enveloppe son appel en try/catch et renvoie { ok:false, error } plutôt que
// de lever une erreur qui ferait planter l'appelant.
'use strict';

function createLocalRuntime({ whatsapp, telegram, campaigns, llm }) {
  async function extractMembers(channel, groupId) {
    const ch = String(channel || 'WHATSAPP').toUpperCase();
    try {
      if (ch === 'WHATSAPP') {
        const members = await whatsapp.getGroupMembers(groupId);
        return members.map((m) => ({ id: m.id, to: m.id, nom: '' }));
      }
      if (ch === 'TELEGRAM') {
        const members = await telegram.getGroupMembers(groupId);
        return members.map((m) => ({
          id: m.id, to: m.username || m.phone || m.id,
          nom: [m.firstName, m.lastName].filter(Boolean).join(' '),
        }));
      }
      return [];
    } catch (err) {
      console.error(`local-runtime — extractMembers échoué (${ch}) :`, err.message);
      return [];
    }
  }

  async function sendCampaign(payload) {
    const p = payload || {};
    const ch = String(p.channel || 'WHATSAPP').toUpperCase() === 'TELEGRAM' ? 'telegram' : 'whatsapp';
    const recipients = Array.isArray(p.recipients) ? p.recipients : [];
    if (!recipients.length) return { ok: false, error: 'EMPTY_RECIPIENTS' };
    try {
      const created = campaigns.createCampaign(p.name || `Campagne ${new Date().toLocaleString('fr-FR')}`, recipients, {
        text: p.text || p.message || '',
        channel: ch,
        delayMinMs: p.minDelayMs, delayMaxMs: p.maxDelayMs,
      });
      campaigns.startCampaign(created.id);
      return { ok: true, result: { channel: ch.toUpperCase(), campaignId: created.id, recipients: recipients.length, status: 'started' } };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async function sendMessage(channel, to, text) {
    const ch = String(channel || 'WHATSAPP').toUpperCase();
    try {
      if (ch === 'TELEGRAM') { await telegram.sendMessage(to, text); return { ok: true }; }
      await whatsapp.sendMessage(to, text);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async function pauseCampaign(payload) {
    const p = payload || {};
    try {
      if (!p.campaignId) return { ok: false, error: 'MISSING_CAMPAIGN_ID' };
      campaigns.pauseCampaign(p.campaignId);
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  }

  async function resumeCampaign(payload) {
    const p = payload || {};
    try {
      if (!p.campaignId) return { ok: false, error: 'MISSING_CAMPAIGN_ID' };
      campaigns.startCampaign(p.campaignId);
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  }

  const methods = { extractMembers, sendCampaign, sendMessage, pauseCampaign, resumeCampaign };

  const registryMod = require('../action-executor.js');
  const executor = registryMod.createActionExecutor({
    runtime: methods,
    humanContext: null,
    env: process.env,
    llm: llm || null,
  });

  return Object.assign(methods, { execute: executor.execute, actionExecutor: executor });
}

module.exports = { createLocalRuntime };
