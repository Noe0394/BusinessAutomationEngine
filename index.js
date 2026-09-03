const crypto = require('crypto');
if (!globalThis.crypto) {
  globalThis.crypto = crypto.webcrypto || crypto;
}

const express = require('express');
const QRCode = require('qrcode');
const whatsapp = require('./adapters/whatsapp');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

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
