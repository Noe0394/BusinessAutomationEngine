// Persistance locale (IndexedDB) des contacts importes et de l'etat des
// campagnes - equivalent navigateur de campaigns_state/ + contacts.json du
// VPS/local-client, mais par appareil (pas de synchronisation entre
// appareils, coherent avec le principe "zero serveur" de ce projet).
// Copie du store mobile (mobile/webapp/www/lib/db.js) : source de verite
// navigateur pour l'adaptateur de plateforme browser (adapters/browser.js).
(function () {
  const DB_NAME = 'cyrus_campaigns';
  // v3 ajoute le store 'blocklist' (voir onupgradeneeded) - incremente pour
  // que les installations existantes (DB deja creee en v1/v2 sur l'appareil
  // de test) declenchent bien onupgradeneeded au lieu de rester bloquees sans
  // ce store.
  const DB_VERSION = 3;
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
          const req = store.put({ channel: channel, identifier: c.identifier, name: c.name || '' });
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
        const req = store.put(campaign);
        req.onsuccess = function () { resolve(); };
        req.onerror = function () { reject(req.error); };
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
  function recordSent(channel, identifier, source) {
    return tx('sentLog', 'readwrite').then(function (store) {
      return new Promise(function (resolve, reject) {
        const req = store.add({ channel: channel, identifier: identifier, source: source || 'manual', sentAt: Date.now() });
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
  };
})();