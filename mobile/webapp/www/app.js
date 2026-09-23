// Logique de l'app CYRUS SUPER ASSISTANT (webapp Capacitor). Pas de
// framework/bundler ici : DOM standard + le plugin natif EmbeddedWebView
// (voir android/.../EmbeddedWebViewPlugin.java) expose automatiquement sur
// window.Capacitor.Plugins par le runtime Capacitor.
(function () {
  const EmbeddedWebView = window.Capacitor.Plugins.EmbeddedWebView;
  const DESKTOP_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
  const FIREBASE_BASE = 'https://cyrus-license.ezechielatannidje.workers.dev'; // Worker Cloudflare (mêmes noms de routes que les anciennes fonctions Firebase)

  // ---------- Navigation ----------
  let activeTab = 'whatsapp';

  // Une WebView native embarquee s'affiche TOUJOURS par-dessus le HTML,
  // quel que soit le CSS/z-index (couche native separee) - elle doit donc
  // etre explicitement masquee des qu'on quitte son onglet, sinon elle
  // reste visible et bloque les autres onglets (constate sur appareil,
  // 2026-09-10). syncWebViewVisibility() est le point unique de verite :
  // visible seulement si (onglet actif ET pas encore connecte).
  async function syncWebViewVisibility() {
    if (waStarted) {
      const show = activeTab === 'whatsapp' && !waConnected;
      await EmbeddedWebView.setVisible({ id: 'whatsapp', visible: show });
      if (show) applyBounds('whatsapp', 'whatsapp');
    }
    if (tgStarted) {
      const show = activeTab === 'telegram' && !tgConnected;
      await EmbeddedWebView.setVisible({ id: 'telegram', visible: show });
      if (show) applyBounds('telegram', 'telegram');
    }
  }

  // Calcule la zone (en pixels ecran, pas pixels CSS) sous l'entete+la barre
  // de statut de l'onglet et au-dessus de sa barre de contact, pour que la
  // WebView embarquee ne recouvre jamais l'UI native de l'app - voir
  // EmbeddedWebViewPlugin#setBounds.
  function applyBounds(id, screenPrefix) {
    const dpr = window.devicePixelRatio || 1;
    const statusBar = document.querySelector('#screen-' + screenPrefix + ' .statusbar');
    const contactBar = document.getElementById(screenPrefix + '-contact-bar');
    const top = statusBar ? Math.round(statusBar.getBoundingClientRect().bottom * dpr) : 0;
    const bottom = contactBar && contactBar.style.display !== 'none'
      ? Math.round((window.innerHeight - contactBar.getBoundingClientRect().top) * dpr)
      : 0;
    EmbeddedWebView.setBounds({ id: id, top: top, bottom: bottom });
  }

  document.querySelectorAll('.nav button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.screen;
      activeTab = target;
      document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
      document.getElementById('screen-' + target).classList.add('active');
      if (target === 'whatsapp' && !waStarted) startWhatsApp();
      if (target === 'telegram' && !tgStarted) startTelegram();
      syncWebViewVisibility();
    });
  });

  function normalizeWid(raw) {
    return String(raw || '').split('@')[0].replace(/\D/g, '');
  }

  // ---------- WhatsApp ----------
  let waStarted = false;
  let waBridgeReady = false;
  let waConnected = false;
  let waMessages = []; // {id, from, to, fromMe, body, t}
  let waActiveContact = '';

  async function startWhatsApp() {
    waStarted = true;
    await fetch('whatsappBridge.js').then((r) => r.text()).then((script) => {
      window.__waBridgeScript = script;
    });
    await EmbeddedWebView.open({ id: 'whatsapp', url: 'https://web.whatsapp.com', userAgent: DESKTOP_UA });
    await syncWebViewVisibility();
    // La WebView se recharge a chaque open() : reinjecte le pont apres un
    // court delai pour laisser la page demarrer son execution JS.
    setTimeout(() => EmbeddedWebView.evaluate({ id: 'whatsapp', script: window.__waBridgeScript }), 1500);
  }

  function setWaStatus(text, on) {
    document.getElementById('wa-status').textContent = text;
    document.getElementById('wa-dot').classList.toggle('on', !!on);
    // Miroir sur la page Connexions unifiée (voir connexions.js) - source
    // unique de vérité mise à jour ici, pas de polling séparé.
    const connStatus = document.getElementById('conn-wa-status');
    const connDot = document.getElementById('conn-wa-dot');
    if (connStatus) connStatus.textContent = text;
    if (connDot) connDot.classList.toggle('on', !!on);
  }

  // Déconnexion réelle (page Connexions) : efface cookies/stockage web de la
  // WebView WhatsApp Web (voir EmbeddedWebViewPlugin#logout) et réinitialise
  // tout l'état local - un retour sur l'onglet WhatsApp relance une session
  // vierge (nouveau QR) au lieu de réutiliser une WebView déjà détruite.
  async function logoutWhatsApp() {
    if (waStarted) await EmbeddedWebView.logout({ id: 'whatsapp' });
    waStarted = false;
    waBridgeReady = false;
    waConnected = false;
    waMessages = [];
    waActiveContact = '';
    document.getElementById('wa-thread').style.display = 'none';
    document.getElementById('wa-compose').style.display = 'none';
    document.getElementById('wa-list').style.display = 'block';
    document.getElementById('wa-contact-bar').style.display = 'flex';
    setWaStatus('Non connecté', false);
    renderWaList();
    if (activeTab === 'whatsapp') startWhatsApp();
  }

  function renderWaList() {
    const byPeer = new Map();
    for (const m of waMessages) {
      const peer = normalizeWid(m.fromMe ? m.to : m.from);
      if (!peer) continue;
      const existing = byPeer.get(peer);
      if (!existing || m.t > existing.t) byPeer.set(peer, m);
    }
    const list = Array.from(byPeer.entries()).sort((a, b) => b[1].t - a[1].t);
    const el = document.getElementById('wa-list');
    el.innerHTML = '';
    if (list.length === 0) {
      el.innerHTML = '<p class="empty">Aucune conversation pour l’instant.</p>';
    }
    list.forEach(([peer, last]) => {
      const row = document.createElement('div');
      row.className = 'chat-row';
      row.innerHTML =
        '<div class="avatar">' + peer.slice(-2) + '</div>' +
        '<div class="chat-body"><div class="chat-peer">' + peer + '</div>' +
        '<div class="chat-preview">' + (last.fromMe ? 'Moi: ' : '') + escapeHtml(last.body) + '</div></div>';
      row.addEventListener('click', () => openWaContact(peer));
      el.appendChild(row);
    });
  }

  function renderWaThread() {
    const el = document.getElementById('wa-thread');
    const thread = waMessages.filter((m) => normalizeWid(m.fromMe ? m.to : m.from) === waActiveContact);
    el.innerHTML = '';
    if (thread.length === 0) {
      el.innerHTML = '<p class="empty">Aucun message avec ' + waActiveContact + ' pour l’instant.</p>';
    }
    thread.forEach((m) => {
      const row = document.createElement('div');
      row.className = 'bubble-row ' + (m.fromMe ? 'mine' : 'other');
      row.innerHTML = '<div class="bubble ' + (m.fromMe ? 'mine' : 'other') + '">' + escapeHtml(m.body) + '</div>';
      el.appendChild(row);
    });
    el.scrollTop = el.scrollHeight;
  }

  function openWaContact(peer) {
    waActiveContact = peer;
    document.getElementById('wa-list').style.display = 'none';
    document.getElementById('wa-contact-bar').style.display = 'none';
    document.getElementById('wa-thread').style.display = 'block';
    document.getElementById('wa-compose').style.display = 'flex';
    renderWaThread();
  }

  document.getElementById('wa-open-btn').addEventListener('click', () => {
    const digits = document.getElementById('wa-contact-input').value.replace(/\D/g, '');
    if (digits) openWaContact(digits);
  });

  document.getElementById('wa-send-btn').addEventListener('click', () => {
    const input = document.getElementById('wa-text-input');
    const text = input.value.trim();
    if (!text || !waActiveContact || !waBridgeReady) return;
    EmbeddedWebView.evaluate({
      id: 'whatsapp',
      script: 'window.__cyrusSend && window.__cyrusSend(' + JSON.stringify(waActiveContact + '@c.us') + ', ' + JSON.stringify(text) + ');',
    });
    input.value = '';
  });

  // ---------- Telegram ----------
  let tgStarted = false;
  let tgBridgeReady = false;
  let tgConnected = false;
  let tgMessages = [];
  let tgActiveContact = '';

  async function startTelegram() {
    tgStarted = true;
    await fetch('telegramBridge.js').then((r) => r.text()).then((script) => {
      window.__tgBridgeScript = script;
    });
    await EmbeddedWebView.open({ id: 'telegram', url: 'https://web.telegram.org/k/', userAgent: DESKTOP_UA });
    await syncWebViewVisibility();
    setTimeout(() => EmbeddedWebView.evaluate({ id: 'telegram', script: window.__tgBridgeScript }), 1500);
  }

  function setTgStatus(text, on) {
    document.getElementById('tg-status').textContent = text;
    document.getElementById('tg-dot').classList.toggle('on', !!on);
    const connStatus = document.getElementById('conn-tg-status');
    const connDot = document.getElementById('conn-tg-dot');
    if (connStatus) connStatus.textContent = text;
    if (connDot) connDot.classList.toggle('on', !!on);
  }

  async function logoutTelegram() {
    if (tgStarted) await EmbeddedWebView.logout({ id: 'telegram' });
    tgStarted = false;
    tgBridgeReady = false;
    tgConnected = false;
    tgMessages = [];
    tgActiveContact = '';
    document.getElementById('tg-thread').style.display = 'none';
    document.getElementById('tg-compose').style.display = 'none';
    document.getElementById('tg-list').style.display = 'block';
    document.getElementById('tg-contact-bar').style.display = 'flex';
    setTgStatus('Non connecté', false);
    if (activeTab === 'telegram') startTelegram();
  }

  function openTgContact(peer) {
    tgActiveContact = peer;
    document.getElementById('tg-list').style.display = 'none';
    document.getElementById('tg-contact-bar').style.display = 'none';
    document.getElementById('tg-thread').style.display = 'block';
    document.getElementById('tg-compose').style.display = 'flex';
  }

  document.getElementById('tg-open-btn').addEventListener('click', () => {
    const value = document.getElementById('tg-contact-input').value.trim();
    if (value) openTgContact(value);
  });

  document.getElementById('tg-send-btn').addEventListener('click', () => {
    const input = document.getElementById('tg-text-input');
    const text = input.value.trim();
    if (!text || !tgActiveContact || !tgBridgeReady) return;
    EmbeddedWebView.evaluate({
      id: 'telegram',
      script: 'window.__cyrusTgSend && window.__cyrusTgSend(' + JSON.stringify(tgActiveContact) + ', ' + JSON.stringify(text) + ');',
    });
    input.value = '';
  });

  // ---------- Pont commun (evenements des deux WebViews embarquees) ----------
  EmbeddedWebView.addListener('message', (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (e) {
      return;
    }

    if (event.id === 'whatsapp') {
      switch (data.type) {
        case 'state':
          waConnected = data.payload.state === 'CONNECTED';
          setWaStatus(waConnected ? 'Connecte' : data.payload.state, waConnected);
          syncWebViewVisibility();
          break;
        case 'bridge-ready':
          waBridgeReady = true;
          break;
        case 'message':
          waMessages.push(data.payload);
          if (waMessages.length > 200) waMessages.shift();
          renderWaList();
          if (waActiveContact) renderWaThread();
          if (window.CyrusBusinessServices) window.CyrusBusinessServices.handleIncomingWA(data.payload).catch(err => console.warn('Réponse FAQ mobile :', err.message));
          break;
        case 'groups':
          if (window.CyrusParity) window.CyrusParity.renderGroups('WHATSAPP', data.payload.groups || []);
          break;
        case 'group-members':
          if (window.CyrusParity) window.CyrusParity.renderMembers('WHATSAPP', data.payload);
          break;
        case 'send-result':
          if (!data.payload.ok) alert('Echec envoi WhatsApp: ' + data.payload.error);
          break;
      }
    }

    if (event.id === 'telegram') {
      switch (data.type) {
        case 'state':
          tgConnectedUpdate(data.payload);
          break;
        case 'bridge-ready':
          tgBridgeReady = true;
          break;
        case 'groups':
          if (window.CyrusParity) window.CyrusParity.renderGroups('TELEGRAM', data.payload.groups || []);
          break;
        case 'group-members':
          if (window.CyrusParity) window.CyrusParity.renderMembers('TELEGRAM', data.payload);
          break;
        case 'send-result':
          if (!data.payload.ok) alert('Echec envoi Telegram: ' + data.payload.error);
          break;
      }
    }
  });

  function tgConnectedUpdate(payload) {
    tgConnected = !!payload.authorized;
    setTgStatus(tgConnected ? 'Connecte' : 'Non connecte', tgConnected);
    syncWebViewVisibility();
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Generation IA ----------
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
    const deviceId = getDeviceId();
    const claims = await window.CyrusOfflineLicense.verify(window.CyrusOfflineLicense.getToken(), key, deviceId);
    if (claims) {
      refreshLicenseOnline(key).catch(() => {});
      return { valid: true, offline: true, expiresAt: claims.licenseExpiresAt ? new Date(claims.licenseExpiresAt).toISOString() : null, allowedModules: claims.allowedModules };
    }
    const result = await verifyLicenseOnline(key);
    if (result.valid && result.offlineToken) window.CyrusOfflineLicense.setToken(result.offlineToken);
    else if (!result.valid) window.CyrusOfflineLicense.clearToken();
    return result;
  }

  async function verifyLicenseOnline(key) {
    const res = await fetch(FIREBASE_BASE + '/verifyLicenseOffline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: key, deviceId: getDeviceId() }),
    });
    return res.json();
  }

  async function refreshLicenseOnline(key) {
    try {
      const result = await verifyLicenseOnline(key);
      if (!result.valid) {
        window.CyrusOfflineLicense.clearToken();
        window.location.reload();
      } else if (result.offlineToken) {
        window.CyrusOfflineLicense.setToken(result.offlineToken);
      }
    } catch (_) { /* réseau indisponible : le jeton local reste valide jusqu'à sa grâce */ }
  }

  function showAiGenerateCard() {
    document.getElementById('ai-license-card').style.display = 'none';
    document.getElementById('ai-generate-card').style.display = 'block';
    document.getElementById('ai-ebook-card').style.display = 'block';
  }

  (async function initAi() {
    const existing = getLicenseKey();
    if (existing) {
      const result = await verifyLicense(existing).catch(() => ({ valid: false }));
      if (result.valid) showAiGenerateCard();
      setInterval(() => refreshLicenseOnline(existing), 6 * 60 * 60 * 1000);
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
      errorEl.textContent = 'Erreur : ' + (result.reason || 'cle invalide');
    }
  });

  function aiHeaders() {
    return { 'Content-Type': 'application/json', 'x-license-key': getLicenseKey(), 'x-device-id': getDeviceId() };
  }

  document.getElementById('ai-text-btn').addEventListener('click', async () => {
    const rawPrompt = document.getElementById('ai-prompt').value.trim();
    const prompt = window.CyrusBusinessServices ? await window.CyrusBusinessServices.promptContext(rawPrompt) : rawPrompt;
    const errorEl = document.getElementById('ai-error');
    const resultEl = document.getElementById('ai-result');
    if (!prompt) return;
    errorEl.textContent = '';
    try {
      const res = await fetch(FIREBASE_BASE + '/generateTextFallback', {
        method: 'POST',
        headers: aiHeaders(),
        body: JSON.stringify({ prompt: prompt }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      resultEl.style.display = 'block';
      resultEl.innerHTML = '<div class="result-provider">' + escapeHtml(data.provider) + '</div><div>' + escapeHtml(data.text) + '</div>';
    } catch (e) {
      errorEl.textContent = 'Erreur : ' + e;
    }
  });

  document.getElementById('ai-image-btn').addEventListener('click', async () => {
    const rawPrompt = document.getElementById('ai-prompt').value.trim();
    const prompt = window.CyrusBusinessServices ? await window.CyrusBusinessServices.promptContext(rawPrompt) : rawPrompt;
    const errorEl = document.getElementById('ai-error');
    const resultEl = document.getElementById('ai-result');
    if (!prompt) return;
    errorEl.textContent = '';
    try {
      const res = await fetch(FIREBASE_BASE + '/generateImageFallback', {
        method: 'POST',
        headers: aiHeaders(),
        body: JSON.stringify({ prompt: prompt }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      resultEl.style.display = 'block';
      resultEl.innerHTML = '<div class="result-provider">' + escapeHtml(data.provider) + '</div><img class="result-image" src="' + data.url + '" />';
    } catch (e) {
      errorEl.textContent = 'Erreur : ' + e;
    }
  });

  // ---------- Génération d'ebook (PDF) ----------
  // Parité avec local-client/public/ai.js#ebookGenerate et
  // public/dashboard.html (Studio IA > Générateur de Livres). pdfkit est une
  // bibliothèque Node.js (aucun portage navigateur viable sans bundler, hors
  // périmètre "zéro framework" de ce projet) — la génération PDF elle-même
  // tourne donc sur la Cloud Function generateEbookFallback (mêmes secrets/
  // cascade texte que generateTextFallback, voir firebase-functions/index.js),
  // pas dans cet onglet. Reste 100% hors VPS : uniquement Firebase, comme le
  // reste de la Génération IA mobile.
  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  document.getElementById('ebook-generate-btn').addEventListener('click', async () => {
    const title = document.getElementById('ebook-title').value.trim();
    const subtitle = document.getElementById('ebook-subtitle').value.trim();
    const author = document.getElementById('ebook-author').value.trim();
    const date = document.getElementById('ebook-date').value.trim();
    const watermarkText = document.getElementById('ebook-watermark').value.trim();
    const introduction = document.getElementById('ebook-intro').value.trim();
    const conclusion = document.getElementById('ebook-conclusion').value.trim();
    const topics = document.getElementById('ebook-topics').value.split('\n').map((s) => s.trim()).filter(Boolean);
    const errorEl = document.getElementById('ebook-error');
    const statusEl = document.getElementById('ebook-status');
    errorEl.textContent = '';
    statusEl.textContent = '';
    if (topics.length === 0) { errorEl.textContent = 'Indique au moins un sujet de chapitre.'; return; }

    const coverFile = document.getElementById('ebook-cover-file').files[0];
    const logoFile = document.getElementById('ebook-logo-file').files[0];
    const coverImageBase64 = coverFile ? await readFileAsBase64(coverFile) : undefined;
    const logoImageBase64 = logoFile ? await readFileAsBase64(logoFile) : undefined;

    statusEl.textContent = 'Rédaction en cours (' + topics.length + ' chapitre(s), séquentiel)...';
    try {
      const res = await fetch(FIREBASE_BASE + '/generateEbookFallback', {
        method: 'POST',
        headers: aiHeaders(),
        body: JSON.stringify({
          title, subtitle, author, date, watermarkText, introduction, conclusion,
          chapterTopics: topics, coverImageBase64, logoImageBase64,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || ('HTTP ' + res.status));
      }
      // Pas de <a download> ici : une WebView Capacitor n'a pas d'accès
      // direct au stockage utilisateur — même mécanisme que lib/fileExport.js
      // (Filesystem.writeFile + Share.share), seul moyen réel de faire
      // quelque chose du fichier depuis le stockage privé de l'app.
      const buffer = await res.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const base64 = btoa(binary);
      const filename = (title || 'livre').replace(/[^a-z0-9]+/gi, '_').slice(0, 80) + '.pdf';
      const Filesystem = window.Capacitor.Plugins.Filesystem;
      const Share = window.Capacitor.Plugins.Share;
      const written = await Filesystem.writeFile({ path: filename, data: base64, directory: 'DOCUMENTS' });
      await Share.share({ title: filename, url: written.uri });
      statusEl.textContent = '✅ PDF généré et prêt à partager/enregistrer.';
    } catch (e) {
      statusEl.textContent = '';
      errorEl.textContent = 'Erreur : ' + e.message;
    }
  });

  // Exposé pour la page Connexions unifiée (voir connexions.js) - seul point
  // d'entrée externe sur l'état interne autrement privé de cette IIFE.
  window.Cyrus = window.Cyrus || {};
  window.Cyrus.connections = { logoutWhatsApp: logoutWhatsApp, logoutTelegram: logoutTelegram };

  // Ecran par defaut.
  document.getElementById('screen-whatsapp').classList.add('active');
  startWhatsApp();
})();
