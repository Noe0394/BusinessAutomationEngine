const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { verifyToken } = require('../local-client/lib/offlineLicense');

function makeToken(claims, privateKey) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto.sign(null, Buffer.from(payload, 'ascii'), privateKey).toString('base64url');
  return `${payload}.${signature}`;
}

test('licence hors-ligne Ed25519: accepte un jeton valide et lié à cet appareil', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyBytes = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const now = Date.now();
  const claims = {
    key: 'KEY-TEST-2026', deviceId: 'device-a', allowedModules: ['whatsapp'],
    licenseExpiresAt: null, issuedAt: now - 1000, offlineGraceUntil: now + 60_000,
  };
  const token = makeToken(claims, privateKey);

  assert.deepEqual(await verifyToken(token, { key: claims.key.toLowerCase(), deviceId: claims.deviceId, now, publicKey: publicKeyBytes }), claims);
  assert.equal(await verifyToken(token, { key: claims.key, deviceId: 'device-b', now, publicKey: publicKeyBytes }), null);
  assert.equal(await verifyToken(token, { key: claims.key, deviceId: claims.deviceId, now: now + 60_000, publicKey: publicKeyBytes }), null);
  assert.equal(await verifyToken(`${token}x`, { key: claims.key, deviceId: claims.deviceId, now, publicKey: publicKeyBytes }), null);
});

test('licence mobile WebCrypto: valide le même jeton dans la WebView', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyBytes = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const source = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'webapp', 'www', 'lib', 'offline-license.js'), 'utf8')
    .replace(/const PUBLIC_KEY = '[^']+';/, `const PUBLIC_KEY = '${publicKeyBytes}';`);
  const store = new Map();
  const browser = {
    crypto: crypto.webcrypto, atob, btoa, TextEncoder, TextDecoder,
    localStorage: { getItem: (key) => store.get(key) || null, setItem: (key, value) => store.set(key, value), removeItem: (key) => store.delete(key) },
  };
  browser.window = browser;
  vm.runInNewContext(source, browser);
  const now = Date.now();
  const claims = { key: 'KEY-MOBILE-2026', deviceId: 'phone-a', allowedModules: ['whatsapp'], licenseExpiresAt: null, issuedAt: now, offlineGraceUntil: now + 60_000 };
  const token = makeToken(claims, privateKey);
  const result = await browser.CyrusOfflineLicense.verify(token, claims.key.toLowerCase(), claims.deviceId, now);
  assert.equal(result.key, claims.key);
  assert.equal(result.deviceId, claims.deviceId);
  assert.equal(await browser.CyrusOfflineLicense.verify(token, claims.key, 'phone-b', now), null);
});
