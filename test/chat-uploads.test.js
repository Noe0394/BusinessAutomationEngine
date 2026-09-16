// TEST — import de fichiers dans la discussion : contenu texte extrait pour
// l'IA ; binaire signalé sans invention. Déterministe, aucun appel IA.
//   node --test test/chat-uploads.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-upl-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;

const chatUploads = require('../ai-engine/chatUploads');
const T = 'tUpl';

test('fichier texte : contenu extrait et fourni à l\'IA', async () => {
  const ref = await chatUploads.save(T, { originalname: 'liste.csv', mimetype: 'text/csv', buffer: Buffer.from('nom,tel\nAwa,22600000001\n', 'utf8') });
  assert.ok(ref.id);
  assert.equal(ref.hasText, true);
  const ctx = await chatUploads.buildContext(T, [{ id: ref.id, name: ref.name, type: ref.type }]);
  assert.match(ctx, /liste\.csv/);
  assert.match(ctx, /Awa,22600000001/);
});

test('fichier binaire (image) : signalé, jamais inventé', async () => {
  const ref = await chatUploads.save(T, { originalname: 'photo.jpg', mimetype: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]) });
  assert.equal(ref.hasText, false);
  const ctx = await chatUploads.buildContext(T, [{ id: ref.id, name: ref.name, type: ref.type }]);
  assert.match(ctx, /photo\.jpg/);
  assert.match(ctx, /n'invente pas/i);
});

test('référence inconnue -> signalée, pas de crash', async () => {
  const ctx = await chatUploads.buildContext(T, [{ id: 'nope', name: 'x.bin' }]);
  assert.match(ctx, /introuvable/i);
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });
