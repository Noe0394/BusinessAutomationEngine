// Validation hors-ligne des licences Cyrus : preuve Ed25519 émise par le Worker.
(function (root) {
  const PUBLIC_KEY = 'r90NvIBSzUx3WAIKgLhOi9hsnm2/NofQLTL6jMVF/o0=';
  const TOKEN_KEY = 'cyrus_license_offline_token';

  async function verify(token, key, deviceId, now) {
    if (!token || token.length > 8192 || !root.crypto?.subtle) return null;
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    try {
      const decode = (value) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), (c) => c.charCodeAt(0));
      const payloadBytes = decode(parts[0]);
      const claims = JSON.parse(new TextDecoder().decode(payloadBytes));
      if (claims.key !== String(key || '').trim().toUpperCase() || claims.deviceId !== deviceId) return null;
      if (!Number.isFinite(claims.offlineGraceUntil) || (now || Date.now()) >= claims.offlineGraceUntil) return null;
      if (claims.licenseExpiresAt !== null && (!Number.isFinite(claims.licenseExpiresAt) || (now || Date.now()) >= claims.licenseExpiresAt)) return null;
      if (!Array.isArray(claims.allowedModules) || !claims.allowedModules.every((m) => typeof m === 'string')) return null;
      const publicKey = await crypto.subtle.importKey('raw', decode(PUBLIC_KEY), { name: 'Ed25519' }, false, ['verify']);
      const valid = await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, decode(parts[1]), new TextEncoder().encode(parts[0]));
      return valid ? claims : null;
    } catch (_) { return null; }
  }

  root.CyrusOfflineLicense = {
    verify,
    getToken: () => { try { return localStorage.getItem(TOKEN_KEY); } catch (_) { return null; } },
    setToken: (token) => { try { localStorage.setItem(TOKEN_KEY, token); } catch (_) { /* storage indisponible */ } },
    clearToken: () => { try { localStorage.removeItem(TOKEN_KEY); } catch (_) { /* storage indisponible */ } },
  };
})(window);
