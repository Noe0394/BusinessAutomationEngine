'use strict';

const fs = require('fs');
const path = require('path');
const githubStore = require('../githubStore');
const secretVault = require('../ai-engine/secretVault');

const REMOTE_DIR = process.env.GITHUB_TELEGRAM_SESSION_DIR || 'telegram_sessions';
const SNAPSHOT_INTERVAL_MS = 20000;

function safeTenant(tenantId) {
  return String(tenantId || '').trim().replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';
}

function createAuthStore(rawTenantId) {
  const tenantId = safeTenant(rawTenantId);
  const remotePath = `${REMOTE_DIR}/${tenantId}.json`;
  const store = githubStore.createStore(remotePath);
  let lastPushedContent = null;
  let snapshotTimer = null;
  let pushQueue = Promise.resolve();
  const status = { lastPushAt: null, lastPushOk: null, lastPushError: null, lastFetchAt: null, lastFetchOk: null, lastFetchError: null };
  const enabled = !!store.enabled && secretVault.isEncryptionConfigured();

  async function restoreSessionFromRemote(sessionPath) {
    if (!enabled) {
      status.lastFetchOk = false;
      status.lastFetchError = store.enabled ? 'SECRET_VAULT_KEY_NOT_CONFIGURED' : 'GITHUB_DATA_STORE_NOT_CONFIGURED';
      return false;
    }
    try {
      if (fs.existsSync(sessionPath) && fs.statSync(sessionPath).size > 0) return false;
      const remote = await store.fetchRemote();
      status.lastFetchAt = new Date().toISOString();
      if (!remote || !remote.content) {
        status.lastFetchOk = true;
        status.lastFetchError = null;
        return false;
      }
      let parsed = null;
      let isJson = false;
      try { parsed = JSON.parse(remote.content); isJson = true; } catch (err) { /* ancienne StringSession en texte brut */ }
      let session;
      let migrateLegacy = false;
      if (isJson) {
        if (!parsed || parsed._cyrusEncrypted !== 1 || parsed.format !== 'telegram-string-session-v1') {
          status.lastFetchOk = false;
          status.lastFetchError = 'TELEGRAM_SESSION_FORMAT_UNSUPPORTED';
          return false;
        }
        session = secretVault.decrypt(parsed.payload);
      } else {
        // Les sauvegardes précédant le chiffrement contiennent directement la
        // StringSession GramJS. La restaurer, puis la réécrire immédiatement
        // avec le format chiffré pour que le prochain démarrage la retrouve.
        session = remote.content;
        migrateLegacy = true;
      }
      if (session == null || !session.trim()) throw new Error('TELEGRAM_SESSION_DECRYPT_FAILED');
      if (/\s/.test(session)) throw new Error('TELEGRAM_SESSION_FORMAT_INVALID');
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
      fs.writeFileSync(sessionPath, session, 'utf8');
      lastPushedContent = migrateLegacy ? null : session;
      status.lastFetchOk = true;
      status.lastFetchError = null;
      if (migrateLegacy) {
        console.log(`Ancienne session Telegram restaurée pour le tenant "${tenantId}"; migration chiffrée en cours.`);
        await pushSnapshot(sessionPath);
      } else {
        console.log(`Session Telegram restaurée depuis le stockage privé pour le tenant "${tenantId}".`);
      }
      return true;
    } catch (err) {
      status.lastFetchAt = new Date().toISOString();
      status.lastFetchOk = false;
      status.lastFetchError = String(err && err.message || err).slice(0, 180);
      console.error(`Échec de restauration de la session Telegram pour le tenant "${tenantId}" :`, err.message);
      return false;
    }
  }

  async function pushSnapshot(sessionPath) {
    if (!enabled) {
      status.lastPushOk = false;
      status.lastPushError = store.enabled ? 'SECRET_VAULT_KEY_NOT_CONFIGURED' : 'GITHUB_DATA_STORE_NOT_CONFIGURED';
      return false;
    }
    const run = pushQueue.catch(() => {}).then(async () => {
      let content;
      try { content = fs.readFileSync(sessionPath, 'utf8'); } catch (err) { return false; }
      if (!content || content === lastPushedContent) return true;
      const envelope = JSON.stringify({
        _cyrusEncrypted: 1,
        format: 'telegram-string-session-v1',
        payload: secretVault.encrypt(content),
      });
      await store.pushRemote(envelope);
      lastPushedContent = content;
      status.lastPushAt = new Date().toISOString();
      status.lastPushOk = true;
      status.lastPushError = null;
      return true;
    });
    pushQueue = run;
    try { return await run; }
    catch (err) {
      status.lastPushAt = new Date().toISOString();
      status.lastPushOk = false;
      status.lastPushError = String(err && err.message || err).slice(0, 180);
      console.error(`Échec de sauvegarde de la session Telegram pour le tenant "${tenantId}" :`, err.message);
      return false;
    }
  }

  function startPeriodicSync(sessionPath) {
    if (!enabled || snapshotTimer) return;
    snapshotTimer = setInterval(() => { pushSnapshot(sessionPath).catch(() => {}); }, SNAPSHOT_INTERVAL_MS);
    if (snapshotTimer.unref) snapshotTimer.unref();
  }

  function stopPeriodicSync() {
    if (snapshotTimer) clearInterval(snapshotTimer);
    snapshotTimer = null;
  }

  async function clearRemote() {
    if (!store.enabled) return;
    try {
      await store.fetchRemote();
      await store.pushRemote('');
      lastPushedContent = '';
      status.lastPushAt = new Date().toISOString();
      status.lastPushOk = true;
      status.lastPushError = null;
    } catch (err) {
      status.lastPushOk = false;
      status.lastPushError = String(err && err.message || err).slice(0, 180);
      console.error(`Échec de suppression de la session Telegram distante pour le tenant "${tenantId}" :`, err.message);
    }
  }

  return {
    enabled,
    restoreSessionFromRemote,
    pushSnapshot,
    startPeriodicSync,
    stopPeriodicSync,
    clearRemote,
    getStatus: () => ({ ...store.getStatus(), enabled, storage: 'encrypted-string-session', restoreSupported: enabled, ...status }),
  };
}

module.exports = { createAuthStore };
