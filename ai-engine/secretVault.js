const crypto = require('crypto');
const storageAdapter = require('./storageAdapter');

// COFFRE À SECRETS CHIFFRÉ — ai-engine/secretVault.js
// ---------------------------------------------------------------------------
// Stockage sécurisé des identifiants sensibles des Services Métiers (clés API,
// tokens...) : chiffrés AU REPOS (AES-256-GCM), isolés PAR TENANT, jamais
// exposés en clair dans les conversations ni dans les logs. La clé de
// chiffrement vient d'un secret SERVEUR (SECRET_VAULT_KEY, sinon ADMIN_PASSWORD)
// — jamais du stockage lui-même : les enregistrements chiffrés peuvent donc
// être mirroités sur GitHub (storageAdapter) sans révéler les secrets, car la
// clé n'y est pas.
//
// L'UI n'appelle JAMAIS getSecret (valeur en clair) — seulement hasSecret /
// listRefs (présence). Seul le runtime serveur (connectorManager,
// businessServices.testConnection) déchiffre au moment d'un appel réel.

const NAMESPACE = 'secret_vault';

function keyMaterial() {
  const s = process.env.SECRET_VAULT_KEY || process.env.ADMIN_PASSWORD || '';
  if (!s) {
    console.warn('secretVault: ni SECRET_VAULT_KEY ni ADMIN_PASSWORD définis — chiffrement avec une clé par défaut (À CONFIGURER en production).');
  }
  return crypto.createHash('sha256').update(`cyrus-vault::${s || 'default-insecure'}`).digest();
}

function isEncryptionConfigured() {
  return Boolean(process.env.SECRET_VAULT_KEY || process.env.ADMIN_PASSWORD);
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyMaterial(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

function decrypt(rec) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyMaterial(), Buffer.from(rec.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(rec.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(rec.ct, 'base64')), decipher.final()]).toString('utf8');
  } catch (err) {
    return null; // clé changée / donnée corrompue : jamais de valeur fausse.
  }
}

function sanitize(id) { return String(id || '').trim().replace(/[^A-Za-z0-9_-]/g, '_') || 'default'; }

async function load(tenant) {
  return storageAdapter.get(NAMESPACE, sanitize(tenant), { tenant: sanitize(tenant), secrets: {} });
}

// Stocke (chiffre) un secret sous une référence (ex. "service_<id>"). Retourne
// seulement des métadonnées, JAMAIS la valeur.
async function setSecret(tenant, ref, value) {
  if (!ref || value == null || value === '') return { ok: false, error: 'MISSING_REF_OR_VALUE' };
  const doc = await load(tenant);
  doc.secrets = doc.secrets || {};
  doc.secrets[sanitize(ref)] = Object.assign({ updatedAt: new Date().toISOString() }, encrypt(value));
  storageAdapter.set(NAMESPACE, sanitize(tenant), doc);
  return { ok: true, ref: sanitize(ref), stored: true };
}

// Usage SERVEUR uniquement (déchiffrement) — jamais renvoyé à l'UI ni loggé.
async function getSecret(tenant, ref) {
  const doc = await load(tenant);
  const rec = doc.secrets && doc.secrets[sanitize(ref)];
  return rec ? decrypt(rec) : null;
}

async function hasSecret(tenant, ref) {
  const doc = await load(tenant);
  return !!(doc.secrets && doc.secrets[sanitize(ref)]);
}

async function revoke(tenant, ref) {
  const doc = await load(tenant);
  if (doc.secrets && doc.secrets[sanitize(ref)]) {
    delete doc.secrets[sanitize(ref)];
    storageAdapter.set(NAMESPACE, sanitize(tenant), doc);
  }
  return { ok: true, revoked: sanitize(ref) };
}

// Liste des RÉFÉRENCES connues (noms), jamais les valeurs.
async function listRefs(tenant) {
  const doc = await load(tenant);
  return Object.keys(doc.secrets || {});
}

module.exports = { setSecret, getSecret, hasSecret, revoke, listRefs, encrypt, decrypt, isEncryptionConfigured, NAMESPACE };
