require('dotenv').config();

const path = require('path');
const express = require('express');
const open = require('open');

const { verifyLicense } = require('./lib/license');
const { checkAndSelfUpdate } = require('./lib/selfUpdate');
const whatsapp = require('./lib/whatsapp');
const telegram = require('./lib/telegram');
const aiGateway = require('./lib/aiGateway');
const db = require('./lib/db');
const campaigns = require('./lib/campaigns');
const ebookGenerator = require('./lib/pdf/ebookGenerator');
const { DATA_DIR } = require('./lib/paths');
const taskParser = require('./lib/intelligence/task-parser');
const humanContext = require('./lib/intelligence/human-context-engine');
const goalChat = require('./lib/intelligence/goal-chat');

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

  app.get('/api/status', async (req, res) => {
    try {
      res.json({
        connected: whatsapp.isConnected(),
        qr: whatsapp.getQRCode(),
        qrImage: await whatsapp.getQRCodeImage(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Purement informatif désormais (voir lib/selfUpdate.js, qui applique
  // déjà la mise à jour AVANT que ce serveur ne démarre) — utile seulement
  // si une mise à jour vient d'apparaître EN COURS de session (elle ne sera
  // appliquée qu'au prochain redémarrage, jamais en cours de route).
  app.get('/api/update-status', async (req, res) => {
    try {
      const { checkForUpdate } = require('./lib/updateCheck');
      res.json(await checkForUpdate());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
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

  // ---------- Extraction de groupes WhatsApp (feuille de route "export Excel")
  // ---------- Le fichier lui-même est produit côté navigateur (SheetJS, voir
  // public/lib/xlsx.full.min.js + public/app.js) à partir de ce JSON — pas de
  // dépendance xlsx côté serveur.
  app.get('/api/whatsapp/groups', async (req, res) => {
    try {
      res.json(await whatsapp.getGroups());
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get('/api/whatsapp/groups/:id/members', async (req, res) => {
    try {
      res.json(await whatsapp.getGroupMembers(req.params.id));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ---------- Telegram (MTProto/GramJS, voir lib/telegram.js) ----------
  // Flux de connexion en 3 étapes (numéro -> code -> mot de passe 2FA
  // éventuel) piloté par polling de GET /api/telegram/status plutôt qu'un
  // WebSocket — le frontend affiche le champ correspondant à `step`.
  app.get('/api/telegram/status', (req, res) => {
    res.json({
      configured: telegram.isConfigured(),
      connected: telegram.isConnected(),
      error: telegram.getLoginError(),
    });
  });

  app.post('/api/telegram/login/start', async (req, res) => {
    try {
      const step = await telegram.startLogin(String(req.body?.phone || '').trim());
      res.json({ step });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/telegram/login/code', async (req, res) => {
    try {
      const step = await telegram.submitCode(String(req.body?.code || '').trim());
      res.json({ step });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/telegram/login/password', async (req, res) => {
    try {
      const step = await telegram.submitPassword(String(req.body?.password || ''));
      res.json({ step });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/telegram/logout', async (req, res) => {
    try {
      await telegram.logout();
      res.json({ ok: true });
    } catch (err) {
      // Seule route de ce fichier sans try/catch jusqu'ici : une erreur
      // imprévue (ex. client.logout() inexistant côté GramJS, voir
      // lib/telegram.js) faisait planter tout le process au lieu de
      // renvoyer une erreur HTTP — corrigé en même temps que le bug lui-même.
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/telegram/send', async (req, res) => {
    try {
      const { to, text } = req.body || {};
      await telegram.sendMessage(to, text);
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get('/api/telegram/groups', async (req, res) => {
    try {
      res.json(await telegram.getGroups());
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get('/api/telegram/groups/:id/members', async (req, res) => {
    try {
      res.json(await telegram.getGroupMembers(req.params.id));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get('/api/contacts', (req, res) => {
    res.json(db.listContacts());
  });

  // ---------- Liste noire (voir lib/db.js, appliquée dans
  // lib/campaigns.js#createCampaign) ----------
  app.get('/api/blocklist', (req, res) => {
    const channel = req.query.channel === 'telegram' ? 'telegram' : 'whatsapp';
    res.json(db.getBlocklist(channel));
  });

  app.post('/api/blocklist', (req, res) => {
    const { channel, identifier } = req.body || {};
    const resolvedChannel = channel === 'telegram' ? 'telegram' : 'whatsapp';
    const value = String(identifier || '').trim();
    if (!value) return res.status(400).json({ error: 'Identifiant manquant.' });
    db.addToBlocklist(resolvedChannel, value);
    res.json({ ok: true });
  });

  app.delete('/api/blocklist', (req, res) => {
    const { channel, identifier } = req.body || {};
    const resolvedChannel = channel === 'telegram' ? 'telegram' : 'whatsapp';
    db.removeFromBlocklist(resolvedChannel, String(identifier || '').trim());
    res.json({ ok: true });
  });

  // ---------- Pont WHATSAPP_LOCAL (couche intelligence -> machine PC) ----------
  // Clé d'accès partagée (secret partagé VPS<->PC) : lue de MACHINE_KEY,
  // sinon générée une fois et persistée dans DATA_DIR/machine-key.txt
  // (jamais commitée). Voir lib/machine.js pour le contrat d'actions.
  const machine = require('./lib/machine');
  let machineKey = String(process.env.MACHINE_KEY || '').trim();
  if (!machineKey) {
    const fs = require('fs');
    const keyPath = path.join(DATA_DIR, 'machine-key.txt');
    try {
      if (fs.existsSync(keyPath)) machineKey = fs.readFileSync(keyPath, 'utf8').trim();
      if (!machineKey) {
        machineKey = require('crypto').randomBytes(24).toString('hex');
        fs.writeFileSync(keyPath, machineKey, 'utf8');
      }
    } catch (e) {
      machineKey = require('crypto').randomBytes(24).toString('hex');
    }
    console.log(`Clé machine (WHATSAPP_LOCAL) : ${machineKey} — configurez-la côté orchestrateur.`);
  }

  app.use('/api/machine', (req, res, next) => {
    const provided = String(req.get('x-machine-key') || '').trim();
    const ok = machineKey && provided && provided.length === machineKey.length
      && require('crypto').timingSafeEqual(Buffer.from(provided), Buffer.from(machineKey));
    if (!ok) return res.status(401).json({ error: 'MACHINE_KEY_INVALID' });
    next();
  });

  // Carte machine (Machine view) : ce que cette machine sait faire + état.
  app.get('/api/machine', async (req, res) => {
    try {
      const s = await machine.getStatus();
      res.json(s.result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Un job = une action du registre intelligence, exécutée réellement ici.
  app.post('/api/machine/job', async (req, res) => {
    try {
      const { action, payload } = req.body || {};
      const out = await machine.execute(action, payload);
      res.status(out.ok ? 200 : 400).json(out);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ---------- Chat Intelligent (Goal Chat, voir lib/intelligence/goal-chat.js)
  // ---------- Même moteur que le mode VPS (task-parser + human-context-engine),
  // en session mémoire par sessionId. Contrairement au VPS, "run-plan" n'est
  // PAS auto-exécuté ici : le client redirige vers l'onglet Campagnes (canal
  // préréglé) plutôt que de réimplémenter un moteur d'envoi côté chat — le
  // vrai envoi passe toujours par POST /api/campaigns (lib/campaigns.js).
  const goalChatSessions = new Map();
  app.post('/api/intelligence/goal-chat', (req, res) => {
    const { message, sessionId, action } = req.body || {};
    let state = sessionId ? goalChatSessions.get(sessionId) : null;
    if (!state) {
      state = goalChat.createSession({});
      goalChatSessions.set(state.sessionId, state);
    }
    if (action === 'restart') {
      goalChatSessions.delete(state.sessionId);
      const fresh = goalChat.createSession({});
      goalChatSessions.set(fresh.sessionId, fresh);
      return res.json({ ok: true, sessionId: fresh.sessionId, kind: 'question', reply: goalChat.WELCOME });
    }
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Le champ "message" est requis (ou action:"restart").' });
    }
    const out = goalChat.step(state, { message, parser: taskParser, humanContext });
    res.json(Object.assign({ ok: true, sessionId: state.sessionId }, out));
  });

  // ---------- Page Connexions : historique unifié WhatsApp + Telegram ----------
  app.get('/api/history', (req, res) => {
    res.json(db.listSentHistory(100));
  });

  app.post('/api/whatsapp/logout', async (req, res) => {
    try {
      await whatsapp.logout();
      // Relance immédiatement une session vierge (nouveau QR) plutôt que de
      // laisser whatsapp-web.js inactif jusqu'au prochain redémarrage complet
      // du serveur - même esprit que logoutWhatsApp() côté mobile/webapp.
      whatsapp.connect().catch((err) => {
        console.error('Erreur lors de la reconnexion WhatsApp après déconnexion :', err.message);
      });
      res.json({ ok: true });
    } catch (err) {
      console.error('Erreur lors de la déconnexion WhatsApp :', err.stack || err.message);
      res.status(500).json({ error: err.message });
    }
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
      const { name, recipients, text, delayMinMs, delayMaxMs, channel, media, batchSize, batchPauseMs } = req.body || {};
      const campaign = campaigns.createCampaign(name, recipients, { text, delayMinMs, delayMaxMs, channel, media, batchSize, batchPauseMs });
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

  // Relance Manuelle Express (voir public/relance.js) : trace un envoi
  // déclenché manuellement via deep link, sans passer par la boucle
  // automatique de lib/campaigns.js#runLoop.
  app.post('/api/campaigns/:id/mark-sent', (req, res) => {
    try {
      campaigns.markManualSent(req.params.id, String(req.body?.to || ''));
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

  // ---------- Creative Director (Studio Média Prédictif, voir
  // public/media-studio.js) — parité avec POST /api/media/creative-direction
  // côté VPS (index.js racine) : même prompt structuré JSON, réutilise
  // aiGateway.generateText au lieu de dupliquer une cascade LLM ici.
  const MEDIA_CREATIVE_SECTORS = ['restauration', 'immobilier', 'ecommerce', 'hightech', 'formation'];
  const MEDIA_CREATIVE_FORMATS = ['9:16', '1:1', '16:9', '4:5'];

  function extractJsonBlock(rawText) {
    const match = String(rawText || '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (err) {
      return null;
    }
  }

  function parseCreativeDirective(rawText) {
    const parsed = extractJsonBlock(rawText);
    if (!parsed) return null;
    return {
      detectedSector: MEDIA_CREATIVE_SECTORS.includes(parsed.detectedSector) ? parsed.detectedSector : '',
      marketingHook: typeof parsed.marketingHook === 'string' ? parsed.marketingHook.trim().slice(0, 120) : '',
      imagePromptEnglish: typeof parsed.imagePromptEnglish === 'string' ? parsed.imagePromptEnglish.trim().slice(0, 800) : '',
      videoScript: typeof parsed.videoScript === 'string' ? parsed.videoScript.trim().slice(0, 600) : '',
      suggestedFormats: Array.isArray(parsed.suggestedFormats)
        ? parsed.suggestedFormats.filter((f) => MEDIA_CREATIVE_FORMATS.includes(f))
        : [],
    };
  }

  app.post('/api/media/creative-direction', async (req, res) => {
    const concept = String((req.body || {}).concept || '').trim();
    if (!concept) {
      return res.status(400).json({ error: 'Décrivez le visuel avant de demander une direction créative IA.' });
    }
    const instructionPrompt = [
      'Réponds UNIQUEMENT avec un objet JSON valide (aucun texte avant/après, aucun markdown), exactement dans ce format :',
      `{"detectedSector":"une valeur parmi ${MEDIA_CREATIVE_SECTORS.join('|')}","marketingHook":"accroche courte et percutante en français pour une affiche","imagePromptEnglish":"prompt visuel photoréaliste ultra-détaillé en anglais avec éclairage et détails HD, pour un générateur d'image IA","videoScript":"script court en français pour une voix off vidéo (2 à 3 phrases)","suggestedFormats":["deux valeurs parmi ${MEDIA_CREATIVE_FORMATS.join(', ')}"]}`,
      `Demande du client : "${concept}"`,
    ].join('\n');

    try {
      const { text: llmText, provider } = await aiGateway.generateText(instructionPrompt, { mode: 'json' });
      const directive = parseCreativeDirective(llmText);
      if (!directive) throw new Error('Aucun JSON de directive créative exploitable dans la réponse du LLM.');
      res.json({ directive, provider });
    } catch (err) {
      console.warn('Creative Director IA — cascade LLM indisponible :', err.message);
      res.status(503).json({ error: 'Direction créative IA indisponible pour le moment — renseignez les champs manuellement.' });
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
      // Parité avec public/dashboard.html (Studio IA > Générateur de Livres) :
      // ebookGenerator.js (racine, copié à l'identique ici) supporte déjà
      // tous ces champs (spec.subtitle/author/date/watermarkText/
      // coverImageBuffer/logoImageBuffer/introduction/conclusion) — seule
      // cette route ne les exposait pas encore. Plus de plafond à 5
      // chapitres (le VPS n'en impose pas non plus).
      const {
        title, subtitle, author, date, watermarkText, introduction, conclusion,
        chapterTopics, coverImageBase64, logoImageBase64,
      } = req.body || {};
      const topics = Array.isArray(chapterTopics) ? chapterTopics : [];
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
        subtitle: subtitle ? String(subtitle).slice(0, 200) : undefined,
        author: author ? String(author).slice(0, 150) : undefined,
        date: date ? String(date).slice(0, 60) : undefined,
        watermarkText: watermarkText ? String(watermarkText).slice(0, 60) : undefined,
        introduction: introduction ? String(introduction).slice(0, 6000) : undefined,
        conclusion: conclusion ? String(conclusion).slice(0, 6000) : undefined,
        coverImageBuffer: coverImageBase64 ? Buffer.from(coverImageBase64, 'base64') : undefined,
        logoImageBuffer: logoImageBase64 ? Buffer.from(logoImageBase64, 'base64') : undefined,
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
  telegram.connect().catch((err) => {
    console.error('Erreur lors de la connexion Telegram :', err.message);
  });
}

main().catch((err) => {
  console.error('Erreur fatale au démarrage :', err.message);
  process.exit(1);
});
