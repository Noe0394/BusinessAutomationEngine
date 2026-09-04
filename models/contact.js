const fs = require('fs');
const path = require('path');

// "Table/Modèle Contact" du module de Capture Automatique de Prospects.
// Même principe de persistance par fichier JSON que le reste du projet (pas
// de base de données ici) — voir queues/scheduled_messages.js pour le même
// choix motivé.
const STORE_PATH = process.env.CONTACTS_PATH || path.join(__dirname, '..', 'contacts.json');

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (err) {
    return [];
  }
}

function writeAll(list) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(list, null, 2), 'utf8');
}

function list({ keyword, source } = {}) {
  let all = readAll().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  if (keyword) {
    all = all.filter((c) => c.keyword === keyword);
  }
  if (source) {
    all = all.filter((c) => c.source === source);
  }
  return all;
}

function get(id) {
  return readAll().find((c) => c.id === id) || null;
}

/**
 * Crée ou met à jour (par PSID) le profil d'un prospect capturé depuis un
 * commentaire ou un message Messenger. "keyword" n'est mis à jour que si un
 * mot-clé a effectivement été détecté sur cette interaction — un contact
 * déjà qualifié par un mot-clé précédent ne perd pas cette thématique s'il
 * écrit ensuite un message qui n'en contient aucun.
 */
function upsertFromLead({ psid, firstName, lastName, name, source, sourceText, postId, keyword }) {
  const all = readAll();
  const idx = all.findIndex((c) => c.psid === psid);
  const now = new Date().toISOString();
  const resolvedName = name || [firstName, lastName].filter(Boolean).join(' ') || null;

  if (idx === -1) {
    const contact = {
      id: `contact_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      psid,
      firstName: firstName || null,
      lastName: lastName || null,
      name: resolvedName,
      source,
      lastText: sourceText || '',
      postId: postId || null,
      keyword: keyword || null,
      autoReplied: false,
      createdAt: now,
      updatedAt: now,
    };
    all.push(contact);
    writeAll(all);
    return contact;
  }

  const updated = {
    ...all[idx],
    firstName: firstName || all[idx].firstName,
    lastName: lastName || all[idx].lastName,
    name: resolvedName || all[idx].name,
    source,
    lastText: sourceText || all[idx].lastText,
    postId: postId || all[idx].postId,
    keyword: keyword || all[idx].keyword,
    updatedAt: now,
  };
  all[idx] = updated;
  writeAll(all);
  return updated;
}

function markAutoReplied(id) {
  const all = readAll();
  const idx = all.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  all[idx] = { ...all[idx], autoReplied: true };
  writeAll(all);
  return all[idx];
}

module.exports = { list, get, upsertFromLead, markAutoReplied };
