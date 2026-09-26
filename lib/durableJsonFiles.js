'use strict';

const fs = require('fs');
const path = require('path');
const githubStore = require('../githubStore');
const secretVault = require('../ai-engine/secretVault');

const ROOT = path.resolve(__dirname, '..');
const stores = new Map();
const writeChains = new Map();
const pendingWrites = new Set();

function isProduction() {
  return process.env.NODE_ENV === 'production' || process.env.RENDER === 'true'
    || !!process.env.RENDER_SERVICE_ID || !!process.env.RENDER_EXTERNAL_URL;
}
function remotePath(filePath) {
  const absolute = path.resolve(filePath);
  const relative = path.relative(ROOT, absolute).split(path.sep).join('/');
  if (!relative || relative === '..' || relative.startsWith('../')) throw new Error('DURABLE_FILE_OUTSIDE_APP_ROOT');
  return relative;
}
function getStore(filePath) {
  const remote = remotePath(filePath);
  if (!stores.has(remote)) stores.set(remote, githubStore.createStore(remote));
  return stores.get(remote);
}
function encrypt(content) {
  if (!secretVault.isEncryptionConfigured()) throw new Error('SECRET_VAULT_KEY_NOT_CONFIGURED');
  return JSON.stringify({ _cyrusEncrypted: 1, format: 'cyrus-durable-json-v1', payload: secretVault.encrypt(content) });
}

async function write(filePath, data) {
  const serialized = JSON.stringify(data, null, 2);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, serialized, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch (_) { /* platform ACLs differ */ }
  if (!githubStore.enabled) {
    if (isProduction()) throw new Error('DURABLE_FILE_STORE_UNAVAILABLE');
    return data;
  }
  const store = getStore(filePath);
  const previous = writeChains.get(store) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => store.pushRemote(encrypt(serialized)));
  writeChains.set(store, pending);
  pendingWrites.add(pending);
  pending.finally(() => pendingWrites.delete(pending)).catch(() => {});
  await pending;
  return data;
}

async function restore(filePath) {
  if (fs.existsSync(filePath)) return false;
  if (!githubStore.enabled) {
    if (isProduction()) throw new Error('DURABLE_FILE_STORE_UNAVAILABLE');
    return false;
  }
  const remote = await getStore(filePath).fetchRemote();
  const content = await githubStore.fetchRemoteContent(remote);
  if (!content) return false;
  const envelope = JSON.parse(content);
  let plain;
  const legacy = !envelope || envelope._cyrusEncrypted !== 1;
  if (legacy) {
    if (!isProduction()) return false;
    plain = content;
  } else {
    if (envelope.format !== 'cyrus-durable-json-v1') throw new Error('DURABLE_FILE_REMOTE_FORMAT_UNSUPPORTED');
    plain = secretVault.decrypt(envelope.payload);
  }
  if (plain == null) throw new Error('DURABLE_FILE_DECRYPT_FAILED');
  const value = JSON.parse(plain);
  if (legacy) {
    await write(filePath, value);
    return true;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, plain, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch (_) { /* platform ACLs differ */ }
  return true;
}

async function remove(filePath) {
  try { fs.unlinkSync(filePath); } catch (_) { /* absent locally */ }
  if (!githubStore.enabled) return true;
  await getStore(filePath).deleteRemote();
  return true;
}

async function persistBlob(filePath, buffer) {
  if (!githubStore.enabled) {
    if (isProduction()) throw new Error('DURABLE_FILE_STORE_UNAVAILABLE');
    return null;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
  return githubStore.pushLargeFile(remotePath(filePath), Buffer.from(buffer));
}

async function restoreMany(filePaths) {
  const results = [];
  for (const filePath of filePaths) results.push(await restore(filePath));
  return results;
}

async function flushPendingWrites(timeoutMs = 9000) {
  if (!pendingWrites.size) return { pending: 0, completed: true };
  let timer;
  const result = await Promise.race([
    Promise.allSettled(Array.from(pendingWrites)).then(() => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
  ]);
  if (timer) clearTimeout(timer);
  return { pending: pendingWrites.size, completed: result };
}

module.exports = { remotePath, write, restore, remove, persistBlob, restoreMany, flushPendingWrites };
