// Adaptateur de plateforme NAVIGATEUR (mode "SANS VPS" /local)
// ------------------------------------------------------------------------------
// Implémente le contrat window.CyrusEngine / window.CyrusStore (voir
// adapters/CONTRACT.md) en navigateur pur : aucun serveur, aucun VPS.
//
//   - CyrusEngine.sendMessage (WhatsApp) : si l'extension compagnon (voir
//     browser-extension/ à la racine du dépôt, lib/extensionBridge.js ici)
//     est installée ET WhatsApp Web connecté dans son onglet dédié, envoi
//     RÉEL sans aucun clic humain — l'extension a accès aux modules internes
//     de web.whatsapp.com, ce qu'un onglet classique ne peut jamais avoir
//     (same-origin policy). Sinon, repli sur le Mode Manuel Express (deep
//     link wa.me/t.me, clic humain requis — limite du navigateur seul,
//     documentée, jamais contournée par une fausse simulation).
//   - CyrusStore               : IndexedDB locale (webapp-core/lib/db.js) +
//     helpers campagne + export fichier navigateur (blob téléchargé).
//   - executionMode            : déterministe, lecture seule = 'local'.
//
// Aucune clé API, aucun secret embarqué. Zéro accès réseau hors IndexedDB,
// extension compagnon (WhatsApp) et génération IA Firebase (app-core.js).
(function () {
  'use strict';

  window.__CYRUS_MODE__ = 'local'; // déterministe : cette interface EST le mode local

  const db = window.Cyrus.db; // store IndexedDB (webapp-core/lib/db.js)
  const extBridge = window.Cyrus.extensionBridge; // webapp-core/lib/extensionBridge.js

  // ------------------------------------------------------------------ ENGINE
  const stateListeners = [];
  let pollTimer = null;
  let lastKnown = { whatsapp: { connected: false } };

  function startPollingIfNeeded() {
    if (pollTimer || !stateListeners.length) return;
    pollTimer = setInterval(async () => {
      const s = await extBridge.ping();
      const connected = !!(s.installed && s.connected);
      if (connected !== lastKnown.whatsapp.connected) {
        lastKnown.whatsapp = { connected };
        // Contrat (adapters/CONTRACT.md#onStateChange) : callback(status),
        // UN seul argument — même shape que getStatus(). connexions-core.js
        // l'appelle `(data) => renderStatus(channel, data)`, pas
        // `(channel, data)` : un appel à deux arguments casserait le rendu
        // (channel reçu comme "status").
        stateListeners.forEach((cb) => { try { cb({ connected }); } catch (e) { /* ignore */ } });
      }
    }, 4000);
  }

  const engine = {
    // WhatsApp : reflète l'état réel de l'extension quand elle est présente
    // (installed:true + connected selon Socket.state === 'CONNECTED' côté
    // WhatsApp Web) ; sinon "Non connecté" + explication Mode Manuel Express,
    // injectée par mountConnectUI.
    async getStatus(channel) {
      if (channel === 'whatsapp') {
        const s = await extBridge.ping();
        if (s.installed) {
          lastKnown.whatsapp = { connected: !!s.connected };
          return { connected: !!s.connected, configured: true, error: null, mode: 'extension' };
        }
      }
      return { connected: false, configured: null, error: null, mode: 'local' };
    },
    onStateChange(channel, callback) {
      // Contrat : callback(status) par canal — on ne poll que WhatsApp (seul
      // canal avec un état réel à surveiller côté extension).
      if (channel !== 'whatsapp') return;
      stateListeners.push(callback);
      startPollingIfNeeded();
    },
    mountConnectUI(channel, containerEl) {
      if (!containerEl) return;
      if (containerEl.querySelector('.cyrus-manual-explain')) return;
      const box = document.createElement('div');
      box.className = 'cyrus-manual-explain';
      box.style.cssText = 'margin-top:10px;padding:10px;border:1px solid var(--border,#1e293b);border-radius:8px;font-size:12px;color:var(--text-dim,#94a3b8);line-height:1.5;';

      if (channel === 'whatsapp') {
        extBridge.ping().then((s) => {
          if (s.installed) {
            box.innerHTML = '';
            const status = document.createElement('div');
            status.textContent = s.connected
              ? '🟢 Extension CYRUS connectée — envoi WhatsApp 100% automatique actif, aucun clic requis.'
              : '🟡 Extension CYRUS installée, WhatsApp Web pas encore connecté sur cet appareil.';
            box.appendChild(status);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = s.connected ? '🔄 Ouvrir WhatsApp Web' : '📷 Connecter WhatsApp (scanner le QR)';
            btn.style.cssText = 'margin-top:8px;';
            btn.addEventListener('click', () => extBridge.openWhatsApp());
            box.appendChild(btn);
          } else {
            box.innerHTML = '';
            const status = document.createElement('div');
            status.textContent = '🟢 Mode local (SANS VPS) : sans l\'extension navigateur compagnon (non détectée, ou indisponible sur mobile), les envois passent par un lien wa.me — Mode Manuel Express (clic manuel requis dans WhatsApp). Voir browser-extension/README.md pour l\'installer et activer l\'envoi 100% automatique sur PC.';
            box.appendChild(status);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = '📱 Ouvrir WhatsApp Web';
            btn.style.cssText = 'margin-top:8px;';
            btn.addEventListener('click', () => { try { window.open('https://web.whatsapp.com', '_blank'); } catch (e) { /* ignore */ } });
            box.appendChild(btn);
          }
        });
        containerEl.appendChild(box);
        return;
      }

      const status = document.createElement('div');
      status.textContent = '🟢 Mode local (SANS VPS) : aucune connexion Telegram automatique. Les envois passent par un lien t.me ouvrant votre Telegram — Mode Manuel Express.';
      box.appendChild(status);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '✈️ Ouvrir Telegram Web';
      btn.style.cssText = 'margin-top:8px;';
      btn.addEventListener('click', () => { try { window.open('https://web.telegram.org', '_blank'); } catch (e) { /* ignore */ } });
      box.appendChild(btn);
      containerEl.appendChild(box);
    },
    // Envoi WhatsApp : extension compagnon si installée+connectée (envoi RÉEL,
    // zéro clic) ; sinon Mode Manuel Express (deep link, clic humain requis —
    // limite du navigateur seul, jamais contournée par une simulation).
    async sendMessage(channel, to, text) {
      if (channel === 'whatsapp') {
        const s = await extBridge.ping();
        if (s.installed && s.connected) {
          const result = await extBridge.sendMessage(to, text);
          if (result.ok) return { ok: true, sentVia: 'EXTENSION', channel: channel };
          return { ok: false, sentVia: 'EXTENSION', channel: channel, error: result.error || 'ECHEC_ENVOI_EXTENSION' };
        }
      }
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
    async getGroups(channel) {
      if (channel === 'whatsapp') {
        const s = await extBridge.ping();
        if (s.installed && s.connected) {
          const r = await extBridge.getGroups();
          if (r.ok) return r.groups;
        }
      }
      return [];
    },
    async getGroupMembers(channel, groupId) {
      if (channel === 'whatsapp') {
        const s = await extBridge.ping();
        if (s.installed && s.connected) {
          const r = await extBridge.getGroupMembers(groupId);
          if (r.ok) return r.members;
        }
      }
      return [];
    },
    async logout() { return { ok: true }; },   // aucune session à déconnecter (voir extension pour WhatsApp)
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