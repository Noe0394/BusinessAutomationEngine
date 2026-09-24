// Logique de l'app CYRUS SUPER ASSISTANT (webapp Capacitor). Pas de
// framework/bundler ici : DOM standard + le plugin natif EmbeddedWebView
// (voir android/.../EmbeddedWebViewPlugin.java) expose automatiquement sur
// window.Capacitor.Plugins par le runtime Capacitor.
(function () {
  const EmbeddedWebView = window.Capacitor.Plugins.EmbeddedWebView;
  const DESKTOP_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
  const CLOUDFLARE_BASE = 'https://cyrus-license.ezechielatannidje.workers.dev';

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

  document.getElementById('schedule-open-wa').addEventListener('click', () => {
    document.querySelector('.nav button[data-screen="whatsapp"]').click();
  });
  document.getElementById('schedule-open-tg').addEventListener('click', () => {
    document.querySelector('.nav button[data-screen="telegram"]').click();
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
    refreshSchedulerReadiness();
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

  function refreshSchedulerReadiness() {
    const wa = document.getElementById('schedule-wa-status');
    const tg = document.getElementById('schedule-tg-status');
    if (wa) wa.textContent = 'WhatsApp : ' + (!waStarted ? 'pas encore ouvert' : !waBridgeReady ? 'initialisation du pont…' : waConnected ? 'connecté et prêt' : 'ouvert, connexion à terminer');
    if (tg) tg.textContent = 'Telegram : ' + (!tgStarted ? 'pas encore ouvert' : !tgBridgeReady ? 'initialisation du pont…' : tgConnected ? 'connecté et prêt' : 'ouvert, connexion à terminer');
  }
  window.CyrusMobileSessions = {
    isReady(channel) { return channel === 'whatsapp' ? !!(waConnected && waBridgeReady) : channel === 'telegram' ? !!(tgConnected && tgBridgeReady) : false; },
  };
  refreshSchedulerReadiness();

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
    refreshSchedulerReadiness();
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
          refreshSchedulerReadiness();
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
        case 'community-operation-result':
          if (window.CyrusParity) window.CyrusParity.handleCommunityOperation(data.payload);
          break;
        case 'scheduled-send-result':
          if (window.CyrusParity) window.CyrusParity.handleScheduledSendResult(data.payload).catch(err => console.warn('Planning mobile :', err.message));
          break;
        case 'bridge-error':
          document.getElementById('mobile-groups-feedback').textContent = 'WhatsApp : ' + (data.payload.message || 'opération impossible');
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
          refreshSchedulerReadiness();
          break;
        case 'groups':
          if (window.CyrusParity) window.CyrusParity.renderGroups('TELEGRAM', data.payload.groups || []);
          break;
        case 'community-search-results':
          if (window.CyrusParity) window.CyrusParity.handleCommunitySearch(data.payload).catch(err => { document.getElementById('mobile-community-discovery-feedback').textContent = 'Impossible d’enregistrer les résultats : ' + err.message; });
          break;
        case 'community-operation-result':
          if (window.CyrusParity) window.CyrusParity.handleCommunityOperation(data.payload);
          break;
        case 'scheduled-send-result':
          if (window.CyrusParity) window.CyrusParity.handleScheduledSendResult(data.payload).catch(err => console.warn('Planning mobile :', err.message));
          break;
        case 'community-people-results':
          if (window.CyrusParity) window.CyrusParity.handleCommunityPeopleSearch(data.payload).catch(err => {
            document.getElementById('mobile-people-discover').disabled = false;
            document.getElementById('mobile-people-feedback').textContent = 'Impossible d’enregistrer les résultats : ' + err.message;
          });
          break;
        case 'message':
          tgMessages.push(data.payload);
          if (tgMessages.length > 200) tgMessages.shift();
          if (window.CyrusBusinessServices) window.CyrusBusinessServices.handleIncomingTG(data.payload).catch(err => console.warn('Réponse automatique Telegram mobile :', err.message));
          break;
        case 'group-members':
          if (window.CyrusParity) window.CyrusParity.renderMembers('TELEGRAM', data.payload);
          break;
        case 'bridge-error':
          if (String(data.payload.where || '').startsWith('discoverPeople')) {
            document.getElementById('mobile-people-discover').disabled = false;
            document.getElementById('mobile-people-feedback').textContent = 'Recherche Telegram impossible : ' + (data.payload.message || 'opération impossible');
          } else if (String(data.payload.where || '').startsWith('discoverCommunities')) {
            document.getElementById('mobile-community-discovery-feedback').textContent = 'Recherche Telegram impossible : ' + (data.payload.message || 'opération impossible');
            document.getElementById('mobile-community-discover').disabled = false;
          } else document.getElementById('mobile-groups-feedback').textContent = 'Telegram : ' + (data.payload.message || 'opération impossible');
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
    const res = await fetch(CLOUDFLARE_BASE + '/verifyLicenseOffline', {
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

  // Client IA partage par les modules mobiles. Les clés fournisseur restent
  // dans le Worker Cloudflare ; seul le jeton de licence déjà utilisé par
  // l'écran IA est transmis depuis l'appareil.
  window.Cyrus = window.Cyrus || {};
  window.Cyrus.ai = {
    async generateText(prompt) {
      const res = await fetch(CLOUDFLARE_BASE + '/generateTextFallback', {
        method: 'POST', headers: aiHeaders(), body: JSON.stringify({ prompt: String(prompt || '') }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      if (!data.text || typeof data.text !== 'string') throw new Error('Le fournisseur IA n’a renvoyé aucun texte.');
      return { text: data.text, provider: data.provider || 'Cloudflare' };
    },
    async transcribeAudio(file) {
      if (!file || !file.size || file.size > 10 * 1024 * 1024) throw new Error('Choisis un fichier audio de 10 Mo maximum.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      const res = await fetch(CLOUDFLARE_BASE + '/ai/transcribe', { method: 'POST', headers: aiHeaders(), body: JSON.stringify({ base64: btoa(binary), mimeType: file.type || 'audio/ogg', filename: file.name || 'voice-note.ogg' }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.error || ('HTTP ' + res.status)), { status: res.status });
      if (!data.text) throw new Error('Le fournisseur vocal n’a renvoyé aucun texte.');
      return { text: data.text, language: data.language || null, provider: data.provider || 'Cloudflare' };
    },
  };
  window.Cyrus.cloudflareRequest = async function (route, body) {
    const res = await fetch(CLOUDFLARE_BASE + route, { method: 'POST', headers: aiHeaders(), body: JSON.stringify(body || {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || ('HTTP ' + res.status)), { status: res.status });
    return data;
  };

  document.getElementById('ai-text-btn').addEventListener('click', async () => {
    const rawPrompt = document.getElementById('ai-prompt').value.trim();
    const prompt = window.CyrusBusinessServices ? await window.CyrusBusinessServices.promptContext(rawPrompt) : rawPrompt;
    const errorEl = document.getElementById('ai-error');
    const resultEl = document.getElementById('ai-result');
    if (!prompt) return;
    errorEl.textContent = '';
    try {
      const res = await fetch(CLOUDFLARE_BASE + '/generateTextFallback', {
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
      const res = await fetch(CLOUDFLARE_BASE + '/generateImageFallback', {
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

  // ---------- Ebook : texte Cloudflare, PDF rendu sur l'appareil ----------
  // Le Worker ne transporte aucun binaire ebook. Les chapitres passent par
  // la cascade texte sous licence; canvas et un petit assembleur PDF local
  // produisent ensuite le fichier A4 sans Firebase ni serveur PDF.
  function loadEbookImage(file) {
    if (!file) return Promise.resolve(null);
    if (!file.type.startsWith('image/') || file.size > 6 * 1024 * 1024) return Promise.reject(new Error('Chaque image de couverture/logo doit être une image de 6 Mo maximum.'));
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file); const image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image de couverture/logo illisible.')); };
      image.src = url;
    });
  }
  function ebookCanvas() {
    const canvas = document.createElement('canvas'); canvas.width = 850; canvas.height = 1200;
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    return { canvas, context };
  }
  function ebookWrap(context, paragraph, maxWidth) {
    const words = String(paragraph || '').split(/\s+/).filter(Boolean); const lines = []; let line = '';
    words.forEach(word => {
      const next = line ? line + ' ' + word : word;
      if (line && context.measureText(next).width > maxWidth) { lines.push(line); line = word; } else line = next;
    });
    if (line) lines.push(line); return lines;
  }
  function ebookPdf(pages) {
    const encoder = new TextEncoder();
    const join = parts => { const size = parts.reduce((sum, part) => sum + part.length, 0); const out = new Uint8Array(size); let offset = 0; parts.forEach(part => { out.set(part, offset); offset += part.length; }); return out; };
    const ascii = text => encoder.encode(text);
    const objects = new Map(); const pageIds = pages.map((_, index) => 3 + index * 3);
    objects.set(1, ascii('<< /Type /Catalog /Pages 2 0 R >>'));
    objects.set(2, ascii('<< /Type /Pages /Kids [' + pageIds.map(id => id + ' 0 R').join(' ') + '] /Count ' + pageIds.length + ' >>'));
    pages.forEach((page, index) => {
      const pageId = pageIds[index]; const imageId = pageId + 1; const contentId = pageId + 2;
      const dataUrl = page.toDataURL('image/jpeg', 0.86); const raw = atob(dataUrl.split(',')[1]);
      const jpeg = Uint8Array.from(raw, char => char.charCodeAt(0));
      const content = ascii('q 595 0 0 842 0 0 cm /Im0 Do Q');
      objects.set(pageId, ascii('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 ' + imageId + ' 0 R >> >> /Contents ' + contentId + ' 0 R >>'));
      objects.set(imageId, join([ascii('<< /Type /XObject /Subtype /Image /Width ' + page.width + ' /Height ' + page.height + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpeg.length + ' >>\nstream\n'), jpeg, ascii('\nendstream')]));
      objects.set(contentId, join([ascii('<< /Length ' + content.length + ' >>\nstream\n'), content, ascii('\nendstream')]));
    });
    const maxId = Math.max(...objects.keys()); const chunks = [ascii('%PDF-1.4\n%Cyrus local PDF\n')]; const offsets = [0]; let length = chunks[0].length;
    for (let id = 1; id <= maxId; id++) { offsets[id] = length; const part = join([ascii(id + ' 0 obj\n'), objects.get(id), ascii('\nendobj\n')]); chunks.push(part); length += part.length; }
    const xrefOffset = length; let xref = 'xref\n0 ' + (maxId + 1) + '\n0000000000 65535 f \n';
    for (let id = 1; id <= maxId; id++) xref += String(offsets[id]).padStart(10, '0') + ' 00000 n \n';
    chunks.push(ascii(xref + 'trailer\n<< /Size ' + (maxId + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefOffset + '\n%%EOF'));
    return join(chunks);
  }
  function ebookPdfBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
    return btoa(binary);
  }
  async function renderEbookPdf(book, cover, logo, statusEl) {
    const pages = []; const W = 850; const H = 1200; const margin = 90; const watermark = book.watermarkText;
    const addCover = () => {
      const { canvas, context } = ebookCanvas();
      if (cover) { const scale = Math.max(W / cover.width, H / cover.height); const width = cover.width * scale; const height = cover.height * scale; context.drawImage(cover, (W - width) / 2, (H - height) / 2, width, height); context.fillStyle = 'rgba(255,255,255,.84)'; context.fillRect(0, 0, W, H); }
      context.fillStyle = '#15223b'; context.textAlign = 'center'; context.font = 'bold 52px Arial';
      ebookWrap(context, book.title, W - margin * 2).slice(0, 3).forEach((line, index) => context.fillText(line, W / 2, 340 + index * 66));
      if (book.subtitle) { context.fillStyle = '#5c6780'; context.font = '30px Arial'; ebookWrap(context, book.subtitle, W - margin * 2).slice(0, 3).forEach((line, index) => context.fillText(line, W / 2, 570 + index * 42)); }
      context.fillStyle = '#6c4fd6'; context.fillRect(300, 720, 250, 5);
      context.fillStyle = '#374151'; context.font = '28px Arial';
      if (book.author) context.fillText(book.author, W / 2, 805);
      if (book.date) context.fillText(book.date, W / 2, 855);
      if (logo) { const scale = Math.min(150 / logo.width, 110 / logo.height); context.drawImage(logo, W / 2 - logo.width * scale / 2, 930, logo.width * scale, logo.height * scale); }
      if (watermark) { context.save(); context.globalAlpha = .24; context.font = '20px Arial'; context.fillStyle = '#333'; context.fillText(watermark.slice(0, 100), W / 2, 1135); context.restore(); }
      pages.push(canvas);
    };
    function createContentPage(heading) {
      const { canvas, context } = ebookCanvas(); context.fillStyle = '#6c4fd6'; context.fillRect(0, 0, W, 18);
      context.textAlign = 'left'; context.fillStyle = '#526079'; context.font = '20px Arial'; context.fillText(book.title.slice(0, 70), margin, 70);
      context.fillStyle = '#1f2937'; context.font = 'bold 36px Arial';
      const headingLines = ebookWrap(context, heading, W - margin * 2); let y = 145;
      headingLines.slice(0, 3).forEach(line => { context.fillText(line, margin, y); y += 46; });
      context.fillStyle = '#6c4fd6'; context.fillRect(margin, y + 5, 100, 4); y += 55;
      if (watermark) { context.save(); context.globalAlpha = .14; context.fillStyle = '#444'; context.font = '18px Arial'; context.textAlign = 'right'; context.fillText(watermark.slice(0, 80), W - margin, H - 48); context.restore(); }
      pages.push(canvas); return { canvas, context, y };
    }
    function addSection(heading, text) {
      const paragraphs = String(text || '').split(/\n{2,}/).map(value => value.trim()).filter(Boolean);
      let page = createContentPage(heading); const maxWidth = W - margin * 2;
      paragraphs.forEach(paragraph => {
        page.context.font = '25px Arial'; page.context.fillStyle = '#252c38'; page.context.textAlign = 'left';
        const lines = ebookWrap(page.context, paragraph.replace(/\n/g, ' '), maxWidth);
        lines.forEach(line => {
          if (page.y > H - 105) page = createContentPage(heading + ' · suite');
          page.context.font = '25px Arial'; page.context.fillStyle = '#252c38'; page.context.fillText(line, margin, page.y); page.y += 38;
        });
        page.y += 22;
      });
    }
    addCover();
    if (book.introduction) addSection('Introduction', book.introduction);
    for (let index = 0; index < book.chapters.length; index++) {
      statusEl.textContent = 'Mise en page du chapitre ' + (index + 1) + '/' + book.chapters.length + '…';
      addSection('Chapitre ' + (index + 1) + ' · ' + book.chapters[index].topic, book.chapters[index].text);
    }
    if (book.conclusion) addSection('Conclusion', book.conclusion);
    pages.forEach((canvas, index) => {
      if (index === 0) return;
      const context = canvas.getContext('2d'); context.textAlign = 'center'; context.fillStyle = '#64748b'; context.font = '18px Arial';
      context.fillText(String(index), W / 2, H - 32);
    });
    return ebookPdf(pages);
  }

  document.getElementById('ebook-generate-btn').addEventListener('click', async () => {
    const title = document.getElementById('ebook-title').value.trim() || 'Livre CYRUS';
    const subtitle = document.getElementById('ebook-subtitle').value.trim(); const author = document.getElementById('ebook-author').value.trim();
    const date = document.getElementById('ebook-date').value.trim() || new Date().toLocaleDateString();
    const watermarkText = document.getElementById('ebook-watermark').value.trim(); const introduction = document.getElementById('ebook-intro').value.trim();
    const conclusion = document.getElementById('ebook-conclusion').value.trim();
    const topics = document.getElementById('ebook-topics').value.split('\n').map(value => value.trim()).filter(Boolean);
    const errorEl = document.getElementById('ebook-error'); const statusEl = document.getElementById('ebook-status'); const button = document.getElementById('ebook-generate-btn');
    errorEl.textContent = ''; statusEl.textContent = '';
    if (!topics.length || topics.length > 12) { errorEl.textContent = 'Indique de 1 à 12 sujets de chapitre.'; return; }
    if (!window.Cyrus.ai || typeof window.Cyrus.ai.generateText !== 'function') { errorEl.textContent = 'La cascade IA Cloudflare n’est pas disponible.'; return; }
    button.disabled = true;
    try {
      const chapters = [];
      for (let index = 0; index < topics.length; index++) {
        statusEl.textContent = 'Rédaction du chapitre ' + (index + 1) + '/' + topics.length + '…';
        const rawPrompt = 'Rédige en français un chapitre pratique et structuré pour un ebook.\nTitre du livre : ' + title.slice(0, 160) + '\nSujet : ' + topics[index].slice(0, 240) + '\nAuteur : ' + author.slice(0, 100) + '\nÉcris environ 700 à 1000 mots, avec un titre, des paragraphes clairs et des conseils concrets. N’invente pas de données, de résultats garantis ni de citations. Réponds uniquement avec le texte du chapitre.';
        const prompt = window.CyrusBusinessServices ? await window.CyrusBusinessServices.promptContext(rawPrompt) : rawPrompt;
        const result = await window.Cyrus.ai.generateText(prompt);
        chapters.push({ topic: topics[index], text: String(result.text || '').trim() });
        if (!chapters[index].text) throw new Error('La cascade IA n’a pas rédigé le chapitre « ' + topics[index] + ' ».');
      }
      statusEl.textContent = 'Création des pages PDF sur cet appareil…';
      const cover = await loadEbookImage(document.getElementById('ebook-cover-file').files[0]);
      const logo = await loadEbookImage(document.getElementById('ebook-logo-file').files[0]);
      const bytes = await renderEbookPdf({ title, subtitle, author, date, watermarkText, introduction, conclusion, chapters }, cover, logo, statusEl);
      const filename = (title || 'livre').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'livre';
      const Filesystem = window.Capacitor.Plugins.Filesystem; const Share = window.Capacitor.Plugins.Share;
      const written = await Filesystem.writeFile({ path: filename + '.pdf', data: ebookPdfBase64(bytes), directory: 'DOCUMENTS' });
      await Share.share({ title: filename + '.pdf', url: written.uri }); statusEl.textContent = '✅ PDF créé localement et prêt à partager/enregistrer.';
    } catch (error) { statusEl.textContent = ''; errorEl.textContent = 'Erreur : ' + String(error && error.message || error); }
    finally { button.disabled = false; }
  });

  // Exposé pour la page Connexions unifiée (voir connexions.js) - seul point
  // d'entrée externe sur l'état interne autrement privé de cette IIFE.
  window.Cyrus = window.Cyrus || {};
  window.Cyrus.connections = { logoutWhatsApp: logoutWhatsApp, logoutTelegram: logoutTelegram };

  // Ecran par defaut.
  document.getElementById('screen-whatsapp').classList.add('active');
  startWhatsApp();
})();
