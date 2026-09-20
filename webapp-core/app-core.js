// Navigation + Génération IA - code PARTAGÉ entre mobile et desktop tel
// quel : la génération IA appelle directement les Cloud Functions Firebase
// (jamais CyrusEngine/CyrusStore, jamais le VPS), donc ne dépend d'aucun
// adaptateur de plateforme. Voir webapp-core/adapters/CONTRACT.md pour la
// règle générale que respecte le reste du cœur applicatif.
(function () {
  const FIREBASE_BASE = 'https://cyrus-license.ezechielatannidje.workers.dev'; // Worker Cloudflare (mêmes noms de routes que les anciennes fonctions Firebase)

  // ---------- Navigation ----------
  document.querySelectorAll('.nav button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.screen;
      document.querySelectorAll('.nav button').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('screen-' + target).classList.add('active');
    });
  });
  document.querySelector('.nav button[data-screen="connexions"]').classList.add('active');

  // ---------- Génération IA ----------
  function getDeviceId() {
    let id = localStorage.getItem('cyrus_device_id');
    if (!id) {
      id = 'dev-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('cyrus_device_id', id);
    }
    return id;
  }

  function getLicenseKey() {
    return localStorage.getItem('cyrus_license_key') || '';
  }

  async function verifyLicense(key) {
    const res = await fetch(FIREBASE_BASE + '/verifyLicenseOffline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: key, deviceId: getDeviceId() }),
    });
    return res.json();
  }

  function showAiGenerateCard() {
    document.getElementById('ai-license-card').style.display = 'none';
    document.getElementById('ai-generate-card').style.display = 'block';
  }

  (async function initAi() {
    const existing = getLicenseKey();
    if (existing) {
      const result = await verifyLicense(existing).catch(() => ({ valid: false }));
      if (result.valid) showAiGenerateCard();
    }
  })();

  document.getElementById('ai-license-btn').addEventListener('click', async () => {
    const input = document.getElementById('ai-license-input');
    const errorEl = document.getElementById('ai-license-error');
    const key = input.value.trim();
    if (!key) return;
    errorEl.textContent = '';
    const result = await verifyLicense(key).catch((e) => ({ valid: false, reason: String(e) }));
    if (result.valid) {
      localStorage.setItem('cyrus_license_key', key);
      showAiGenerateCard();
    } else {
      errorEl.textContent = 'Erreur : ' + (result.reason || 'clé invalide');
    }
  });

  function aiHeaders() {
    return { 'Content-Type': 'application/json', 'x-license-key': getLicenseKey(), 'x-device-id': getDeviceId() };
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  window.CyrusEscapeHtml = escapeHtml;

  document.getElementById('ai-text-btn').addEventListener('click', async () => {
    const prompt = document.getElementById('ai-prompt').value.trim();
    const errorEl = document.getElementById('ai-error');
    const resultEl = document.getElementById('ai-result');
    if (!prompt) return;
    errorEl.textContent = '';
    try {
      const res = await fetch(FIREBASE_BASE + '/generateTextFallback', {
        method: 'POST', headers: aiHeaders(), body: JSON.stringify({ prompt: prompt }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      resultEl.style.display = 'block';
      resultEl.innerHTML = '<div style="color:var(--green); font-size:11px; font-weight:700; margin-bottom:6px;">' + escapeHtml(data.provider) + '</div><div>' + escapeHtml(data.text) + '</div>';
    } catch (e) {
      errorEl.textContent = 'Erreur : ' + e;
    }
  });

  document.getElementById('ai-image-btn').addEventListener('click', async () => {
    const prompt = document.getElementById('ai-prompt').value.trim();
    const errorEl = document.getElementById('ai-error');
    const resultEl = document.getElementById('ai-result');
    if (!prompt) return;
    errorEl.textContent = '';
    try {
      const res = await fetch(FIREBASE_BASE + '/generateImageFallback', {
        method: 'POST', headers: aiHeaders(), body: JSON.stringify({ prompt: prompt }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      resultEl.style.display = 'block';
      resultEl.innerHTML = '<div style="color:var(--green); font-size:11px; font-weight:700; margin-bottom:6px;">' + escapeHtml(data.provider) + '</div><img style="width:100%; border-radius:8px; margin-top:6px;" src="' + data.url + '" />';
    } catch (e) {
      errorEl.textContent = 'Erreur : ' + e;
    }
  });
})();
