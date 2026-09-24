'use strict';

// Render's free filesystem is ephemeral. Store only encrypted contact queue
// snapshots in the already-configured data repository; the repository may be
// public, so plaintext contact data is never written there.
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const githubStore = require('../githubStore');

const ROOT = 'ai_engine_data/contact_durable';
const PREFIX = 'cyrus-contact-durable-v1:';
const stores = new Map();
const writes = new Map();
let lastWriteAt = null;
let lastWriteError = null;
let lastReadError = null;

function enabled() {
  return githubStore.enabled && !!process.env.CLOUDFLARE_ADMIN_SECRET;
}
function filePath(scope, id) {
  const safeScope = String(scope || '').replace(/[^a-z0-9_-]/gi, '_');
  const safeId = String(id || '').replace(/[^a-z0-9_-]/gi, '_');
  return `${ROOT}/${safeScope}/${safeId}.json.enc`;
}
function storeFor(path) {
  if (!stores.has(path)) stores.set(path, githubStore.createStore(path));
  return stores.get(path);
}
function key() {
  const secret = String(process.env.CLOUDFLARE_ADMIN_SECRET || '');
  if (!secret) throw new Error('CONTACT_DURABLE_KEY_MISSING');
  return crypto.scryptSync(secret, PREFIX, 32);
}
function encrypt(value) {
  const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(value), 'utf8'));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return JSON.stringify({ v: 1, alg: 'aes-256-gcm+gzip', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') });
}
function decrypt(raw) {
  const envelope = JSON.parse(String(raw || ''));
  if (!envelope || envelope.v !== 1 || envelope.alg !== 'aes-256-gcm+gzip') throw new Error('CONTACT_DURABLE_FORMAT_INVALID');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const packed = Buffer.concat([decipher.update(Buffer.from(envelope.body, 'base64')), decipher.final()]);
  return JSON.parse(zlib.gunzipSync(packed).toString('utf8'));
}
async function put(scope, id, value) {
  if (!enabled()) return false;
  const path = filePath(scope, id);
  const prior = writes.get(path) || Promise.resolve();
  const current = prior.catch(() => {}).then(() => storeFor(path).pushRemote(encrypt(value)));
  writes.set(path, current);
  try {
    await current;
    lastWriteAt = new Date().toISOString();
    lastWriteError = null;
    return true;
  } catch (err) {
    lastWriteError = String(err && err.message || err).slice(0, 180);
    throw err;
  } finally {
    if (writes.get(path) === current) writes.delete(path);
  }
}
async function get(scope, id) {
  if (!enabled()) return null;
  try {
    const remote = await storeFor(filePath(scope, id)).fetchRemote();
    lastReadError = null;
    if (!remote || !remote.content) return null;
    return decrypt(remote.content);
  } catch (err) {
    lastReadError = String(err && err.message || err).slice(0, 180);
    throw err;
  }
}
async function list(scope) {
  if (!enabled()) return [];
  const dir = `${ROOT}/${String(scope || '').replace(/[^a-z0-9_-]/gi, '_')}`;
  const names = await githubStore.listDirectory(dir);
  return names.filter((x) => x.endsWith('.json.enc')).map((x) => x.slice(0, -9));
}
function status() {
  return { enabled: enabled(), encrypted: true, lastWriteAt, lastWriteError, lastReadError };
}

module.exports = { enabled, put, get, list, status, encrypt, decrypt, filePath };
