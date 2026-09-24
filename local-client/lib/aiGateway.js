// Passerelle distante des médias et des appels texte explicites du client PC.
// Toute requête distante passe par le Worker Cloudflare sous licence; ce
// module ne contacte ni Firebase, ni un fournisseur IA, ni le VPS.
const axios = require('axios');
const { LICENSE_KEY } = require('./licenseConfig');
const { getDeviceId } = require('./deviceId');

const CLOUDFLARE_BASE = String(process.env.CLOUDFLARE_LICENSE_URL || 'https://cyrus-license.ezechielatannidje.workers.dev').replace(/\/+$/, '');

function licenseHeaders() {
  return { 'x-license-key': LICENSE_KEY, 'x-device-id': getDeviceId() };
}

async function post(path, body, timeout = 60_000) {
  const { data } = await axios.post(`${CLOUDFLARE_BASE}${path}`, body, { headers: licenseHeaders(), timeout });
  return data;
}

function textPrompt(prompt, options = {}) {
  const parts = [];
  if (options.mode) parts.push(`Mode de réponse : ${String(options.mode).slice(0, 80)}.`);
  if (options.skillKey) parts.push(`Spécialité demandée : ${String(options.skillKey).slice(0, 120)}.`);
  if (Array.isArray(options.history) && options.history.length) {
    const history = options.history.slice(-12).map(item => {
      const role = item && (item.role === 'assistant' || item.role === 'model') ? 'assistant' : 'user';
      return `${role}: ${String(item && (item.text || item.content) || '').slice(0, 1500)}`;
    });
    parts.push('Historique récent :\n' + history.join('\n'));
  }
  parts.push(String(prompt || '').slice(0, 9000));
  return parts.join('\n\n').slice(0, 12000);
}

async function generateText(prompt, options = {}) {
  if (!String(prompt || '').trim()) throw new Error('Prompt de génération vide.');
  return post('/ai/text', { prompt: textPrompt(prompt, options) }, 60_000);
}

async function generateImage(prompt, { width, height } = {}) {
  if (!String(prompt || '').trim()) throw new Error('Prompt image vide.');
  const result = await post('/ai/image', { prompt: String(prompt).slice(0, 2000), width, height }, 60_000);
  if (!result || !result.url) throw new Error('Le Worker Cloudflare n’a pas renvoyé d’image.');
  return result;
}

async function startVideo(imageUrl, { prompt, seed, preferredProvider } = {}) {
  if (!/^https:\/\//i.test(String(imageUrl || ''))) throw new Error('Une URL HTTPS d’image est requise pour créer la vidéo.');
  return post('/ai/video/start', { imageUrl, prompt, seed, preferredProvider }, 60_000);
}

async function pollVideo(jobId) {
  if (!jobId) throw new Error('Identifiant de génération vidéo absent.');
  return post('/ai/video/poll', { jobId: String(jobId) }, 60_000);
}

module.exports = { generateText, generateImage, startVideo, pollVideo };
