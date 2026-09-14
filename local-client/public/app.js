// Interface minimale du client local — pas de framework, quelques appels
// fetch() vers le serveur local (jamais directement vers le VPS, voir
// index.js/lib/*.js côté serveur pour ça).

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showTab(name) {
  document.querySelectorAll('.tab').forEach((el) => el.classList.remove('active'));
  document.querySelectorAll('nav button').forEach((el) => el.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  document.getElementById('nav-' + name).classList.add('active');
}

async function refreshStatus() {
  const res = await fetch('/api/status');
  const data = await res.json();
  const el = document.getElementById('status');
  const qrEl = document.getElementById('qr');
  const connEl = document.getElementById('conn-wa-status');
  if (data.connected) {
    el.textContent = 'Connecté';
    el.className = 'connected';
    qrEl.innerHTML = '';
  } else if (data.qrImage) {
    // Image reelle (voir lib/whatsapp.js#getQRCodeImage) - avant cette
    // fonctionnalite, le QR n'existait qu'en ASCII dans le terminal du
    // SERVEUR (invisible pour quiconque ne regarde pas ce terminal precis) ;
    // regeneree a chaque appel, l'image suit automatiquement le
    // renouvellement du code (expire au bout de ~20-60s cote WhatsApp).
    el.textContent = 'Scannez ce QR code avec WhatsApp (Appareils liés → Lier un appareil)';
    el.className = 'disconnected';
    qrEl.innerHTML = `<img src="${data.qrImage}" width="280" height="280" alt="QR code WhatsApp">`;
  } else {
    el.textContent = 'Déconnecté';
    el.className = 'disconnected';
    qrEl.innerHTML = '';
  }
  // Miroir sur la page Connexions unifiée - source unique de vérité mise à
  // jour ici, pas de second appel /api/status séparé.
  if (connEl) { connEl.textContent = 'WhatsApp : ' + el.textContent; connEl.className = el.className; }
}

async function connLogoutWhatsapp() {
  await fetch('/api/whatsapp/logout', { method: 'POST' });
  refreshStatus();
}

// ---------- Telegram ----------

async function refreshTgStatus() {
  const res = await fetch('/api/telegram/status');
  const data = await res.json();
  const el = document.getElementById('tg-status');
  document.getElementById('tg-logout-btn').style.display = data.connected ? 'block' : 'none';

  if (!data.configured) {
    el.textContent = 'TELEGRAM_API_ID / TELEGRAM_API_HASH non configurés (voir .env).';
    el.className = 'disconnected';
  } else if (data.connected) {
    el.textContent = 'Connecté';
    el.className = 'connected';
    document.getElementById('tg-login-phone').style.display = 'none';
    document.getElementById('tg-login-code').style.display = 'none';
    document.getElementById('tg-login-password').style.display = 'none';
  } else {
    el.textContent = data.error ? ('Erreur : ' + data.error) : 'Non connecté';
    el.className = 'disconnected';
  }

  // Miroir sur la page Connexions unifiée, quel que soit le chemin ci-dessus.
  const connEl = document.getElementById('conn-tg-status');
  if (connEl) { connEl.textContent = 'Telegram : ' + el.textContent; connEl.className = el.className; }
}

async function connLogoutTelegram() {
  await fetch('/api/telegram/logout', { method: 'POST' });
  refreshTgStatus();
}

// ---------- Historique (page Connexions) ----------
async function refreshHistory() {
  const res = await fetch('/api/history');
  const entries = await res.json();
  const el = document.getElementById('historyList');
  if (entries.length === 0) { el.innerHTML = '<li>Aucun envoi tracé pour l\'instant.</li>'; return; }
  el.innerHTML = entries.map((e) => {
    const label = e.channel === 'telegram' ? 'Telegram' : 'WhatsApp';
    return `<li><strong>[${label}]</strong> ${escapeHtml(e.identifier)} — <small>${escapeHtml(e.sentAt)}</small><br>${escapeHtml((e.body || '').slice(0, 120))}</li>`;
  }).join('');
}

function tgShowStep(step) {
  document.getElementById('tg-login-phone').style.display = step === 'pending' || !step ? 'block' : 'none';
  document.getElementById('tg-login-code').style.display = step === 'code_required' ? 'block' : 'none';
  document.getElementById('tg-login-password').style.display = step === 'password_required' ? 'block' : 'none';
  if (step === 'connected') refreshTgStatus();
  if (step === 'error') document.getElementById('tg-login-result').textContent = 'Échec de connexion — réessayez.';
}

async function tgStartLogin() {
  const phone = document.getElementById('tg-phone').value.trim();
  const res = await fetch('/api/telegram/login/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }),
  });
  const data = await res.json();
  if (!res.ok) { document.getElementById('tg-login-result').textContent = 'Erreur : ' + data.error; return; }
  tgShowStep(data.step);
}

