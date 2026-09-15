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

  function sessionFor(channel) {
    return String(channel || 'WHATSAPP').toUpperCase() === 'TELEGRAM' ? telegram : whatsapp;
  }

  // Lecture de la boîte de réception (parité vps-runtime).
  async function getRecentMessages(payload) {
    const p = payload || {};
    const ch = String(p.channel || 'WHATSAPP').toUpperCase();
    try {
      const s = sessionFor(ch);
      const connected = typeof s.isConnected === 'function' ? s.isConnected() : null;
      const paired = typeof s.isPaired === 'function' ? s.isPaired() : null;
      const connectedNumber = typeof s.getConnectedNumber === 'function' ? s.getConnectedNumber() : null;
      if (typeof s.getRecentMessages !== 'function') return { ok: false, error: 'RUNTIME_MISSING:getRecentMessages', connected, paired, connectedNumber };
      return { ok: true, channel: ch, connected, paired, connectedNumber, messages: s.getRecentMessages(p.limit || 10) || [] };
    } catch (err) { return { ok: false, error: err.message }; }
  }

  async function listGroups(payload) {
    const p = payload || {};
    const ch = String(p.channel || 'WHATSAPP').toUpperCase();
    try {
      const s = sessionFor(ch);
      const connected = typeof s.isConnected === 'function' ? s.isConnected() : null;
      const paired = typeof s.isPaired === 'function' ? s.isPaired() : null;
      if (typeof s.getGroupsSummary !== 'function') return { ok: false, error: 'RUNTIME_MISSING:getGroupsSummary', connected, paired };
      return { ok: true, channel: ch, connected, paired, groups: (await s.getGroupsSummary()) || [] };
    } catch (err) { return { ok: false, error: err.message }; }
  }

  function matchGroups(groups, target) {
    const t = target || {};
    const kind = t.kind || 'all';
    const val = t.value ? String(t.value).trim().toLowerCase() : '';
    if (kind === 'admin') return groups.filter((g) => g.isAdmin);
    if ((kind === 'named' || kind === 'subject') && val) {
      const exact = groups.filter((g) => (g.name || '').toLowerCase() === val);
      if (kind === 'named' && exact.length) return exact;
      return groups.filter((g) => (g.name || '').toLowerCase().includes(val));
    }
    return groups;
  }

  async function resolveGroups(payload) {
    const p = payload || {};
    const s = sessionFor(p.channel);
    if (typeof s.getGroupsSummary !== 'function') return { ok: false, error: 'RUNTIME_MISSING:getGroupsSummary', session: null, groups: [] };
    const all = (await s.getGroupsSummary()) || [];
    let targets;
    if (Array.isArray(p.groupIds) && p.groupIds.length) {
      const ids = new Set(p.groupIds.map(String));
      targets = all.filter((g) => ids.has(String(g.id)));
    } else {
      targets = matchGroups(all, p.target);
    }
    if (p.limit) targets = targets.slice(0, p.limit);
    return { ok: true, session: s, groups: targets, totalGroups: all.length };
  }

  async function sendToGroups(payload) {
    const p = payload || {};
    const ch = String(p.channel || 'WHATSAPP').toUpperCase();
    try {
      const r = await resolveGroups(p);
      if (!r.ok) return { ok: false, error: r.error };
      const s = r.session;
      const targets = r.groups;
      if (!targets.length) return { ok: false, error: 'NO_MATCHING_GROUP', matched: 0, totalGroups: r.totalGroups };
      const media = p.media && p.media.buffer ? p.media : null;
      const text = p.text || (media && media.caption) || '';
      const results = [];
      for (const g of targets) {
        try {
          if (media && typeof s.sendMedia === 'function') {
            await s.sendMedia(g.id, { buffer: media.buffer, mimetype: media.mimetype, filename: media.filename || 'media', caption: text });
          } else {
            await s.sendMessage(g.id, text);
          }
          results.push({ id: g.id, name: g.name, ok: true });
        } catch (e) {
          results.push({ id: g.id, name: g.name, ok: false, error: e.message });
        }
        await new Promise((res) => setTimeout(res, 1200 + Math.floor(Math.random() * 1800)));
      }
      const sent = results.filter((x) => x.ok).length;
      return { ok: sent > 0, channel: ch, sent, total: targets.length, results };
    } catch (err) { return { ok: false, error: err.message }; }
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

  const methods = {
    extractMembers, sendCampaign, sendMessage, pauseCampaign, resumeCampaign,
    getRecentMessages, listGroups, resolveGroups, sendToGroups,
  };

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
