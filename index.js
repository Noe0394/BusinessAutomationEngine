const crypto = require('crypto');
if (!globalThis.crypto) {
  globalThis.crypto = crypto.webcrypto || crypto;
}

const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const QRCode = require('qrcode');
const whatsapp = require('./adapters/whatsapp');

const app = express();
const PORT = process.env.PORT || 10000;
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());

function replaceVariables(template, row) {
  return String(template).replace(/{(\w+)}/g, (match, key) => (
    row[key] !== undefined && row[key] !== null ? String(row[key]) : match
  ));
}

function normalizeJid(telephone) {
  const raw = String(telephone).trim();
  if (raw.includes('@')) {
    return raw;
  }
  const digits = raw.replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
}

function randomDelay(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCampaign(contacts, minDelayMs, maxDelayMs) {
  for (let i = 0; i < contacts.length; i += 1) {
    const row = contacts[i];

    if (!row.telephone || !row.message) {
      console.warn(`Campagne: ligne ${i + 1} ignorée (champs "telephone" et "message" requis).`);
      continue;
    }

    const to = normalizeJid(row.telephone);
    const text = replaceVariables(row.message, row);

    try {
      await whatsapp.sendMessage(to, text);
      console.log(`Campagne: message envoyé à ${to} (${i + 1}/${contacts.length}).`);
    } catch (err) {
      console.error(`Campagne: échec de l'envoi à ${to}:`, err);
    }

    if (i < contacts.length - 1) {
      const delay = randomDelay(minDelayMs, maxDelayMs);
      console.log(`Campagne: attente de ${Math.round(delay / 1000)}s avant le prochain envoi...`);
      await sleep(delay);
    }
  }

  console.log('Campagne: terminée.');
}

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/qr', async (req, res) => {
  const qr = whatsapp.getQRCode();

  if (!qr) {
    return res.status(200).send(`
      <html>
        <head><title>QR Code WhatsApp</title><meta http-equiv="refresh" content="5"></head>
        <body style="font-family: sans-serif; text-align: center; margin-top: 4rem;">
          <h1>Aucun QR code disponible</h1>
          <p>Soit l'appareil est déjà connecté, soit le QR code n'a pas encore été généré. Cette page se rafraîchit automatiquement.</p>
        </body>
      </html>
    `);
  }

  try {
    const qrImage = await QRCode.toDataURL(qr);
    res.status(200).send(`
      <html>
        <head><title>QR Code WhatsApp</title><meta http-equiv="refresh" content="20"></head>
        <body style="font-family: sans-serif; text-align: center; margin-top: 4rem;">
          <h1>Scannez ce QR code avec WhatsApp</h1>
          <img src="${qrImage}" alt="QR Code WhatsApp" style="width: 300px; height: 300px;" />
          <p>Cette page se rafraîchit automatiquement toutes les 20 secondes.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('Erreur lors de la génération du QR code:', err);
    res.status(500).json({ error: 'Échec de la génération du QR code.' });
  }
});

app.get('/dashboard', (req, res) => {
  res.status(200).send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Groupes WhatsApp</title>
  <style>
    body { font-family: sans-serif; margin: 2rem; color: #222; }
    table { border-collapse: collapse; width: 100%; max-width: 800px; }
    th, td { border: 1px solid #ccc; padding: 0.5rem 0.75rem; text-align: left; }
    th { background: #f5f5f5; }
    button { cursor: pointer; padding: 0.3rem 0.6rem; }
    #participants { margin-top: 2rem; max-width: 800px; }
    #participants-list { list-style: none; padding: 0; }
    #participants-list li { padding: 0.4rem 0.6rem; border-bottom: 1px solid #eee; }
    .empty { color: #777; }
  </style>
</head>
<body>
  <h1>Groupes WhatsApp</h1>
  <table>
    <thead>
      <tr><th>Nom du groupe</th><th>ID du groupe</th><th>Action</th></tr>
    </thead>
    <tbody id="groups-body">
      <tr><td colspan="3" class="empty">Chargement...</td></tr>
    </tbody>
  </table>

  <div id="participants">
    <h2 id="participants-title"></h2>
    <ul id="participants-list"></ul>
  </div>

  <script>
    async function loadGroups() {
      const tbody = document.getElementById('groups-body');
      try {
        const res = await fetch('/api/groups');
        const groups = await res.json();

        tbody.innerHTML = '';

        if (!Array.isArray(groups) || groups.length === 0) {
          const tr = document.createElement('tr');
          const td = document.createElement('td');
          td.colSpan = 3;
          td.className = 'empty';
          td.textContent = 'Aucun groupe trouvé.';
          tr.appendChild(td);
          tbody.appendChild(tr);
          return;
        }

        groups.forEach((group) => {
          const tr = document.createElement('tr');

          const nameTd = document.createElement('td');
          nameTd.textContent = group.subject || '(sans nom)';

          const idTd = document.createElement('td');
          idTd.textContent = group.id;

          const actionTd = document.createElement('td');
          const btn = document.createElement('button');
          btn.textContent = 'Voir les participants';
          btn.addEventListener('click', () => loadParticipants(group.id, group.subject));
          actionTd.appendChild(btn);

          tr.appendChild(nameTd);
          tr.appendChild(idTd);
          tr.appendChild(actionTd);
          tbody.appendChild(tr);
        });
      } catch (err) {
        tbody.innerHTML = '';
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 3;
        td.className = 'empty';
        td.textContent = 'Erreur lors du chargement des groupes.';
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
    }

    async function loadParticipants(groupId, groupName) {
      const title = document.getElementById('participants-title');
      const list = document.getElementById('participants-list');
      title.textContent = 'Chargement des participants...';
      list.innerHTML = '';

      try {
        const res = await fetch('/api/groups/' + encodeURIComponent(groupId) + '/participants');
        const participants = await res.json();

        if (!Array.isArray(participants) || participants.length === 0) {
          title.textContent = 'Aucun participant trouvé pour "' + (groupName || groupId) + '".';
          return;
        }

        title.textContent = 'Membres de "' + (groupName || groupId) + '" (' + participants.length + ')';

        participants.forEach((p) => {
          const li = document.createElement('li');
          li.textContent = (p.id || '').split('@')[0];
          list.appendChild(li);
        });
      } catch (err) {
        title.textContent = 'Erreur lors du chargement des participants.';
      }
    }

    loadGroups();
  </script>
</body>
</html>`);
});