async function tgSubmitCode() {
  const code = document.getElementById('tg-code').value.trim();
  const res = await fetch('/api/telegram/login/code', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
  });
  const data = await res.json();
  if (!res.ok) { document.getElementById('tg-login-result').textContent = 'Erreur : ' + data.error; return; }
  tgShowStep(data.step);
}

async function tgSubmitPassword() {
  const password = document.getElementById('tg-password').value;
  const res = await fetch('/api/telegram/login/password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  });
  const data = await res.json();
  if (!res.ok) { document.getElementById('tg-login-result').textContent = 'Erreur : ' + data.error; return; }
  tgShowStep(data.step);
}

async function tgLogout() {
  await fetch('/api/telegram/logout', { method: 'POST' });
  refreshTgStatus();
}

async function sendTgTestMessage() {
  const to = document.getElementById('tg-to').value;
  const text = document.getElementById('tg-text').value;
  const res = await fetch('/api/telegram/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, text }),
  });
  const data = await res.json();
  document.getElementById('tg-sendResult').textContent = res.ok ? 'Envoyé.' : ('Erreur : ' + data.error);
}

async function sendTestMessage() {
  const to = document.getElementById('to').value;
  const text = document.getElementById('text').value;
  const res = await fetch('/api/whatsapp/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, text }),
  });
  const data = await res.json();
  document.getElementById('sendResult').textContent = res.ok ? 'Envoyé.' : ('Erreur : ' + data.error);
}

// ---------- Contacts ----------

function parseContactsInput(raw) {
  // Une ligne par contact : "numero" ou "numero,nom".
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [telephone, nom] = line.split(',').map((s) => (s || '').trim());
      return { telephone, nom: nom || null };
    });
}

async function importContacts() {
  const raw = document.getElementById('contactsInput').value;
  const contacts = parseContactsInput(raw);
  const res = await fetch('/api/contacts/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contacts }),
  });
  const data = await res.json();
  document.getElementById('importResult').textContent = `${data.imported} contact(s) importé(s).`;
  refreshContacts();
}

async function refreshContacts() {
  const res = await fetch('/api/contacts');
  const contacts = await res.json();
  const list = document.getElementById('contactsList');
  list.innerHTML = contacts.map((c) => `<li>${c.nom || '(sans nom)'} — ${c.telephone || c.jid}</li>`).join('');
}

// ---------- Extraction de groupes (WhatsApp ou Telegram, voir /api/<canal>/groups) ----------

function slugify(s) {
  return String(s || 'groupe').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'groupe';
}

// Construction imperative (pas de template literal + onclick interpolé) : un
// nom de groupe WhatsApp/Telegram est une donnée EXTERNE non fiable (peut
// contenir guillemets/HTML) - la construire via createElement/textContent
// évite toute injection, contrairement à un innerHTML avec onclick="...(...)"
// interpolé.
async function listGroups() {
  const channel = document.getElementById('campChannel').value;
  const res = await fetch(`/api/${channel}/groups`);
  const el = document.getElementById('groupsList');
  el.innerHTML = '';
  if (!res.ok) { el.innerHTML = '<li>Échec du chargement des groupes.</li>'; return; }
  const groups = await res.json();
  if (groups.length === 0) { el.innerHTML = '<li>Aucun groupe trouvé.</li>'; return; }

  groups.forEach((g) => {
    const li = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = g.name || g.id;
    const row = document.createElement('div');
    row.className = 'row';

    const importBtn = document.createElement('button');
    importBtn.textContent = 'Importer comme destinataires';
    importBtn.addEventListener('click', () => importGroupMembers(channel, g.id));

    const exportBtn = document.createElement('button');
    exportBtn.textContent = 'Exporter (Excel)';
    exportBtn.addEventListener('click', () => exportGroupMembers(channel, g.id, g.name || g.id));

    row.appendChild(importBtn);
    row.appendChild(exportBtn);

    // Diffusion directe dans le groupe/canal lui-même (un seul message pour
    // tout le groupe), à distinguer de "Importer comme destinataires"
    // ci-dessus (extrait chaque MEMBRE comme destinataire individuel).
    if (channel === 'telegram') {
      const broadcastBtn = document.createElement('button');
      broadcastBtn.textContent = '📣 Diffuser dans ce groupe';
      broadcastBtn.addEventListener('click', () => {
        const textarea = document.getElementById('campRecipients');
        const line = g.id + (g.name ? ',' + g.name : '');
        textarea.value = textarea.value ? textarea.value + '\n' + line : line;
        document.getElementById('campResult').textContent = 'Groupe ajouté aux destinataires — un seul envoi touchera tout le groupe.';
      });
      row.appendChild(broadcastBtn);
    }
    li.appendChild(title);
    li.appendChild(row);
    el.appendChild(li);
  });
}

