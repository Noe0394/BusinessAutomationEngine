const express = require('express');
const whatsapp = require('./adapters/whatsapp');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
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

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

whatsapp.connect().catch((err) => {
  console.error('Erreur lors de l\'initialisation de l\'adaptateur WhatsApp:', err);
});
