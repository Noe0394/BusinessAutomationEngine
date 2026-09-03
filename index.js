const crypto = require('crypto');
if (!globalThis.crypto) {
  globalThis.crypto = crypto.webcrypto || crypto;
}

const path = require('path');
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const QRCode = require('qrcode');
const whatsapp = require('./adapters/whatsapp');

const app = express();
const PORT = process.env.PORT || 10000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '@CYRUS2026';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });
const DASHBOARD_PATH = path.join(__dirname, 'public', 'dashboard.html');

if (!process.env.ADMIN_PASSWORD) {
  console.warn('ADMIN_PASSWORD non défini : utilisation du mot de passe par défaut codé en dur. Définissez cette variable d\'environnement avant tout déploiement public.');
}

app.use(express.json());

function requireAdminPassword(req, res, next) {
  const provided = req.get('x-admin-password') || req.query.password;

  if (provided && provided === ADMIN_PASSWORD) {
    return next();
  }

  return res.status(401).json({ error: 'Mot de passe administrateur invalide ou manquant.' });
}

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

let currentCampaign = null;

async function interruptibleSleep(ms, shouldStop) {
  const tickMs = 300;
  let elapsed = 0;
  while (elapsed < ms) {
    if (shouldStop()) return;
    const step = Math.min(tickMs, ms - elapsed);
    await sleep(step);
    elapsed += step;
  }
}

async function runCampaignQueue(campaign, recipients, message, options = {}) {
  const { delaySeconds, batchSize, media } = options;
  const batch = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : recipients.length;

  for (let i = 0; i < recipients.length; i += 1) {
    if (campaign.stopRequested) {
      for (let j = i; j < recipients.length; j += 1) {
        campaign.results.push({
          to: normalizeJid(recipients[j]),
          status: 'interrupted',
          timestamp: new Date().toISOString(),
        });
      }
      campaign.status = 'stopped';
      campaign.finishedAt = new Date().toISOString();
      console.log('Campagne: interrompue par l\'utilisateur.');
      return;
    }

    const to = normalizeJid(recipients[i]);
    let status = 'failed';

    try {
      if (media) {
        await whatsapp.sendMedia(to, { ...media, caption: message });
      } else {
        await whatsapp.sendMessage(to, message);
      }
      status = 'delivered';
      campaign.success += 1;
      console.log(`Campagne: message envoyé à ${to} (${i + 1}/${recipients.length}).`);
    } catch (err) {
      campaign.failed += 1;
      console.error(`Campagne: échec de l'envoi à ${to}:`, err);
    }

    campaign.sent += 1;
    campaign.results.push({ to, status, timestamp: new Date().toISOString() });

    if (i < recipients.length - 1 && !campaign.stopRequested) {
      const baseDelayMs = delaySeconds ? delaySeconds * 1000 : randomDelay(8000, 15000);
      const endOfBatch = (i + 1) % batch === 0;
      const delayMs = endOfBatch ? baseDelayMs * 3 : baseDelayMs;
      await interruptibleSleep(delayMs, () => campaign.stopRequested);
    }
  }

  if (campaign.status === 'running') {
    campaign.status = 'completed';
    campaign.finishedAt = new Date().toISOString();
  }

  console.log('Campagne: terminée.');
}

function startCampaign(recipients, message, options = {}) {
  if (currentCampaign && currentCampaign.status === 'running') {
    throw new Error('CAMPAIGN_IN_PROGRESS');
  }

  currentCampaign = {
    total: recipients.length,
    sent: 0,
    success: 0,
    failed: 0,
    status: 'running',
    stopRequested: false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    results: [],
  };

  const campaign = currentCampaign;

  runCampaignQueue(campaign, recipients, message, options).catch((err) => {
    console.error('Erreur pendant la campagne:', err);
    campaign.status = 'stopped';
    campaign.finishedAt = new Date().toISOString();
  });

  return campaign;
}

async function findGroupByName(name) {
  const groups = await whatsapp.getGroups();
  const needle = name.trim().toLowerCase();
  return groups.find((g) => (g.subject || '').toLowerCase().includes(needle));
}