async function fetchGroupMembers(channel, groupId) {
  const res = await fetch(`/api/${channel}/groups/${encodeURIComponent(groupId)}/members`);
  if (!res.ok) throw new Error((await res.json()).error || 'Échec.');
  return res.json();
}

async function importGroupMembers(channel, groupId) {
  try {
    const members = await fetchGroupMembers(channel, groupId);
    const lines = members.map((m) => (channel === 'telegram' ? (m.username ? '@' + m.username : m.phone) : m.id.replace('@c.us', '')));
    const textarea = document.getElementById('campRecipients');
    textarea.value = (textarea.value ? textarea.value + '\n' : '') + lines.filter(Boolean).join('\n');
    alert(members.length + ' membre(s) ajouté(s) à la liste de destinataires.');
  } catch (err) {
    alert('Échec : ' + err.message);
  }
}

async function exportGroupMembers(channel, groupId, groupName) {
  try {
    const members = await fetchGroupMembers(channel, groupId);
    const rows = channel === 'telegram'
      ? members.map((m) => ({ identifiant: m.username ? '@' + m.username : m.phone, nom: (m.firstName + ' ' + m.lastName).trim() }))
      : members.map((m) => ({ identifiant: m.id.replace('@c.us', ''), admin: m.isAdmin ? 'oui' : 'non' }));
    const sheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Membres');
    XLSX.writeFile(workbook, `membres-${slugify(groupName)}.xlsx`);
  } catch (err) {
    alert('Échec de l\'export : ' + err.message);
  }
}

// ---------- Campagnes ----------

// Lit le fichier choisi en base64 (sans le préfixe "data:...;base64,") -
// c'est ce que lib/campaigns.js attend (media.base64) pour le repasser tel
// quel à Buffer.from(..., 'base64') côté serveur.
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

document.getElementById('campMediaInput').addEventListener('change', () => {
  const file = document.getElementById('campMediaInput').files[0];
  const preview = document.getElementById('campMediaPreview');
  if (!file) { preview.style.display = 'none'; preview.textContent = ''; return; }
  preview.style.display = 'block';
  preview.textContent = '📎 ' + file.name + ' (' + Math.round(file.size / 1024) + ' Ko)';
});

async function createCampaign() {
  const name = document.getElementById('campName').value;
  const channel = document.getElementById('campChannel').value;
  const recipients = parseContactsInput(document.getElementById('campRecipients').value)
    .map((c) => ({ telephone: c.telephone, nom: c.nom }));
  const text = document.getElementById('campText').value;
  const delayMinMs = Number(document.getElementById('campDelayMin').value) * 1000;
  const delayMaxMs = Number(document.getElementById('campDelayMax').value) * 1000;
  const batchSize = Number(document.getElementById('campBatchSize').value) || null;
  const batchPauseMs = Number(document.getElementById('campBatchPause').value) * 1000 || null;

  const mediaFile = document.getElementById('campMediaInput').files[0];
  let media = null;
  if (mediaFile) {
    media = { base64: await readFileAsBase64(mediaFile), mimetype: mediaFile.type, filename: mediaFile.name };
  }

  const res = await fetch('/api/campaigns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, recipients, text, delayMinMs, delayMaxMs, channel, media, batchSize, batchPauseMs }),
  });
  const data = await res.json();
  document.getElementById('campResult').textContent = res.ok
    ? `Campagne créée (${data.results.length} destinataire(s))` + (data.blockedCount ? ` — ${data.blockedCount} exclu(s), liste noire.` : '.')
    : ('Erreur : ' + data.error);
  if (res.ok) {
    document.getElementById('campMediaInput').value = '';
    document.getElementById('campMediaPreview').style.display = 'none';
  }
  refreshCampaigns();
}

async function campaignAction(id, action) {
  await fetch(`/api/campaigns/${id}/${action}`, { method: 'POST' });
  refreshCampaigns();
}

