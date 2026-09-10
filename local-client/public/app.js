// Interface minimale du client local — pas de framework, quelques appels
// fetch() vers le serveur local (jamais directement vers le VPS, voir
// index.js/lib/*.js côté serveur pour ça).

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
  if (data.connected) {
    el.textContent = 'Connecté';
    el.className = 'connected';
    qrEl.innerHTML = '';
  } else if (data.qr) {
    el.textContent = 'En attente de scan du QR code (affiché dans le terminal du serveur)';
    el.className = 'disconnected';
  } else {
    el.textContent = 'Déconnecté';
    el.className = 'disconnected';
  }
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

// ---------- Campagnes ----------

async function createCampaign() {
  const name = document.getElementById('campName').value;
  const recipients = parseContactsInput(document.getElementById('campRecipients').value)
    .map((c) => ({ telephone: c.telephone, nom: c.nom }));
  const text = document.getElementById('campText').value;
  const delayMinMs = Number(document.getElementById('campDelayMin').value) * 1000;
  const delayMaxMs = Number(document.getElementById('campDelayMax').value) * 1000;

  const res = await fetch('/api/campaigns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, recipients, text, delayMinMs, delayMaxMs }),
  });
  const data = await res.json();
  document.getElementById('campResult').textContent = res.ok
    ? `Campagne créée (${data.results.length} destinataire(s)).`
    : ('Erreur : ' + data.error);
  refreshCampaigns();
}

async function campaignAction(id, action) {
  await fetch(`/api/campaigns/${id}/${action}`, { method: 'POST' });
  refreshCampaigns();
}

async function refreshCampaigns() {
  const res = await fetch('/api/campaigns');
  const list = await res.json();
  const el = document.getElementById('campaignsList');
  el.innerHTML = list.map((c) => {
    const sent = c.results.filter((r) => r.status === 'sent').length;
    const errors = c.results.filter((r) => r.status === 'error').length;
    const total = c.results.length;
    const actions = [];
    if (c.status === 'draft' || c.status === 'paused') actions.push(`<button onclick="campaignAction('${c.id}','start')">Démarrer</button>`);
    if (c.status === 'running') actions.push(`<button onclick="campaignAction('${c.id}','pause')">Pause</button>`);
    if (c.status !== 'completed' && c.status !== 'cancelled') actions.push(`<button onclick="campaignAction('${c.id}','cancel')">Annuler</button>`);
    return `<li>
      <strong>${c.name}</strong> — ${c.status} (${sent}/${total} envoyés, ${errors} erreur(s))
      <div>${actions.join(' ')}</div>
    </li>`;
  }).join('');
}

refreshStatus();
refreshContacts();
refreshCampaigns();
setInterval(refreshStatus, 3000);
setInterval(refreshCampaigns, 4000);