async function handleNaturalMessage(message) {
  const text = message.trim();
  const lowered = text.toLowerCase();

  if (/liste\s+mes\s+groupes|affiche\s+(les\s+)?groupes|montre\s+(moi\s+)?(les\s+)?groupes|quels?\s+sont\s+mes\s+groupes/.test(lowered)) {
    const groups = await whatsapp.getGroups();
    if (groups.length === 0) {
      return 'Aucun groupe trouvé. Le compte WhatsApp est peut-être encore en cours de synchronisation.';
    }
    const lines = groups.map((g, i) => `${i + 1}. ${g.subject || '(sans nom)'} — ${g.id}`);
    return `Voici vos ${groups.length} groupe(s) :\n${lines.join('\n')}`;
  }

  const participantsMatch = text.match(
    /(?:montre(?:[- ]moi)?\s+les\s+membres\s+du\s+groupe\s+|membres\s+du\s+groupe\s+|participants\s+(?:du\s+groupe\s+|de\s+))(.+)/i,
  );
  if (participantsMatch) {
    const groupName = participantsMatch[1].replace(/[?.!]+$/, '').trim();
    const group = await findGroupByName(groupName);
    if (!group) {
      return `Aucun groupe correspondant à "${groupName}" n'a été trouvé.`;
    }
    const participants = await whatsapp.getGroupParticipants(group.id);
    if (!participants || participants.length === 0) {
      return `Aucun participant trouvé pour le groupe "${group.subject}".`;
    }
    const lines = participants.map((p, i) => `${i + 1}. ${(p.id || '').split('@')[0]}`);
    return `Membres de "${group.subject}" (${participants.length}) :\n${lines.join('\n')}`;
  }

  const campaignMatch = text.match(
    /^envoie\s+(.+?)\s+au\s+groupe\s+(.+?)(?:\s+avec\s+un\s+délai\s+de\s+(\d+)\s*(?:secondes?|s)?)?[.!]?$/i,
  );
  if (campaignMatch) {
    const [, campaignMessage, groupNameRaw, delaySecondsRaw] = campaignMatch;
    const groupName = groupNameRaw.replace(/[?.!]+$/, '').trim();
    const group = await findGroupByName(groupName);
    if (!group) {
      return `Aucun groupe correspondant à "${groupName}" n'a été trouvé.`;
    }
    const participants = await whatsapp.getGroupParticipants(group.id);
    if (!participants || participants.length === 0) {
      return `Le groupe "${group.subject}" ne contient aucun participant à contacter.`;
    }

    const recipients = participants.map((p) => p.id);
    const delaySeconds = delaySecondsRaw ? parseFloat(delaySecondsRaw) : undefined;

    try {
      startCampaign(recipients, campaignMessage.trim(), { delaySeconds });
    } catch (err) {
      if (err.message === 'CAMPAIGN_IN_PROGRESS') {
        return 'Une campagne est déjà en cours. Attendez sa fin ou interrompez-la avant d\'en lancer une nouvelle.';
      }
      throw err;
    }

    const delayLabel = delaySeconds ? `${delaySeconds}s fixe` : '8-15s aléatoire';
    return `🚀 Campagne lancée sur le groupe "${group.subject}" (${recipients.length} membre(s)). Délai entre chaque envoi : ${delayLabel}.`;
  }

  return 'Je n\'ai pas compris cette demande. Essayez par exemple : "liste mes groupes", "participants du groupe Famille", ou "envoie Bonjour ! au groupe Famille avec un délai de 10 secondes".';
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

app.get(['/', '/dashboard'], (req, res) => {
  res.sendFile(DASHBOARD_PATH);
});

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};

  if (password && password === ADMIN_PASSWORD) {
    return res.status(200).json({ success: true });
  }

  return res.status(401).json({ error: 'Mot de passe incorrect.' });
});

app.get('/api/status', requireAdminPassword, async (req, res) => {
  const connected = whatsapp.isConnected();
  const response = { connected };

  if (!connected) {
    const qr = whatsapp.getQRCode();
    if (qr) {
      try {
        response.qr = await QRCode.toDataURL(qr);
      } catch (err) {
        console.error('Erreur lors de la génération du QR code pour /api/status:', err);
      }
    }
  }

  res.status(200).json(response);
});

app.post('/api/pairing-code', requireAdminPassword, async (req, res) => {
  const { phoneNumber } = req.body || {};

  if (!phoneNumber || !String(phoneNumber).replace(/\D/g, '')) {
    return res.status(400).json({ error: 'Le champ "phoneNumber" est requis (indicatif pays inclus, ex: 225xxxxxxxxx).' });
  }

  try {
    const code = await whatsapp.requestPairingCode(phoneNumber);
    res.status(200).json({ code });
  } catch (err) {
    if (err.message === 'ALREADY_REGISTERED') {
      return res.status(409).json({ error: 'Cet appareil est déjà connecté à WhatsApp.' });
    }
    console.error('Erreur lors de la génération du code d\'association:', err);
    res.status(500).json({ error: 'Échec de la génération du code d\'association.' });
  }
});

