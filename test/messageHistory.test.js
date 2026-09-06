const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Utilise un répertoire temporaire dédié pour ne jamais toucher au vrai
// message_history/ du dépôt, et désactive la sauvegarde GitHub (aucun
// GITHUB_TOKEN/GITHUB_DATA_REPO dans cet environnement de test).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'message-history-test-'));
process.env.MESSAGE_HISTORY_DIR = tmpDir;
delete process.env.GITHUB_TOKEN;
delete process.env.GITHUB_DATA_REPO;

const messageHistory = require('../lib/messageHistory');

test('normalizeContactKey: numéro WhatsApp au format JID', () => {
  assert.equal(messageHistory.normalizeContactKey('2250700000000@s.whatsapp.net'), '2250700000000');
});

test('normalizeContactKey: JID @lid conserve les chiffres', () => {
  assert.equal(messageHistory.normalizeContactKey('987654321@lid'), '987654321');
});

test('normalizeContactKey: username Telegram avec ou sans @', () => {
  assert.equal(messageHistory.normalizeContactKey('@MonCanal'), 'moncanal');
  assert.equal(messageHistory.normalizeContactKey('MonCanal'), 'moncanal');
});

test('normalizeContactKey: id de groupe/canal numérique négatif', () => {
  const key = messageHistory.normalizeContactKey('-1001234567890');
  assert.match(key, /^\d+$/);
  assert.equal(key, '1001234567890');
});

test('normalizeContactKey: numéro avec espaces/tirets/parenthèses', () => {
  assert.equal(messageHistory.normalizeContactKey('+225 07 00-00 (00) 00'), '+2250700000000'.replace('+', ''));
});

test('normalizeContactKey: entrée vide', () => {
  assert.equal(messageHistory.normalizeContactKey(''), '');
  assert.equal(messageHistory.normalizeContactKey(null), '');
});

test('hashTemplate: stable pour le même modèle, différent pour un autre', () => {
  const a = messageHistory.hashTemplate(['text:Bonjour {first_name}']);
  const b = messageHistory.hashTemplate(['text:Bonjour {first_name}']);
  const c = messageHistory.hashTemplate(['text:Un autre message']);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('clampWindowHours: bornes et valeur par défaut', () => {
  assert.equal(messageHistory.clampWindowHours(undefined), messageHistory.DEFAULT_WINDOW_HOURS);
  assert.equal(messageHistory.clampWindowHours(0), messageHistory.DEFAULT_WINDOW_HOURS);
  assert.equal(messageHistory.clampWindowHours(-5), messageHistory.DEFAULT_WINDOW_HOURS);
  assert.equal(messageHistory.clampWindowHours(0.5), messageHistory.MIN_WINDOW_HOURS);
  assert.equal(messageHistory.clampWindowHours(10000), messageHistory.MAX_WINDOW_HOURS);
  assert.equal(messageHistory.clampWindowHours(72), 72);
});

test('pruneEntries: élague les entrées au-delà de la rétention max', () => {
  const now = Date.now();
  const entries = [
    { contactKey: 'a', messageHash: 'h', sentAt: new Date(now - 1000).toISOString() },
    { contactKey: 'b', messageHash: 'h', sentAt: new Date(now - messageHistory.MAX_RETENTION_MS - 1000).toISOString() },
  ];
  const pruned = messageHistory.pruneEntries(entries);
  assert.equal(pruned.length, 1);
  assert.equal(pruned[0].contactKey, 'a');
});

test('saveHistory + loadHistory: aller-retour disque, isolé par canal et par tenant', async () => {
  const entries = [{ contactKey: '2250700000000', messageHash: 'abc', sentAt: new Date().toISOString() }];
  messageHistory.saveHistory('whatsapp', 'tenant-a', entries);

  const reloaded = await messageHistory.loadHistory('whatsapp', 'tenant-a');
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].contactKey, '2250700000000');

  // Jamais partagé avec un autre tenant ni un autre canal (isolation stricte).
  const otherTenant = await messageHistory.loadHistory('whatsapp', 'tenant-b');
  assert.equal(otherTenant.length, 0);
  const otherChannel = await messageHistory.loadHistory('telegram', 'tenant-a');
  assert.equal(otherChannel.length, 0);
});

test('loadHistory: canal invalide rejeté', async () => {
  await assert.rejects(() => messageHistory.loadHistory('sms', 'tenant-a'));
});
