require('dotenv').config();

const path = require('path');
const express = require('express');
const open = require('open');

const { verifyLicense } = require('./lib/license');
const { checkAndSelfUpdate } = require('./lib/selfUpdate');
const whatsapp = require('./lib/whatsapp');
const aiGateway = require('./lib/aiGateway');
const db = require('./lib/db');
const campaigns = require('./lib/campaigns');
const ebookGenerator = require('./lib/pdf/ebookGenerator');
const { DATA_DIR } = require('./lib/paths');

const PORT = process.env.LOCAL_PORT || 4100;

async function main() {
  // Tout en premier, avant même la licence : si une mise à jour est
  // appliquée, cette fonction ne rend JAMAIS la main (process.exit — un
  // script jetable relance une instance à jour, qui retraverse ce même
  // point). Voir lib/selfUpdate.js pour le détail (un seul exécutable
  // distribué, aucun second programme à installer).
  await checkAndSelfUpdate();

  console.log(`Données locales : ${DATA_DIR}`);
  console.log('Vérification de la licence auprès du VPS central...');

  const license = await verifyLicense();
  if (!license.valid) {
    console.error(`\nLICENCE INVALIDE : ${license.error}`);
    console.error('Accès bloqué — contactez votre administrateur pour une clé valide.\n');
    process.exit(1);
  }
  console.log(`Licence valide (expire le ${license.expiresAt || 'jamais'}).`);

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/status', (req, res) => {
    res.json({ connected: whatsapp.isConnected(), qr: whatsapp.getQRCode() });
  });

  // Purement informatif désormais (voir lib/selfUpdate.js, qui applique
  // déjà la mise à jour AVANT que ce serveur ne démarre) — utile seulement
  // si une mise à jour vient d'apparaître EN COURS de session (elle ne sera
  // appliquée qu'au prochain redémarrage, jamais en cours de route).
  app.get('/api/update-status', async (req, res) => {
    const { checkForUpdate } = require('./lib/updateCheck');
    res.json(await checkForUpdate());
  });

  app.post('/api/whatsapp/send', async (req, res) => {
    try {
      const { to, text } = req.body || {};
      const result = await whatsapp.sendMessage(to, text);
      res.json({ ok: true, id: result?.id?._serialized || null });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get('/api/contacts', (req, res) => {
    res.json(db.listContacts());
  });

  // Import manuel ou CSV (déjà parsé côté navigateur, voir public/app.js) :
  // accepte un tableau de { telephone, nom } ou de simples numéros.
  app.post('/api/contacts/import', (req, res) => {
    const entries = Array.isArray(req.body?.contacts) ? req.body.contacts : [];
    let count = 0;
    for (const entry of entries) {
      const telephone = typeof entry === 'string' ? entry : entry.telephone;
      const nom = typeof entry === 'string' ? null : entry.nom;
      const digits = String(telephone || '').replace(/\D/g, '');
      if (!digits) continue;
      db.upsertContact({ jid: `${digits}@s.whatsapp.net`, nom, telephone: digits });
      count += 1;
    }
    res.json({ imported: count });
  });

  app.get('/api/messages/:jid', (req, res) => {
    res.json(db.listMessages(req.params.jid));
  });

  // ---------- Campagnes locales (voir lib/campaigns.js) ----------
  app.get('/api/campaigns', (req, res) => {
    res.json(campaigns.listCampaigns());
  });

  app.post('/api/campaigns', (req, res) => {
    try {
      const { name, recipients, text, delayMinMs, delayMaxMs } = req.body || {};
      const campaign = campaigns.createCampaign(name, recipients, { text, delayMinMs, delayMaxMs });
      res.json(campaign);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/campaigns/:id', (req, res) => {
    const campaign = campaigns.getCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campagne introuvable.' });
    res.json(campaign);
  });

  app.post('/api/campaigns/:id/start', (req, res) => {
    try {
      campaigns.startCampaign(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/campaigns/:id/pause', (req, res) => {
    try {
      campaigns.pauseCampaign(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/campaigns/:id/cancel', (req, res) => {
    try {
      campaigns.cancelCampaign(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Passerelle IA (jamais de clé fournisseur ici, voir lib/aiGateway.js).
  app.post('/api/ai/text', async (req, res) => {
    try {
      const { prompt, history, mode, skillKey } = req.body || {};
      const result = await aiGateway.generateText(prompt, { history, mode, skillKey });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.response?.data?.error || err.message });
    }
  });

  app.post('/api/ai/image', async (req, res) => {
    try {
      const { prompt, width, height } = req.body || {};
      const result = await aiGateway.generateImage(prompt, { width, height });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.response?.data?.error || err.message });
    }
  });

  // Vidéo IA (image-to-video, job asynchrone — voir lib/aiGateway.js#startVideo/
  // pollVideo). Le client doit d'abord obtenir une image (voir /api/ai/image)
  // avant de soumettre son URL ici.
  app.post('/api/ai/video/start', async (req, res) => {
    try {
      const { imageUrl, prompt, seed, preferredProvider } = req.body || {};
      const result = await aiGateway.startVideo(imageUrl, { prompt, seed, preferredProvider });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.response?.data?.error || err.message });
    }
  });

  app.post('/api/ai/video/poll', async (req, res) => {
    try {
      const { jobId } = req.body || {};
      const result = await aiGateway.pollVideo(jobId);
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.response?.data?.error || err.message });
    }
  });

  // ---------- Génération de livre PDF (voir lib/pdf/ebookGenerator.js)
  // ----------
  // Rédaction séquentielle des chapitres (jamais un seul gros appel
  // multi-chapitres, voir index.js racine#executeGenerateBook) : un modèle
  // gratuit à quota de sortie limité tronquerait une réponse trop longue.
  // pdfkit lui-même n'a besoin d'aucun réseau — seul aiGateway.generateText
  // (déjà Firebase en premier) appelle l'extérieur.
  app.post('/api/ebook/generate', async (req, res) => {
    try {
      const { title, chapterTopics } = req.body || {};
      const topics = (Array.isArray(chapterTopics) ? chapterTopics : []).slice(0, 5);
      if (topics.length === 0) {
        return res.status(400).json({ error: 'Aucun sujet de chapitre à rédiger.' });
      }

      const chapters = [];
      for (const topic of topics) {
        const chapterPrompt = `Chapitre à rédiger intégralement pour le livre "${title}" : "${topic}"`;
        // eslint-disable-next-line no-await-in-loop -- rédaction séquentielle volontaire
        const { text: content } = await aiGateway.generateText(chapterPrompt, { mode: 'longform' });
        chapters.push({ title: String(topic).slice(0, 150), content: String(content || '').slice(0, 6000) });
      }

      const pdfBuffer = await ebookGenerator.generateEbookPdf({
        title: String(title || 'Livre généré par IA').slice(0, 150),
        chapters,
      });
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `attachment; filename="${String(title || 'livre').replace(/[^a-z0-9]+/gi, '_').slice(0, 80)}.pdf"`);
      res.send(pdfBuffer);
    } catch (err) {
      res.status(502).json({ error: err.response?.data?.error || err.message });
    }
  });

  app.listen(PORT, () => {
    console.log(`Interface locale disponible sur http://localhost:${PORT}`);
    open(`http://localhost:${PORT}`).catch(() => {
      console.warn('Impossible d\'ouvrir automatiquement le navigateur — ouvrez l\'URL ci-dessus manuellement.');
    });
  });

  whatsapp.connect().catch((err) => {
    console.error('Erreur lors de la connexion WhatsApp :', err.message);
  });
}

main().catch((err) => {
  console.error('Erreur fatale au démarrage :', err.message);
  process.exit(1);
});
