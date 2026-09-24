// Persistance locale (IndexedDB) des contacts importes et de l'etat des
// campagnes - equivalent navigateur de campaigns_state/ + contacts.json du
// VPS/local-client, mais par appareil (pas de synchronisation entre
// appareils, coherent avec le principe "zero serveur" de ce projet).
(function () {
  const DB_NAME = 'cyrus_campaigns';
  // v12 ajoute l'historique local des files Messenger.
  // v11 ajoute les réglages locaux du répondeur; les données précédentes sont conservées.
  // v10 ajoute le planning de messages locaux; les jobs communautaires et autres
  // registres locaux sont conserves lors de la mise a niveau.
  // que les installations existantes (DB deja creee en v1/v2 sur l'appareil
  // de test) declenchent bien onupgradeneeded au lieu de rester bloquees sans
  // ce store.
  const DB_VERSION = 12;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains('contacts')) {
          // cle composite [channel, identifier] : le meme numero peut exister
          // separement pour WhatsApp et Telegram sans collision.
          const store = db.createObjectStore('contacts', { keyPath: ['channel', 'identifier'] });
          store.createIndex('channel', 'channel', { unique: false });
        }
        if (!db.objectStoreNames.contains('campaigns')) {
          db.createObjectStore('campaigns', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('sentLog')) {
          // Historique des envois reellement declenches (campagnes ET Relance
          // Manuelle Express) - keyPath auto-incremente car un meme contact
          // peut etre recontacte plusieurs fois. Sert a la fois de journal
          // consultable (page Historiques) et de base pour l'anti-doublons 48h
          // de l'import direct en Relance Manuelle (equivalent local de
          // POST /api/messages/manual-import cote VPS).
          const log = db.createObjectStore('sentLog', { keyPath: 'id', autoIncrement: true });
          log.createIndex('channelIdentifier', ['channel', 'identifier'], { unique: false });
        }
        if (!db.objectStoreNames.contains('blocklist')) {
          // Liste noire manuelle (opt-out) - distincte de l'anti-doublons 48h
          // de sentLog (temporaire, automatique) : un identifiant ici est
          // exclu de TOUT import/campagne/relance jusqu'a retrait explicite.
          const store = db.createObjectStore('blocklist', { keyPath: ['channel', 'identifier'] });
          store.createIndex('channel', 'channel', { unique: false });
        }
        if (!db.objectStoreNames.contains('businessServices')) db.createObjectStore('businessServices', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('groupMembers')) {
          const members = db.createObjectStore('groupMembers', { keyPath: ['channel', 'groupId', 'identifier'] });
          members.createIndex('channel', 'channel', { unique: false });
          members.createIndex('channelGroup', ['channel', 'groupId'], { unique: false });
        }
        if (!db.objectStoreNames.contains('reportImprovements')) db.createObjectStore('reportImprovements', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('ledger')) db.createObjectStore('ledger', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('communities')) {
          const communities = db.createObjectStore('communities', { keyPath: ['channel', 'ref'] });
          communities.createIndex('channel', 'channel', { unique: false });
        }
        if (!db.objectStoreNames.contains('communityJobs')) {
          const jobs = db.createObjectStore('communityJobs', { keyPath: 'id' });
          jobs.createIndex('channel', 'channel', { unique: false });
          jobs.createIndex('status', 'status', { unique: false });
        }
        if (!db.objectStoreNames.contains('scheduledMessages')) {
          const scheduled = db.createObjectStore('scheduledMessages', { keyPath: 'id' });
          scheduled.createIndex('status', 'status', { unique: false });
          scheduled.createIndex('scheduledAt', 'scheduledAt', { unique: false });
          scheduled.createIndex('channel', 'channel', { unique: false });
        }
        if (!db.objectStoreNames.contains('autoResponderSettings')) db.createObjectStore('autoResponderSettings', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('facebookQueueJobs')) {
          const queue = db.createObjectStore('facebookQueueJobs', { keyPath: 'id' });
          queue.createIndex('createdAt', 'createdAt', { unique: false });
          queue.createIndex('status', 'status', { unique: false });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function tx(storeName, mode) {
    return open().then(function (db) {
      return db.transaction(storeName, mode).objectStore(storeName);
    });
  }

  function putAllContacts(channel, contacts) {
    return tx('contacts', 'readwrite').then(function (store) {
      return Promise.all(contacts.map(function (c) {
        return new Promise(function (resolve, reject) {
          const req = store.put(Object.assign({}, c, { channel: channel, identifier: c.identifier, name: c.name || '' }));
          req.onsuccess = function () { resolve(); };
          req.onerror = function () { reject(req.error); };
        });
      }));
    });
  }

  function getContacts(channel) {
    return tx('contacts', 'readonly').then(function (store) {
      return new Promise(function (resolve, reject) {
        const index = store.index('channel');
        const req = index.getAll(IDBKeyRange.only(channel));
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function clearContacts(channel) {
    return getContacts(channel).then(function (contacts) {
      return tx('contacts', 'readwrite').then(function (store) {
        return Promise.all(contacts.map(function (c) {
          return new Promise(function (resolve, reject) {
            const req = store.delete([channel, c.identifier]);
            req.onsuccess = function () { resolve(); };
            req.onerror = function () { reject(req.error); };
          });
        }));
      });
    });
  }

  function saveCampaign(campaign) {
    return tx('campaigns', 'readwrite').then(function (store) {
      return new Promise(function (resolve, reject) {
        const get = store.get(campaign.id);
        get.onsuccess = function () {
          const previous = get.result || null;
          const row = Object.assign({}, previous || {}, campaign);
          if (!previous && !row.createdAt) row.createdAt = Date.now();
          const put = store.put(row);
          put.onsuccess = function () { resolve(row); };
          put.onerror = function () { reject(put.error); };
        };
        get.onerror = function () { reject(get.error); };
      });
    });
  }

  function getCampaigns(channel) {
    return tx('campaigns', 'readonly').then(function (store) {
      return new Promise(function (resolve, reject) {
        const req = store.getAll();
        req.onsuccess = function () {
          resolve(channel ? req.result.filter(function (c) { return c.channel === channel; }) : req.result);
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // Campagne la plus recente pour un canal donne (par updatedAt) - c'est sur
  // cet objet que la Relance Manuelle Express reprend les contacts encore
  // 'pending'/'failed' (equivalent local de GET /api/messages/manual-queue).
  function getLatestCampaign(channel) {
    return getCampaigns(channel).then(function (list) {
      if (list.length === 0) return null;
      return list.reduce(function (best, c) { return (!best || c.updatedAt > best.updatedAt) ? c : best; }, null);
    });
  }

  // Journal des envois reellement declenches - alimente par le moteur de
  // campagne (chaque envoi automatique) ET par la Relance Manuelle Express
  // (chaque "Envoyer & Suivant"), quelle que soit la source. `source` vaut
  // 'campaign' ou 'manual'.
  function recordSent(channel, identifier, source, campaignId) {
    return tx('sentLog', 'readwrite').then(function (store) {
      return new Promise(function (resolve, reject) {
        const req = store.add({ channel: channel, identifier: identifier, source: source || 'manual', campaignId: campaignId || null, sentAt: Date.now() });
        req.onsuccess = function () { resolve(); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // Anti-doublons 48h (equivalent local du Smart Screening de
  // POST /api/messages/manual-import cote VPS) : vrai si ce contact a deja
  // recu un envoi trace dans les `windowMs` dernieres millisecondes.
  function wasSentRecently(channel, identifier, windowMs) {
    return tx('sentLog', 'readonly').then(function (store) {
      return new Promise(function (resolve, reject) {
        const index = store.index('channelIdentifier');
        const req = index.getAll(IDBKeyRange.only([channel, identifier]));
        req.onsuccess = function () {
          const cutoff = Date.now() - windowMs;
          resolve(req.result.some(function (entry) { return entry.sentAt >= cutoff; }));
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // Historique consultable (page Connexions/Historiques) - les plus recents
  // en premier, optionnellement plafonne.
  function getSentLog(channel, limit) {
    return tx('sentLog', 'readonly').then(function (store) {
      return new Promise(function (resolve, reject) {
        const req = store.getAll();
        req.onsuccess = function () {
          const filtered = channel ? req.result.filter(function (e) { return e.channel === channel; }) : req.result;
          filtered.sort(function (a, b) { return b.sentAt - a.sentAt; });
          resolve(limit ? filtered.slice(0, limit) : filtered);
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // ---------- Liste noire (opt-out manuel) ----------
  function addToBlocklist(channel, identifier) {
    return tx('blocklist', 'readwrite').then(function (store) {
      return new Promise(function (resolve, reject) {
        const req = store.put({ channel: channel, identifier: identifier, addedAt: Date.now() });
        req.onsuccess = function () { resolve(); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function removeFromBlocklist(channel, identifier) {
    return tx('blocklist', 'readwrite').then(function (store) {
      return new Promise(function (resolve, reject) {
        const req = store.delete([channel, identifier]);
        req.onsuccess = function () { resolve(); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function getBlocklist(channel) {
    return tx('blocklist', 'readonly').then(function (store) {
      return new Promise(function (resolve, reject) {
        const index = store.index('channel');
        const req = index.getAll(IDBKeyRange.only(channel));
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // Filtre un tableau de contacts {identifier,...} contre la liste noire du
  // canal - utilise par campaign.js et manualRelance.js avant tout
  // import/reprise, jamais l'inverse (on ne bloque jamais un contact deja
  // dans la file, on l'empeche seulement d'y entrer).
  function filterBlocked(channel, contacts) {
    return getBlocklist(channel).then(function (blocked) {
      const blockedSet = new Set(blocked.map(function (b) { return b.identifier; }));
      return contacts.filter(function (c) { return !blockedSet.has(c.identifier); });
    });
  }

  function getBusinessServices() {
    return tx('businessServices', 'readonly').then(function (store) { return new Promise(function (resolve, reject) { const req = store.getAll(); req.onsuccess = function () { resolve(req.result || []); }; req.onerror = function () { reject(req.error); }; }); });
  }
  function saveBusinessService(service) {
    const row = Object.assign({}, service, { id: service.id || ('svc_' + Date.now().toString(36)), updatedAt: Date.now() });
    return tx('businessServices', 'readwrite').then(function (store) { return new Promise(function (resolve, reject) { const req = store.put(row); req.onsuccess = function () { resolve(row); }; req.onerror = function () { reject(req.error); }; }); });
  }
  function deleteBusinessService(id) {
    return tx('businessServices', 'readwrite').then(function (store) { return new Promise(function (resolve, reject) { const req = store.delete(id); req.onsuccess = function () { resolve(); }; req.onerror = function () { reject(req.error); }; }); });
  }

  function saveGroupMembers(channel, groupId, groupName, members) {
    return tx('groupMembers', 'readwrite').then(function (store) {
      return new Promise(function (resolve, reject) {
        const transaction = store.transaction;
        transaction.oncomplete = function () { resolve(); };
        transaction.onerror = function () { reject(transaction.error); };
        transaction.onabort = function () { reject(transaction.error || new Error('Enregistrement des membres annulé.')); };
        const request = store.index('channelGroup').getAllKeys(IDBKeyRange.only([channel, String(groupId)]));
        request.onerror = function () { reject(request.error); };
        request.onsuccess = function () {
          request.result.forEach(key => store.delete(key));
          const extractedAt = Date.now();
          (members || []).forEach(member => {
            const identifier = String(member.id || member.identifier || '').trim();
            if (!identifier) return;
            store.put({ channel, groupId: String(groupId), groupName: groupName || String(groupId), identifier,
              name: String(member.name || ''), isAdmin: !!member.isAdmin, extractedAt });
          });
        };
      });
    });
  }
  function getGroupMembers(channel) {
    return tx('groupMembers', 'readonly').then(function (store) {
      return new Promise(function (resolve, reject) {
        const req = store.index('channel').getAll(IDBKeyRange.only(channel));
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  function saveCommunities(items) {
    return tx('communities', 'readwrite').then(function (store) {
      return Promise.all((items || []).filter(item => item && item.channel && item.ref).map(function (item) {
        return new Promise(function (resolve, reject) {
          const req = store.put(Object.assign({}, item, { channel: String(item.channel).toUpperCase(), ref: String(item.ref), savedAt: Date.now() }));
          req.onsuccess = function () { resolve(); }; req.onerror = function () { reject(req.error); };
        });
      }));
    });
  }
  function getCommunities(channel) {
    return tx('communities', 'readonly').then(function (store) {
      return new Promise(function (resolve, reject) {
        const req = channel ? store.index('channel').getAll(IDBKeyRange.only(String(channel).toUpperCase())) : store.getAll();
        req.onsuccess = function () { resolve((req.result || []).sort(function (a, b) { return (b.savedAt || 0) - (a.savedAt || 0); })); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  function deleteCommunity(channel, ref) {
    return tx('communities', 'readwrite').then(function (store) { return new Promise(function (resolve, reject) {
      const req = store.delete([String(channel).toUpperCase(), String(ref)]);
      req.onsuccess = function () { resolve(); }; req.onerror = function () { reject(req.error); };
    }); });
  }
  function saveCommunityJob(job) {
    const row = Object.assign({}, job, { updatedAt: Date.now() });
    return tx('communityJobs', 'readwrite').then(function (store) {
      return new Promise(function (resolve, reject) {
        const req = store.put(row);
        req.onsuccess = function () { resolve(row); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  function getCommunityJobs(channel) {
    return tx('communityJobs', 'readonly').then(function (store) {
      return new Promise(function (resolve, reject) {
        const req = channel ? store.index('channel').getAll(IDBKeyRange.only(String(channel).toUpperCase())) : store.getAll();
        req.onsuccess = function () { resolve((req.result || []).sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); })); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  function saveScheduledMessage(item) {
    const row = Object.assign({}, item, { updatedAt: Date.now() });
    return tx('scheduledMessages', 'readwrite').then(function (store) { return new Promise(function (resolve, reject) {
      const req = store.put(row);
      req.onsuccess = function () { resolve(row); };
      req.onerror = function () { reject(req.error); };
    }); });
  }
  function getScheduledMessages() {
    return tx('scheduledMessages', 'readonly').then(function (store) { return new Promise(function (resolve, reject) {
      const req = store.getAll();
      req.onsuccess = function () { resolve((req.result || []).sort(function (a, b) { return Number(a.scheduledAt || 0) - Number(b.scheduledAt || 0); })); };
      req.onerror = function () { reject(req.error); };
    }); });
  }
  function deleteScheduledMessage(id) {
    return tx('scheduledMessages', 'readwrite').then(function (store) { return new Promise(function (resolve, reject) {
      const req = store.delete(id);
      req.onsuccess = function () { resolve(); };
      req.onerror = function () { reject(req.error); };
    }); });
  }
  function saveReportImprovement(item) {
    return tx('reportImprovements', 'readwrite').then(function (store) {
      return new Promise(function (resolve, reject) {
        const req = store.put(item);
        req.onsuccess = function () { resolve(item); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  function getReportImprovements() {
    return tx('reportImprovements', 'readonly').then(function (store) {
      return new Promise(function (resolve, reject) {
        const req = store.getAll();
        req.onsuccess = function () { resolve((req.result || []).sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); })); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  function getLedgerEntries() {
    return tx('ledger', 'readonly').then(function (store) {
      return new Promise(function (resolve, reject) {
        const req = store.getAll();
        req.onsuccess = function () { resolve((req.result || []).sort(function (a, b) { return String(b.recordedAt || b.issuedAt || '').localeCompare(String(a.recordedAt || a.issuedAt || '')); })); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  function saveSale(entry) {
    const row = Object.assign({}, entry, { id: entry.id || ('sale_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)), kind: 'sale', recordedAt: new Date().toISOString() });
    return tx('ledger', 'readwrite').then(function (store) { return new Promise(function (resolve, reject) {
      const req = store.put(row); req.onsuccess = function () { resolve(row); }; req.onerror = function () { reject(req.error); };
    }); });
  }
  function saveInvoice(entry) {
    return tx('ledger', 'readwrite').then(function (store) { return new Promise(function (resolve, reject) {
      const transaction = store.transaction; let saved = null;
      transaction.oncomplete = function () { resolve(saved); };
      transaction.onerror = function () { reject(transaction.error); };
      transaction.onabort = function () { reject(transaction.error || new Error('Enregistrement de la facture annulé.')); };
      const req = store.getAll();
      req.onerror = function () { reject(req.error); };
      req.onsuccess = function () {
        const year = new Date().getFullYear();
        const prefix = 'FCT-' + year + '-';
        const seq = (req.result || []).reduce(function (max, row) {
          const number = String(row.invoiceNumber || '');
          return number.startsWith(prefix) ? Math.max(max, parseInt(number.slice(prefix.length), 10) || 0) : max;
        }, 0) + 1;
        saved = Object.assign({}, entry, { id: 'invoice_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), kind: 'invoice', invoiceNumber: prefix + String(seq).padStart(5, '0'), issuedAt: new Date().toISOString() });
        store.put(saved);
      };
    }); });
  }
  function getAutoResponderSettings() {
    return tx('autoResponderSettings', 'readonly').then(function (store) { return new Promise(function (resolve, reject) {
      const req = store.get('global');
      req.onsuccess = function () { resolve(Object.assign({ id: 'global', whatsapp: false, telegram: false, alwaysOn: false, paused: false, groupReplies: false }, req.result || {})); };
      req.onerror = function () { reject(req.error); };
    }); });
  }
  function saveAutoResponderSettings(settings) {
    const row = Object.assign({ id: 'global', whatsapp: false, telegram: false, alwaysOn: false, paused: false, groupReplies: false }, settings || {}, { id: 'global', updatedAt: Date.now() });
    return tx('autoResponderSettings', 'readwrite').then(function (store) { return new Promise(function (resolve, reject) {
      const req = store.put(row); req.onsuccess = function () { resolve(row); }; req.onerror = function () { reject(req.error); };
    }); });
  }
  function saveFacebookQueueJob(job) {
    const row = Object.assign({}, job, { updatedAt: Date.now() });
    return tx('facebookQueueJobs', 'readwrite').then(function (store) { return new Promise(function (resolve, reject) {
      const req = store.put(row); req.onsuccess = function () { resolve(row); }; req.onerror = function () { reject(req.error); };
    }); });
  }
  function getFacebookQueueJobs() {
    return tx('facebookQueueJobs', 'readonly').then(function (store) { return new Promise(function (resolve, reject) {
      const req = store.getAll();
      req.onsuccess = function () { resolve((req.result || []).sort(function (a, b) { return Number(b.createdAt || 0) - Number(a.createdAt || 0); })); };
      req.onerror = function () { reject(req.error); };
    }); });
  }

  window.Cyrus = window.Cyrus || {};
  window.Cyrus.db = {
    putAllContacts: putAllContacts,
    getContacts: getContacts,
    clearContacts: clearContacts,
    saveCampaign: saveCampaign,
    getCampaigns: getCampaigns,
    getLatestCampaign: getLatestCampaign,
    recordSent: recordSent,
    wasSentRecently: wasSentRecently,
    getSentLog: getSentLog,
    addToBlocklist: addToBlocklist,
    removeFromBlocklist: removeFromBlocklist,
    getBlocklist: getBlocklist,
    filterBlocked: filterBlocked,
    getBusinessServices: getBusinessServices,
    saveBusinessService: saveBusinessService,
    deleteBusinessService: deleteBusinessService,
    saveGroupMembers: saveGroupMembers,
    getGroupMembers: getGroupMembers,
    saveCommunities: saveCommunities,
    getCommunities: getCommunities,
    deleteCommunity: deleteCommunity,
    saveCommunityJob: saveCommunityJob,
    getCommunityJobs: getCommunityJobs,
    saveScheduledMessage: saveScheduledMessage,
    getScheduledMessages: getScheduledMessages,
    deleteScheduledMessage: deleteScheduledMessage,
    saveReportImprovement: saveReportImprovement,
    getReportImprovements: getReportImprovements,
    getLedgerEntries: getLedgerEntries,
    saveSale: saveSale,
    saveInvoice: saveInvoice,
    getAutoResponderSettings: getAutoResponderSettings,
    saveAutoResponderSettings: saveAutoResponderSettings,
    saveFacebookQueueJob: saveFacebookQueueJob,
    getFacebookQueueJobs: getFacebookQueueJobs,
  };
})();
