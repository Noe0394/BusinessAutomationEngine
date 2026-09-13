// Adaptateur de plateforme NAVIGATEUR (mode "SANS VPS" /local)
// ------------------------------------------------------------------------------
// Implémente le contrat window.CyrusEngine / window.CyrusStore (voir
// adapters/CONTRACT.md) en navigateur pur : aucun serveur, aucun VPS, aucune
// connexion Baileys/Telegram.
//
//   - CyrusEngine.sendMessage  : retourne un deep link wa.me/t.me (Mode Manuel
//     Express), copie le texte dans le presse-papiers ; l'utilisateur valide
//     l'envoi lui-même dans l'app de messagerie. Il n'y a PAS de fil WhatsApp
//     dans un onglet navigateur — cette limite est assumée et documentée.
//   - CyrusStore               : IndexedDB locale (webapp-core/lib/db.js) +
//     helpers campagne + export fichier navigateur (blob téléchargé).
//   - executionMode            : déterministe, lecture seule = 'local'.
//
// Aucune clé API, aucun secret embarqué. Zéro accès réseau hors IndexedDB et
// génération IA Firebase (app-core.js, inchangée).
(function () {
  'use strict';

  window.__CYRUS_MODE__ = 'local'; // déterministe : cette interface EST le mode local

  const db = window.Cyrus.db; // store IndexedDB (webapp-core/lib/db.js)

  // ------------------------------------------------------------------ ENGINE
  const engine = {
    // Pas de session WhatsApp/Telegram dans un navigateur : le statut est
    // volontairement "Non connecté" + explication injectée par mountConnectUI.
    async getStatus(channel) {
      return { connected: false, configured: null, error: null, mode: 'local' };
    },
    onStateChange() { /* aucun changement possible : état statique */ },
    mountConnectUI(channel, containerEl) {
      if (!containerEl) return;
      if (containerEl.querySelector('.cyrus-manual-explain')) return;
      const box = document.createElement('div');
      box.className = 'cyrus-manual-explain';
      box.style.cssText = 'margin-top:10px;padding:10px;border:1px solid var(--border,#1e293b);border-radius:8px;font-size:12px;color:var(--text-dim,#94a3b8);line-height:1.5;';
      box.textContent = channel === 'whatsapp'
        ? '🟢 Mode local (SANS VPS) : aucune connexion WhatsApp automatique. Les envois passent par un lien wa.me ouvrant votre WhatsApp — Mode Manuel Express.'
        : '🟢 Mode local (SANS VPS) : aucune connexion Telegram automatique. Les envois passent par un lien t.me ouvrant votre Telegram — Mode Manuel Express.';
      containerEl.appendChild(box);
    },
    // Envoi : Mode Manuel Express. Construit le deep link, copie le texte,
    // ouvre le lien. Retourne { ok:true, sentVia:'MANUAL_EXPRESS' }.
    async sendMessage(channel, to, text) {
      const link = buildDeepLink(String(channel).toLowerCase(), to, text, {});
      try { await navigator.clipboard.writeText(text || ''); } catch (e) { /* non bloquant */ }
      let opened = null;
      try { opened = window.open(link.url || link.raw, '_blank'); } catch (e) { opened = null; }
      return {
        ok: true,
        sentVia: 'MANUAL_EXPRESS',
        channel: channel,
        link: link.url,
        manualNote: 'Lien ' + (link.label) + ' ouvert — validez l\'envoi dans l\'application.',
      };
    },
    async getGroups() { return []; },          // pas de liste de groupes hors session
    async getGroupMembers() { return []; },
    async logout() { return { ok: true }; },   // aucune session à déconnecter
  };

  function buildDeepLink(channel, target, text, opts) {
    const encoded = encodeURIComponent(text || '');
    if (channel === 'telegram') {
      const uname = String(target || '').replace(/^@/, '');
      if (/^\d+$/.test(uname)) return { label: 'Telegram', url: 'https://t.me/+' + uname };
      return { label: 'Telegram', url: 'https://t.me/' + uname + (encoded ? '?text=' + encoded : '') };
    }
    const number = String(target || '').replace(/\D/g, '');
    return { label: 'WhatsApp', url: 'https://wa.me/' + number + (encoded ? '?text=' + encoded : '') };
  }
  window.Cyrus.buildDeepLink = buildDeepLink;

  // ------------------------------------------------------------------ STORE
  function reduceRecipients(recipients) {
    return (recipients || []).map(function (r) {
      return { to: r.to || r.identifier, name: r.name || '', status: r.status || 'pending' };
    });
  }

  const store = {
    async getContacts(channel) { return db.getContacts(channel); },
    async putContacts(channel, contacts) { return db.putAllContacts(channel, contacts); },

    async listCampaigns(channel) { return db.getCampaigns(channel); },
    async getCampaign(id) { return (await db.getCampaigns(null)).find(function (c) { return c.id === id; }) || null; },
    async getLatestCampaign(channel) { return db.getLatestCampaign(channel); },

    async createCampaign(channel, opts) {
      const campaign = {
        id: 'c' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        channel: channel,
        name: opts.name || 'Campagne',
        status: 'draft',
        text: opts.text || '',
        delayMinMs: opts.delayMinMs || 8000,
        delayMaxMs: opts.delayMaxMs || 20000,
        recipients: reduceRecipients(opts.recipients),
        updatedAt: Date.now(),
      };
      await db.saveCampaign(campaign);
      return campaign;
    },

    async saveCampaignProgress(campaignId, recipients) {
      const c = await store.getCampaign(campaignId);
      if (!c) return;
      c.recipients = reduceRecipients(recipients);
      c.updatedAt = Date.now();
      await db.saveCampaign(c);
    },

    async setCampaignStatus(id, status) {
      const c = await store.getCampaign(id);
      if (!c) return;
      c.status = status;
      c.updatedAt = Date.now();
      await db.saveCampaign(c);
    },
    async startCampaign(id) { await store.setCampaignStatus(id, 'running'); return { ok: true }; },
    async pauseCampaign(id) { await store.setCampaignStatus(id, 'paused'); return { ok: true }; },
    async cancelCampaign(id) { await store.setCampaignStatus(id, 'cancelled'); return { ok: true }; },

    async markManualSent(channel, campaignIdOrNull, to) {
      if (!campaignIdOrNull) return;
      const c = await store.getCampaign(campaignIdOrNull);
      if (!c) return;
      c.recipients = (c.recipients || []).map(function (r) {
        return (r.to === to) ? Object.assign({}, r, { status: 'sent' }) : r;
      });
      c.updatedAt = Date.now();
      await db.saveCampaign(c);
    },

    async getBlocklist(channel) { return db.getBlocklist(channel); },
    async addToBlocklist(channel, identifier) { return db.addToBlocklist(channel, identifier); },
    async removeFromBlocklist(channel, identifier) { return db.removeFromBlocklist(channel, identifier); },
    async filterBlocked(channel, contacts) { return db.filterBlocked(channel, contacts); },

    async recordSent(channel, identifier, source) { return db.recordSent(channel, identifier, source); },
    async wasSentRecently(channel, identifier, windowMs) { return db.wasSentRecently(channel, identifier, windowMs); },
    async getSentLog(channel, limit) { return db.getSentLog(channel, limit); },

    // Export fichier navigateur (blob téléchargé) — équivalent de la variante
    // Capacitor côté mobile, sans dépendance Capacitor.
    async exportRows(rows, filename, format) {
      const fmt = format === 'csv' ? 'csv' : 'xlsx';
      const data = XLSX.utils.json_to_sheet(rows || []);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, data, 'Export');
      const finalName = filename + (fmt === 'xlsx' ? '.xlsx' : '.csv');
      if (fmt === 'xlsx') {
        XLSX.writeFile(wb, finalName); // déclenche un téléchargement navigateur
      } else {
        const csv = XLSX.utils.sheet_to_csv(data);
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = finalName; document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 500);
      }
      return finalName;
    },
  };

  window.CyrusEngine = engine;
  window.CyrusStore = store;
})();