let lastCampaignsList = [];

async function refreshCampaigns() {
  const res = await fetch('/api/campaigns');
  const list = await res.json();
  lastCampaignsList = list;
  const el = document.getElementById('campaignsList');
  el.innerHTML = list.map((c) => {
    const sent = c.results.filter((r) => r.status === 'sent').length;
    const errors = c.results.filter((r) => r.status === 'error').length;
    const total = c.results.length;
    const actions = [];
    if (c.status === 'draft' || c.status === 'paused') actions.push(`<button onclick="campaignAction('${c.id}','start')">Démarrer</button>`);
    if (c.status === 'running') actions.push(`<button onclick="campaignAction('${c.id}','pause')">Pause</button>`);
    if (c.status !== 'completed' && c.status !== 'cancelled') actions.push(`<button onclick="campaignAction('${c.id}','cancel')">Annuler</button>`);
    const channelLabel = (c.config && c.config.channel === 'telegram') ? 'Telegram' : 'WhatsApp';
    const statusLabels = { draft: 'brouillon', running: 'en cours', paused: 'en pause', queued: '⏳ en file d\'attente', completed: 'terminée', cancelled: 'annulée', error: 'erreur' };
    actions.push(`<button onclick="toggleReport('${c.id}')">📊 Rapport</button>`);
    return `<li>
      <strong>${c.name}</strong> [${channelLabel}] — ${statusLabels[c.status] || c.status} (${sent}/${total} envoyés, ${errors} erreur(s))
      <div>${actions.join(' ')}</div>
      <div id="report-${c.id}" style="display:none; margin-top:8px;"></div>
    </li>`;
  }).join('');
}

// Rapport final de campagne (équivalent de la fenêtre modale de
// dashboard.html) : décompte par statut + liste des échecs avec leur cause -
// entièrement calculé côté client à partir des données déjà chargées par
// refreshCampaigns(), aucune route serveur dédiée nécessaire.
function toggleReport(id) {
  const el = document.getElementById('report-' + id);
  if (!el) return;
  if (el.style.display === 'block') { el.style.display = 'none'; return; }
  const c = lastCampaignsList.find((x) => x.id === id);
  if (!c) return;
  const pending = c.results.filter((r) => r.status === 'pending').length;
  const sent = c.results.filter((r) => r.status === 'sent').length;
  const errors = c.results.filter((r) => r.status === 'error');
  const rows = errors.map((r) => `<li>${escapeHtml(r.to)} — ${escapeHtml(r.error || 'échec')}</li>`).join('');
  el.innerHTML = `
    <div style="border:1px solid #e0e0e0; border-radius:8px; padding:10px; background:#fafafa;">
      <div><b>${sent}</b> envoyé(s) · <b>${errors.length}</b> échec(s) · <b>${pending}</b> en attente</div>
      ${errors.length ? '<ul style="margin-top:6px;">' + rows + '</ul>' : ''}
    </div>`;
  el.style.display = 'block';
}

// ---------- Liste noire ----------
async function refreshBlocklist() {
  const channel = document.getElementById('blocklistChannel').value;
  const res = await fetch(`/api/blocklist?channel=${channel}`);
  const list = await res.json();
  const el = document.getElementById('blocklistList');
  el.innerHTML = '';
  if (list.length === 0) { el.innerHTML = '<li>Aucun contact bloqué pour ce canal.</li>'; return; }
  list.forEach((b) => {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = b.identifier;
    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Retirer';
    removeBtn.addEventListener('click', () => removeFromBlocklistUi(channel, b.identifier));
    li.appendChild(label);
    li.appendChild(removeBtn);
    el.appendChild(li);
  });
}

async function addToBlocklistUi() {
  const channel = document.getElementById('blocklistChannel').value;
  const input = document.getElementById('blocklistAddInput');
  const raw = input.value.trim();
  if (!raw) return;
  const identifier = raw.startsWith('@') ? raw : raw.replace(/\D/g, '');
  if (!identifier) return;
  await fetch('/api/blocklist', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, identifier }),
  });
  input.value = '';
  refreshBlocklist();
}

async function removeFromBlocklistUi(channel, identifier) {
  await fetch('/api/blocklist', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, identifier }),
  });
  refreshBlocklist();
}

refreshStatus();
refreshTgStatus();
refreshContacts();
refreshCampaigns();
refreshBlocklist();
refreshHistory();
setInterval(refreshStatus, 3000);
setInterval(refreshTgStatus, 3000);
setInterval(refreshCampaigns, 4000);
