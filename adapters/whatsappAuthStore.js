'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const githubStore = require('../githubStore');
const secretVault = require('../ai-engine/secretVault');

// A Baileys session is the complete AUTH_DIR tree (credentials plus Signal
// keys). Store one compressed, authenticated-encrypted snapshot in the
// existing private GitHub data store; credentials-only backups are rejected.
const REMOTE_DIR = process.env.GITHUB_WHATSAPP_AUTH_DIR || 'whatsapp_auth';
const SNAPSHOT_INTERVAL_MS = Math.max(30000, Number(process.env.WHATSAPP_AUTH_SNAPSHOT_INTERVAL_MS) || 120000);
const MAX_AUTH_FILES = 10000;
const MAX_SNAPSHOT_BYTES = 80 * 1024 * 1024;

function safeTenant(tenantId) {
  return String(tenantId || '').trim().replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';
}

function listAuthFiles(authDir) {
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, relative);
      else if (entry.isFile()) files.push({ path: relative, data: fs.readFileSync(full).toString('base64') });
      if (files.length > MAX_AUTH_FILES) throw new Error('WHATSAPP_AUTH_TOO_MANY_FILES');
    }
  };
  if (fs.existsSync(authDir)) walk(authDir, '');
  return files;
}

function createAuthStore(rawTenantId) {
  const tenantId = safeTenant(rawTenantId);
  const remotePath = `${REMOTE_DIR}/${tenantId}.json`;
  const store = githubStore.createStore(remotePath);
  let snapshotTimer = null;
  let pushQueue = Promise.resolve();
  let lastDigest = null;
  const status = { lastPushAt: null, lastPushOk: null, lastPushError: null, lastFetchAt: null, lastFetchOk: null, lastFetchError: null };
  const enabled = !!store.enabled && secretVault.isEncryptionConfigured();

  function setError(target, err) {
    status[target] = String(err && err.message || err).slice(0, 180);
  }

  async function restoreSessionFromRemote(authDir) {
    if (!enabled) {
      status.lastFetchOk = false;
      status.lastFetchError = store.enabled ? 'SECRET_VAULT_KEY_NOT_CONFIGURED' : 'GITHUB_DATA_STORE_NOT_CONFIGURED';
      return false;
    }
    if (fs.existsSync(path.join(authDir, 'creds.json'))) return false;

    try {
      const remote = await store.fetchRemote();
      status.lastFetchAt = new Date().toISOString();
      if (!remote || (!remote.content && !remote.tooLarge)) {
        status.lastFetchOk = true;
        status.lastFetchError = null;
        return false;
      }
      let content = remote.content;
      if (!content && remote.tooLarge && remote.sha && typeof githubStore.fetchLargeFile === 'function') {
        const blob = await githubStore.fetchLargeFile(remote.sha);
        content = blob ? blob.toString('utf8') : null;
      }
      if (!content) throw new Error('WHATSAPP_AUTH_SNAPSHOT_UNREADABLE');
      const envelope = JSON.parse(content);
      if (!envelope || envelope._cyrusEncrypted !== 1 || envelope.format !== 'baileys-auth-dir-v1') {
        // Older deployed snapshots contain only creds.json and omit Signal
        // keys. Keep them private as legacy data, but never restore a partial
        // session as if it were complete.
        status.lastFetchOk = false;
        status.lastFetchError = 'LEGACY_CREDENTIALS_ONLY_SNAPSHOT_UNSUPPORTED';
        console.warn(`Session WhatsApp distante non restaurée pour le tenant "${tenantId}" : ancien instantané incomplet.`);
        return false;
      }
      const packedBase64 = secretVault.decrypt(envelope.payload);
      if (!packedBase64) throw new Error('WHATSAPP_AUTH_DECRYPT_FAILED');
      const record = JSON.parse(zlib.gunzipSync(Buffer.from(packedBase64, 'base64')).toString('utf8'));
      if (!record || record.version !== 1 || record.tenantId !== tenantId || !Array.isArray(record.files)) {
        throw new Error('WHATSAPP_AUTH_SNAPSHOT_INVALID');
      }
      const fileMap = new Map(record.files.map((item) => [String(item.path || ''), item]));
      const creds = fileMap.get('creds.json');
      if (!creds || !record.files.some((item) => item.path !== 'creds.json')) throw new Error('WHATSAPP_AUTH_SIGNAL_KEYS_MISSING');
      const parsedCreds = JSON.parse(Buffer.from(creds.data, 'base64').toString('utf8'));
      if (!parsedCreds || parsedCreds.registered !== true) throw new Error('WHATSAPP_AUTH_SESSION_NOT_REGISTERED');
      for (const item of record.files) {
        const relative = String(item.path || '').replace(/\\/g, '/');
        if (!relative || relative.startsWith('/') || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
          throw new Error('WHATSAPP_AUTH_SNAPSHOT_PATH_INVALID');
        }
        const destination = path.join(authDir, ...relative.split('/'));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, Buffer.from(item.data, 'base64'));
      }
      status.lastFetchOk = true;
      status.lastFetchError = null;
      console.log(`Session WhatsApp complète restaurée depuis le stockage privé pour le tenant "${tenantId}".`);
      return true;
    } catch (err) {
      status.lastFetchAt = new Date().toISOString();
      status.lastFetchOk = false;
      setError('lastFetchError', err);
      console.error(`Échec de restauration de la session WhatsApp pour le tenant "${tenantId}" :`, err.message);
      return false;
    }
  }

  async function pushSnapshot(authDir) {
    if (!enabled) {
      status.lastPushOk = false;
      status.lastPushError = store.enabled ? 'SECRET_VAULT_KEY_NOT_CONFIGURED' : 'GITHUB_DATA_STORE_NOT_CONFIGURED';
      return false;
    }
    const run = pushQueue.catch(() => {}).then(async () => {
      const files = listAuthFiles(authDir);
      const credsFile = files.find((item) => item.path === 'creds.json');
      if (!credsFile || !files.some((item) => item.path !== 'creds.json')) return false;
      const creds = JSON.parse(Buffer.from(credsFile.data, 'base64').toString('utf8'));
      if (!creds || creds.registered !== true) return false;
      const plain = JSON.stringify({ version: 1, tenantId, files });
      const compressed = zlib.gzipSync(Buffer.from(plain, 'utf8'));
      const digest = crypto.createHash('sha256').update(compressed).digest('hex');
      if (digest === lastDigest) return true;
      const envelope = JSON.stringify({
        _cyrusEncrypted: 1,
        format: 'baileys-auth-dir-v1',
        payload: secretVault.encrypt(compressed.toString('base64')),
      });
      const bytes = Buffer.from(envelope, 'utf8');
      if (bytes.length > MAX_SNAPSHOT_BYTES) throw new Error('WHATSAPP_AUTH_SNAPSHOT_TOO_LARGE');
      // Fetch once to seed the Contents API SHA used by clearRemote(); larger
      // snapshots use Git Data blobs but still replace this same remote path.
      await store.fetchRemote();
      if (bytes.length > 850 * 1024) {
        if (typeof githubStore.pushLargeFile !== 'function') throw new Error('WHATSAPP_AUTH_LARGE_SNAPSHOT_UNSUPPORTED');
        await githubStore.pushLargeFile(remotePath, bytes);
      } else {
        await store.pushRemote(envelope);
      }
      lastDigest = digest;
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
      setError('lastPushError', err);
      console.error(`Échec de sauvegarde de la session WhatsApp pour le tenant "${tenantId}" :`, err.message);
      return false;
    }
  }

  function startPeriodicSync(authDir) {
    if (!enabled || snapshotTimer) return;
    snapshotTimer = setInterval(() => { pushSnapshot(authDir).catch(() => {}); }, SNAPSHOT_INTERVAL_MS);
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
      lastDigest = null;
      status.lastPushAt = new Date().toISOString();
      status.lastPushOk = true;
      status.lastPushError = null;
    } catch (err) {
      status.lastPushOk = false;
      setError('lastPushError', err);
      console.error(`Échec de suppression de la session WhatsApp distante pour le tenant "${tenantId}" :`, err.message);
    }
  }

  return {
    enabled,
    restoreSessionFromRemote,
    pushSnapshot,
    startPeriodicSync,
    stopPeriodicSync,
    clearRemote,
    getStatus: () => ({ ...store.getStatus(), enabled, storage: 'encrypted-complete-auth-dir', restoreSupported: enabled, ...status }),
  };
}

module.exports = { createAuthStore };
