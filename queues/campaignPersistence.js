'use strict';

const storage = require('../ai-engine/storageAdapter');
const vault = require('../ai-engine/secretVault');

function encryptionRequired() {
  return storage.isEncryptedMirror('campaign_state');
}

function encodeText(plainText) {
  if (!encryptionRequired()) return String(plainText);
  if (!vault.isEncryptionConfigured()) throw new Error('CAMPAIGN_STATE_ENCRYPTION_KEY_MISSING');
  return JSON.stringify({ _cyrusEncrypted: 1, payload: vault.encrypt(String(plainText)) });
}

function decodeText(remoteText) {
  const text = String(remoteText || '');
  let envelope;
  try { envelope = JSON.parse(text); } catch (_) { return { text, encrypted: false }; }
  if (!envelope || envelope._cyrusEncrypted !== 1) return { text, encrypted: false };
  const plaintext = vault.decrypt(envelope.payload);
  if (plaintext == null) throw new Error('CAMPAIGN_STATE_DECRYPT_FAILED');
  return { text: plaintext, encrypted: true };
}

function encodeBuffer(buffer) {
  if (!encryptionRequired()) return Buffer.from(buffer);
  if (!vault.isEncryptionConfigured()) throw new Error('CAMPAIGN_MEDIA_ENCRYPTION_KEY_MISSING');
  return Buffer.from(JSON.stringify({ _cyrusEncrypted: 1, payload: vault.encrypt(Buffer.from(buffer).toString('base64')) }), 'utf8');
}

function decodeBuffer(buffer) {
  const input = Buffer.from(buffer);
  if (!encryptionRequired()) return input;
  let envelope;
  try { envelope = JSON.parse(input.toString('utf8')); } catch (_) { return input; }
  if (!envelope || envelope._cyrusEncrypted !== 1) return input;
  const plaintext = vault.decrypt(envelope.payload);
  if (plaintext == null) throw new Error('CAMPAIGN_MEDIA_DECRYPT_FAILED');
  return Buffer.from(plaintext, 'base64');
}

function isEncryptedBuffer(buffer) {
  try { return JSON.parse(Buffer.from(buffer).toString('utf8'))._cyrusEncrypted === 1; } catch (_) { return false; }
}

module.exports = { encryptionRequired, encodeText, decodeText, encodeBuffer, decodeBuffer, isEncryptedBuffer };