app.post('/api/messages', async (req, res) => {
  const { to, message } = req.body;

  if (!to || !message) {
    return res.status(400).json({ error: 'Les champs "to" et "message" sont requis.' });
  }

  try {
    await whatsapp.sendMessage(to, message);
    res.status(200).json({ status: 'sent' });
  } catch (err) {
    console.error('Erreur lors de l\'envoi du message:', err);
    res.status(500).json({ error: 'Échec de l\'envoi du message.' });
  }
});

app.get('/api/groups', async (req, res) => {
  try {
    const groups = await whatsapp.getGroups();
    res.status(200).json(groups);
  } catch (err) {
    console.error('Erreur lors de la récupération des groupes:', err);
    res.status(500).json({ error: 'Échec de la récupération des groupes.' });
  }
});

app.get('/api/groups/:id/participants', async (req, res) => {
  try {
    const participants = await whatsapp.getGroupParticipants(req.params.id);
    res.status(200).json(participants);
  } catch (err) {
    console.error('Erreur lors de la récupération des participants:', err);
    res.status(500).json({ error: 'Échec de la récupération des participants.' });
  }
});

app.post('/api/messages/queue', async (req, res) => {
  const { recipients, message, delaySeconds } = req.body;

  if (!Array.isArray(recipients) || recipients.length === 0 || !message) {
    return res.status(400).json({
      error: 'Les champs "recipients" (tableau non vide) et "message" sont requis.',
    });
  }

  const delayMs = (parseFloat(delaySeconds) || 10) * 1000;

  res.status(202).json({ status: 'queue_started', total: recipients.length, delaySeconds: delayMs / 1000 });

  (async () => {
    for (let i = 0; i < recipients.length; i += 1) {
      const to = normalizeJid(recipients[i]);
      try {
        await whatsapp.sendMessage(to, message);
        console.log(`File d'attente: message envoyé à ${to} (${i + 1}/${recipients.length}).`);
      } catch (err) {
        console.error(`File d'attente: échec de l'envoi à ${to}:`, err);
      }

      if (i < recipients.length - 1) {
        await sleep(delayMs);
      }
    }
    console.log("File d'attente: terminée.");
  })().catch((err) => {
    console.error("Erreur pendant le traitement de la file d'attente:", err);
  });
});

app.post('/api/campaign/excel', upload.single('file'), async (req, res) => {
  let contacts;

  try {
    if (req.file) {
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      contacts = XLSX.utils.sheet_to_json(sheet);
    } else if (Array.isArray(req.body?.contacts)) {
      contacts = req.body.contacts;
    } else {
      return res.status(400).json({
        error: 'Fournissez un fichier Excel (champ "file") ou un tableau JSON "contacts" avec les colonnes telephone, prenom, message.',
      });
    }
  } catch (err) {
    console.error('Erreur lors de la lecture du fichier Excel:', err);
    return res.status(400).json({ error: 'Fichier Excel invalide.' });
  }

  if (!Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ error: 'Aucun contact à traiter.' });
  }

  const minDelaySeconds = parseFloat(req.body?.minDelaySeconds) || 8;
  const maxDelaySeconds = parseFloat(req.body?.maxDelaySeconds) || 15;

  res.status(202).json({
    status: 'campaign_started',
    total: contacts.length,
    minDelaySeconds,
    maxDelaySeconds,
  });

  runCampaign(contacts, minDelaySeconds * 1000, maxDelaySeconds * 1000).catch((err) => {
    console.error('Erreur pendant l\'exécution de la campagne:', err);
  });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

whatsapp.connect().catch((err) => {
  console.error('Erreur lors de l\'initialisation de l\'adaptateur WhatsApp:', err);
});