app.post('/api/messages', requireAdminPassword, async (req, res) => {
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

app.get('/api/groups', requireAdminPassword, async (req, res) => {
  try {
    const groups = await whatsapp.getGroups();
    res.status(200).json(groups);
  } catch (err) {
    console.error('Erreur lors de la récupération des groupes:', err);
    res.status(500).json({ error: 'Échec de la récupération des groupes.' });
  }
});

app.get('/api/groups/:id/participants', requireAdminPassword, async (req, res) => {
  try {
    const participants = await whatsapp.getGroupParticipants(req.params.id);
    res.status(200).json(participants);
  } catch (err) {
    console.error('Erreur lors de la récupération des participants:', err);
    res.status(500).json({ error: 'Échec de la récupération des participants.' });
  }
});

app.post('/api/messages/queue', requireAdminPassword, upload.single('media'), async (req, res) => {
  const { message, groupId, delaySeconds, batchSize } = req.body;
  let { recipients, groupIds } = req.body;

  if (typeof recipients === 'string') {
    try {
      recipients = JSON.parse(recipients);
    } catch (err) {
      recipients = recipients.split(/[,\n]/).map((n) => n.trim()).filter(Boolean);
    }
  }

  if (typeof groupIds === 'string') {
    try {
      groupIds = JSON.parse(groupIds);
    } catch (err) {
      groupIds = groupIds.split(',').map((n) => n.trim()).filter(Boolean);
    }
  }

  const targetGroupIds = Array.isArray(groupIds) && groupIds.length > 0
    ? groupIds
    : (groupId ? [groupId] : []);

  if ((!Array.isArray(recipients) || recipients.length === 0) && targetGroupIds.length > 0) {
    try {
      const merged = new Set();
      for (const gId of targetGroupIds) {
        const participants = await whatsapp.getGroupParticipants(gId);
        (participants || []).forEach((p) => merged.add(p.id));
      }
      recipients = Array.from(merged);
    } catch (err) {
      console.error('Erreur lors de la récupération des participants des groupes cibles:', err);
      return res.status(400).json({ error: 'Impossible de récupérer les participants des groupes cibles.' });
    }
  }

  if (!Array.isArray(recipients) || recipients.length === 0 || !message) {
    return res.status(400).json({
      error: 'Fournissez "recipients" (tableau ou liste), "groupId" ou "groupIds", ainsi qu\'un "message".',
    });
  }

  const fixedDelaySeconds = delaySeconds !== undefined && delaySeconds !== '' ? parseFloat(delaySeconds) : undefined;
  const parsedBatchSize = batchSize !== undefined && batchSize !== '' ? parseInt(batchSize, 10) : undefined;
  const media = req.file
    ? { buffer: req.file.buffer, mimetype: req.file.mimetype, filename: req.file.originalname }
    : null;

  let campaign;
  try {
    campaign = startCampaign(recipients, message, {
      delaySeconds: fixedDelaySeconds,
      batchSize: parsedBatchSize,
      media,
    });
  } catch (err) {
    if (err.message === 'CAMPAIGN_IN_PROGRESS') {
      return res.status(409).json({
        error: 'Une campagne est déjà en cours. Attendez sa fin ou interrompez-la (STOP) avant d\'en lancer une nouvelle.',
      });
    }
    throw err;
  }

  res.status(202).json({
    status: 'campaign_started',
    total: campaign.total,
    delaySeconds: fixedDelaySeconds || '8-15 (aléatoire)',
    batchSize: parsedBatchSize || recipients.length,
    media: media ? media.filename : null,
  });
});

app.post('/api/messages/stop', requireAdminPassword, (req, res) => {
  if (!currentCampaign || currentCampaign.status !== 'running') {
    return res.status(400).json({ error: 'Aucune campagne en cours à interrompre.' });
  }

  currentCampaign.stopRequested = true;
  res.status(200).json({ status: 'stop_requested' });
});

app.get('/api/messages/status', requireAdminPassword, (req, res) => {
  if (!currentCampaign) {
    return res.status(200).json({ exists: false });
  }

  res.status(200).json({ exists: true, ...currentCampaign });
});

app.post('/api/contacts/import', requireAdminPassword, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Aucun fichier fourni (champ "file").' });
  }

  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    const contacts = rows
      .map((row) => ({
        telephone: String(row.telephone || row.Telephone || row.phone || row.Phone || row.numero || row.Numero || '').trim(),
        prenom: String(row.prenom || row.Prenom || row.name || row.Name || '').trim(),
      }))
      .filter((c) => c.telephone);

    res.status(200).json({ contacts, total: contacts.length });
  } catch (err) {
    console.error('Erreur lors de l\'import du fichier de contacts:', err);
    res.status(400).json({ error: 'Fichier invalide. Utilisez un fichier .xlsx ou .csv avec une colonne "telephone".' });
  }
});

app.post('/api/chat-natural', requireAdminPassword, async (req, res) => {
  const { message } = req.body || {};

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Le champ "message" (texte) est requis.' });
  }

  try {
    const reply = await handleNaturalMessage(message);
    res.status(200).json({ reply });
  } catch (err) {
    console.error('Erreur lors du traitement du message en langage naturel:', err);
    res.status(500).json({ reply: 'Une erreur est survenue lors du traitement de votre demande.' });
  }
});

app.post('/api/campaign/excel', requireAdminPassword, upload.single('file'), async (req, res) => {
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

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Erreur de téléversement : ${err.message}` });
  }
  if (err) {
    console.error('Erreur non gérée:', err);
    return res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
  return next();
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

whatsapp.connect().catch((err) => {
  console.error('Erreur lors de l\'initialisation de l\'adaptateur WhatsApp:', err);
});
