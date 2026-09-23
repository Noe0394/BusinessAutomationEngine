// Vérification locale des preuves de licence signées par le Worker Cyrus.
// Le cache est un jeton signé : modifier son contenu invalide sa signature.
const fs = require('fs');
const { webcrypto } = require('crypto');
const publicKeyBytes = require('./licensePublicKey');
const { LICENSE_TOKEN_PATH } = require('./paths');

const base64url = (value) => Buffer.from(value).toString('base64url');

function readToken() {
  try {
    const value = JSON.parse(fs.readFileSync(LICENSE_TOKEN_PATH, 'utf8'));
    return typeof value?.token === 'string' ? value.token : null;
  } catch (_) {
    return null;
  }
}

function writeToken(token) {
  if (typeof token !== 'string' || token.length > 8192) throw new Error('INVALID_LICENSE_TOKEN');
  const temporary = `${LICENSE_TOKEN_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ token }), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, LICENSE_TOKEN_PATH);
}

function clearToken() {
  try { fs.unlinkSync(LICENSE_TOKEN_PATH); } catch (err) { if (err.code !== 'ENOENT') throw err; }
}

async function verifyToken(token, { key, deviceId, now = Date.now(), publicKey = publicKeyBytes }) {
  if (typeof token !== 'string' || token.length > 8192) return null;
  const [payloadPart, signaturePart, extra] = token.split('.');
  if (!payloadPart || !signaturePart || extra !== undefined) return null;

  try {
    const payloadBytes = Buffer.from(payloadPart, 'base64url');
    const claims = JSON.parse(payloadBytes.toString('utf8'));
    if (base64url(payloadBytes) !== payloadPart) return null;
    if (claims.key !== (typeof key === 'string' ? key.trim().toUpperCase() : key) || claims.deviceId !== deviceId) return null;
    if (!Number.isFinite(claims.offlineGraceUntil) || now >= claims.offlineGraceUntil) return null;
    if (claims.licenseExpiresAt !== null && (!Number.isFinite(claims.licenseExpiresAt) || now >= claims.licenseExpiresAt)) return null;
    if (!Array.isArray(claims.allowedModules) || !claims.allowedModules.every((m) => typeof m === 'string')) return null;

    const importedKey = await webcrypto.subtle.importKey('raw', Buffer.from(publicKey, 'base64'), { name: 'Ed25519' }, false, ['verify']);
    const valid = await webcrypto.subtle.verify(
      { name: 'Ed25519' }, importedKey, Buffer.from(signaturePart, 'base64url'), Buffer.from(payloadPart, 'ascii'),
    );
    return valid ? claims : null;
  } catch (_) {
    return null;
  }
}

module.exports = { readToken, writeToken, clearToken, verifyToken };
