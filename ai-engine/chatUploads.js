// CHAT UPLOADS — ai-engine/chatUploads.js
// ---------------------------------------------------------------------------
// Import de fichiers / médias DANS la discussion du Chat Intelligent. Tout type
// de fichier est accepté. Pour les fichiers TEXTE (txt, csv, json, md, log…),
// le contenu est extrait et fourni à l'IA (elle peut donc réellement s'en
// servir). Pour les autres types (image, audio, vidéo, binaire), le fichier est
// stocké et son existence est signalée à l'IA (nom + type) — sans invention :
// avec le modèle texte actuel, l'IA ne « voit » pas le contenu d'une image.
//
// Stockage : binaire sur disque (per-tenant, éphémère au rebuild — c'est un
// contexte de discussion) ; métadonnées + texte extrait via storageAdapter
// (persistant). Déterministe, aucun appel IA ici.

const fs = require('fs');
const path = require('path');
const storageAdapter = require('./storageAdapter');

const NAMESPACE = 'chat_uploads';
const MAX_TEXT_CHARS = 12000; // borne l'extraction pour ne pas gonfler le contexte
const MAX_FILES_PER_TENANT = 300;

function sanitize(id) { return String(id || '').trim().replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown'; }
function uid() { return 'f_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function baseDir(tenant) {
  const root = process.env.AI_ENGINE_STORAGE_DIR || path.join(__dirname, '..', 'ai_engine_data');
  return path.join(root, 'chat_uploads', sanitize(tenant));
}

function isTextual(mimetype, name) {
  const mt = String(mimetype || '').toLowerCase();
  if (mt.startsWith('text/')) return true;
  if (/(json|csv|xml|markdown|javascript|x-yaml|x-www-form-urlencoded)/.test(mt)) return true;
  return /\.(txt|csv|md|json|log|xml|yaml|yml|ini|tsv)$/i.test(String(name || ''));
}

async function loadMeta(tenant) {
  return storageAdapter.get(NAMESPACE, sanitize(tenant), { tenant: sanitize(tenant), files: {} });
}

// Enregistre un fichier importé. Renvoie une fiche publique (jamais le binaire).
async function save(tenant, file) {
  const { originalname, mimetype, buffer } = file || {};
  const id = uid();
  const dir = baseDir(tenant);
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, id), buffer); } catch (e) { /* disque best-effort */ }
  const textual = isTextual(mimetype, originalname);
  let text = null;
  if (textual && buffer) { try { text = buffer.toString('utf8').slice(0, MAX_TEXT_CHARS); } catch (e) { text = null; } }
  const meta = {
    id, name: String(originalname || 'fichier').slice(0, 200),
    type: String(mimetype || 'application/octet-stream'),
    size: buffer ? buffer.length : 0,
    textual, hasText: !!text, text: text || null,
    at: new Date().toISOString(),
  };
  const doc = await loadMeta(tenant);
  doc.files = doc.files || {};
  doc.files[id] = meta;
  // borne : garde les N plus récents
  const ids = Object.keys(doc.files).sort((a, b) => String(doc.files[b].at).localeCompare(String(doc.files[a].at)));
  for (const old of ids.slice(MAX_FILES_PER_TENANT)) delete doc.files[old];
  storageAdapter.set(NAMESPACE, sanitize(tenant), doc);
  return { id: meta.id, name: meta.name, type: meta.type, size: meta.size, textual: meta.textual, hasText: meta.hasText };
}

async function get(tenant, id) {
  const doc = await loadMeta(tenant);
  return (doc.files && doc.files[id]) || null;
}

// Construit le bloc de contexte à donner à l'IA pour une liste de pièces jointes
// (contenu réel des fichiers texte ; simple signalement pour les autres).
async function buildContext(tenant, attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (!list.length) return '';
  const parts = [];
  for (const a of list) {
    const meta = await get(tenant, a && a.id);
    if (!meta) { parts.push(`- Fichier joint : ${(a && a.name) || 'inconnu'} (référence introuvable).`); continue; }
    if (meta.hasText && meta.text) {
      parts.push(`- Fichier joint « ${meta.name} » (${meta.type}). Contenu :\n"""\n${meta.text}\n"""`);
    } else {
      parts.push(`- Fichier joint « ${meta.name} » (${meta.type}, ${meta.size} octets) — contenu binaire non lisible par le modèle texte actuel : n'invente pas ce qu'il contient, demande des précisions si besoin.`);
    }
  }
  return 'PIÈCES JOINTES importées par l\'utilisateur dans la discussion :\n' + parts.join('\n');
}

module.exports = { save, get, buildContext, isTextual, NAMESPACE };
