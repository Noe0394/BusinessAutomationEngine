// test/memory-7days.test.js — Tests de la mémoire conversationnelle 7 jours
// ---------------------------------------------------------------------------
// Valide : fenêtre glissante stricte, format étendu, index conversationnel,
// recherche déterministe, nettoyage, compatibilité ascendante.
// Utilise un répertoire temporaire isolé (jamais les données réelles).

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Prépare un dossier temporaire pour la couche de stockage
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mem7d-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;

// Recharge le module avec le TMP (les modules sont cache-sync, le TMP est lu
// au chargement — le require assure la bonne설정).
const messageHistory = require('../ai-engine/messageHistory');

function tenant() { return `test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`; }
function ms(d) { return Date.now() - d * 86400000; } // date il y a d jours

describe('messageHistory — fenêtre glissante 7 jours', () => {

  it('RETENTION_DAYS vaut 7', () => {
    assert.equal(messageHistory.RETENTION_DAYS, 7);
  });

  it('enregistre un message avec le format étendu complet', async () => {
    const t = tenant();
    const entry = await messageHistory.record(t, {
      channel: 'WHATSAPP', direction: 'in', party: '22670001111@c.us',
      name: 'Amadou', text: 'Bonjour', ts: Math.floor(Date.now() / 1000),
      chatId: '22670001111@c.us', hasMedia: false,
      messageId: 'msg-abc-123', senderId: '22670001111@c.us',
      senderName: 'Amadou', senderPhone: '22670001111',
      isGroup: false, groupName: null,
      messageType: 'text', mediaId: null,
    });
    assert.ok(entry, 'record retourne une entrée');
    assert.equal(entry.channel, 'WHATSAPP');
    assert.equal(entry.direction, 'in');
    assert.equal(entry.party, '22670001111@c.us');
    assert.equal(entry.number, '22670001111');
    assert.equal(entry.messageId, 'msg-abc-123');
    assert.equal(entry.senderId, '22670001111@c.us');
    assert.equal(entry.senderPhone, '22670001111');
    assert.equal(entry.isGroup, false);
    assert.equal(entry.messageType, 'text');
    assert.equal(entry.text, 'Bonjour');
  });

  it('détecte un groupe WhatsApp par le suffixe @g.us', async () => {
    const t = tenant();
    const entry = await messageHistory.record(t, {
      channel: 'WHATSAPP', direction: 'in', party: '1203630123456@g.us',
      name: 'Groupe Test', text: 'Salut tout le monde',
      ts: Math.floor(Date.now() / 1000),
      chatId: '1203630123456@g.us', hasMedia: false,
      messageId: 'grp-msg-001', senderId: '22670009999@c.us',
      senderName: 'Fatima', isGroup: true,
      groupName: 'Groupe Test', participants: ['22670001111@c.us', '22670009999@c.us'],
      messageType: 'text',
    });
    assert.equal(entry.isGroup, true);
    assert.equal(entry.groupId, '1203630123456@g.us');
    assert.equal(entry.groupName, 'Groupe Test');
    assert.equal(entry.senderId, '22670009999@c.us');
    assert.equal(entry.senderPhone, '22670009999');
    assert.ok(Array.isArray(entry.participants));
    assert.equal(entry.participants.length, 2);
  });

  it('détecte un groupe Telegram par l\'ID négatif', async () => {
    const t = tenant();
    const entry = await messageHistory.record(t, {
      channel: 'TELEGRAM', direction: 'in', party: '-1001234567890',
      name: 'Channel CYRUS', text: 'Nouvelle actu',
      ts: Math.floor(Date.now() / 1000),
      chatId: '-1001234567890', hasMedia: false,
      messageId: 'tg-001', senderId: '987654321',
      senderName: 'Admin', isGroup: true,
      groupName: 'Channel CYRUS', messageType: 'text',
    });
    assert.equal(entry.isGroup, true);
    assert.equal(entry.groupId, '-1001234567890');
    assert.equal(entry.channel, 'TELEGRAM');
  });

  it('getConversation filtre par chatId et par numéro', async () => {
    const t = tenant();
    const now = Math.floor(Date.now() / 1000);
    await messageHistory.record(t, { channel: 'WHATSAPP', direction: 'in', party: '22670001111@c.us', name: 'A', text: 'msg1', ts: now - 10, chatId: '22670001111@c.us' });
    await messageHistory.record(t, { channel: 'WHATSAPP', direction: 'out', party: '22670001111@c.us', name: null, text: 'rép1', ts: now - 5, chatId: '22670001111@c.us' });
    await messageHistory.record(t, { channel: 'WHATSAPP', direction: 'in', party: '22699998888@c.us', name: 'B', text: 'msg2', ts: now, chatId: '22699998888@c.us' });
    // Par chatId
    const byChat = await messageHistory.getConversation(t, 'WHATSAPP', '22670001111@c.us');
    assert.equal(byChat.length, 2);
    assert.equal(byChat[0].text, 'msg1');
    // Par numéro
    const byNum = await messageHistory.getConversation(t, 'WHATSAPP', '22699998888');
    assert.equal(byNum.length, 1);
    assert.equal(byNum[0].text, 'msg2');
  });

  it('getConversationMessages renvoie les messages d\'un chatId précis', async () => {
    const t = tenant();
    const now = Math.floor(Date.now() / 1000);
    await messageHistory.record(t, { channel: 'WHATSAPP', direction: 'in', party: '22670001111@c.us', name: 'A', text: 'a1', ts: now - 5, chatId: '22670001111@c.us' });
    await messageHistory.record(t, { channel: 'WHATSAPP', direction: 'in', party: '1203630123456@g.us', name: 'G', text: 'g1', ts: now, chatId: '1203630123456@g.us' });
    const msgs = await messageHistory.getConversationMessages(t, 'WHATSAPP', '22670001111@c.us');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].text, 'a1');
  });

  it('getGroupMessages renvoie les messages d\'un groupe avec expéditeur', async () => {
    const t = tenant();
    const now = Math.floor(Date.now() / 1000);
    await messageHistory.record(t, { channel: 'WHATSAPP', direction: 'in', party: '1203630123456@g.us', name: 'Groupe', text: 'm1', ts: now - 10, chatId: '1203630123456@g.us', senderId: '22670001111@c.us', senderName: 'Amadou', isGroup: true, groupName: 'Groupe' });
    await messageHistory.record(t, { channel: 'WHATSAPP', direction: 'in', party: '1203630123456@g.us', name: 'Groupe', text: 'm2', ts: now, chatId: '1203630123456@g.us', senderId: '22670009999@c.us', senderName: 'Fatima', isGroup: true, groupName: 'Groupe' });
    const msgs = await messageHistory.getGroupMessages(t, 'WHATSAPP', '1203630123456@g.us');
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].senderName, 'Amadou');
    assert.equal(msgs[1].senderName, 'Fatima');
  });

  it('index conversationnel reflète les conversations', async () => {
    const t = tenant();
    const now = Math.floor(Date.now() / 1000);
    await messageHistory.record(t, { channel: 'WHATSAPP', direction: 'in', party: '22670001111@c.us', name: 'Amadou', text: 'a1', ts: now, chatId: '22670001111@c.us' });
    await messageHistory.record(t, { channel: 'WHATSAPP', direction: 'in', party: '1203630123456@g.us', name: 'Groupe', text: 'g1', ts: now, chatId: '1203630123456@g.us', isGroup: true, groupName: 'Groupe Test' });
    const convs = await messageHistory.listConversations(t, 'WHATSAPP');
    assert.ok(convs.length >= 2, `au moins 2 conversations, trouvé ${convs.length}`);
    const ind = convs.find((c) => c.type === 'INDIVIDUAL');
    const grp = convs.find((c) => c.type === 'GROUP');
    assert.ok(ind, 'trouve la conversation individuelle');
    assert.ok(grp, 'trouve la conversation de groupe');
    assert.equal(ind.contactName, 'Amadou');
    assert.equal(grp.groupName, 'Groupe Test');
    assert.equal(ind.messageCount, 1);
    assert.equal(grp.messageCount, 1);
  });

  it('findConversations recherche par nom', async () => {
    const t = tenant();
    const now = Math.floor(Date.now() / 1000);
    await messageHistory.record(t, { channel: 'WHATSAPP', direction: 'in', party: '22670001111@c.us', name: 'Amadou', text: 'a1', ts: now, chatId: '22670001111@c.us' });
    await messageHistory.record(t, { channel: 'WHATSAPP', direction: 'in', party: '22699998888@c.us', name: 'Ibrahim', text: 'b1', ts: now, chatId: '22699998888@c.us' });
    const found = await messageHistory.findConversations(t, { query: 'amad' });
    assert.ok(found.length >= 1, 'trouve Amadou');
    assert.ok(found.some((c) => c.contactName === 'Amadou'));
    assert.ok(!found.some((c) => c.contactName === 'Ibrahim'), 'n\'inclut pas Ibrahim');
  });

  it('prune retire les messages hors fenêtre 7 jours', () => {
    const cutoff = Date.now() - 7 * 86400000;
    const msgs = [
      { tsMs: cutoff - 1000, text: 'ancien' },  // hors fenêtre
      { tsMs: cutoff + 1000, text: 'récent' },   // dans la fenêtre
      { tsMs: Date.now(), text: 'maintenant' },
    ];
    const kept = messageHistory.prune(msgs);
    assert.ok(kept.every((m) => m.text !== 'ancien'), 'le message ancien est retiré');
    assert.equal(kept.length, 2);
  });

  it('prune détruit TOUT ce qui est hors fenêtre (aucun filet de sécurité)', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({ tsMs: 1000 + i, text: `m${i}` }));
    assert.equal(messageHistory.prune(msgs).length, 0, 'données de > 7 jours détruites');
  });

  it('prune : bornes exactes de la fenêtre 7×24 h', () => {
    const NOW = Date.now();
    const W = 7 * 24 * 3600 * 1000;
    const kept = messageHistory.prune([
      { tsMs: NOW - W - 1000, text: 'cutoff-1s' },
      { tsMs: NOW - W, text: 'cutoff' },
      { tsMs: NOW - 1000, text: 'now-1s' },
      { tsMs: NOW + 1000, text: 'now+1s' },
    ], NOW).map((m) => m.text);
    assert.deepEqual(kept, ['cutoff', 'now-1s']);
  });

  it('cleanupExpired retire les messages hors fenêtre', async () => {
    const t = tenant();
    // Enregistre un message "ancien" (forcé hors fenêtre via tsMs)
    const doc = { tenantId: t, channel: 'WHATSAPP', messages: [
      { channel: 'WHATSAPP', direction: 'in', party: '22670001111@c.us', text: 'ancien', tsMs: ms(10), ts: Math.floor(ms(10) / 1000), chatId: '22670001111@c.us', number: '22670001111' },
      { channel: 'WHATSAPP', direction: 'in', party: '22670002222@c.us', text: 'récent', tsMs: ms(2), ts: Math.floor(ms(2) / 1000), chatId: '22670002222@c.us', number: '22670002222' },
    ], updatedAt: new Date().toISOString() };
    const docId = `${t}__WHATSAPP`.replace(/[^A-Za-z0-9_.-]/g, '_');
    const storageAdapter = require('../ai-engine/storageAdapter');
    await storageAdapter.set('message_history', docId, doc);
    const report = await messageHistory.cleanupExpired(t);
    assert.ok(report.removedMessages >= 1, 'au moins 1 message retiré');
    // Vérifie que le message récent est toujours là
    const after = await messageHistory.getConversationMessages(t, 'WHATSAPP', '22670002222@c.us');
    assert.ok(after.length >= 1, 'message récent toujours présent après nettoyage');
  });

  it('sweepAllExpired fonctionne sans erreur', async () => {
    const report = await messageHistory.sweepAllExpired();
    assert.ok(report && typeof report.removedMessages === 'number', 'rapport valide');
  });

  it('getLastIncoming renvoie le dernier message entrant', async () => {
    const t = tenant();
    const now = Math.floor(Date.now() / 1000);
    await messageHistory.record(t, { channel: 'WHATSAPP', direction: 'in', party: '22670001111@c.us', name: 'A', text: 'premier', ts: now - 10, chatId: '22670001111@c.us' });
    await messageHistory.record(t, { channel: 'WHATSAPP', direction: 'out', party: '22670001111@c.us', text: 'réponse', ts: now - 5, chatId: '22670001111@c.us' });
    await messageHistory.record(t, { channel: 'WHATSAPP', direction: 'in', party: '22670001111@c.us', name: 'A', text: 'deuxième', ts: now, chatId: '22670001111@c.us' });
    const last = await messageHistory.getLastIncoming(t, 'WHATSAPP');
    assert.equal(last.text, 'deuxième');
    assert.equal(last.direction, 'in');
  });

  it('getSince ne renvoie que les messages de la fenêtre', async () => {
    const t = tenant();
    const now = Math.floor(Date.now() / 1000);
    await messageHistory.record(t, { channel: 'WHATSAPP', direction: 'in', party: '22670001111@c.us', name: 'A', text: 'récent', ts: now, chatId: '22670001111@c.us' });
    const recent = await messageHistory.getSince(t, 'WHATSAPP', 7);
    assert.ok(recent.length >= 1, 'au moins 1 message dans la fenêtre 7j');
    assert.ok(recent.every((m) => m.tsMs >= Date.now() - 7 * 86400000));
  });

  it('getRecent retourne les messages du plus récent au plus ancien', async () => {
    const t = tenant();
    const now = Math.floor(Date.now() / 1000);
    await messageHistory.record(t, { channel: 'WHATSAPP', direction: 'in', party: '22670001111@c.us', name: 'A', text: 'premier', ts: now - 10, chatId: '22670001111@c.us' });
    await messageHistory.record(t, { channel: 'WHATSAPP', direction: 'in', party: '22670001111@c.us', name: 'A', text: 'deuxième', ts: now, chatId: '22670001111@c.us' });
    const recent = await messageHistory.getRecent(t, 'WHATSAPP', 10);
    assert.ok(recent.length >= 2);
    assert.equal(recent[0].text, 'deuxième');
    assert.equal(recent[1].text, 'premier');
  });

  it('record retourne null si party manquant', async () => {
    const t = tenant();
    const entry = await messageHistory.record(t, { channel: 'WHATSAPP', direction: 'in', text: 'test' });
    assert.equal(entry, null);
  });

  it('normalizeSearch retire accents et ponctuation', () => {
    const n = messageHistory.normalizeSearch;
    assert.equal(n('Amadou'), 'amadou');
    assert.equal(n('Amadou Ouedraogo'), 'amadououedraogo');
    assert.equal(n('Groupe #1'), 'groupe1');
    assert.equal(n(null), '');
  });

  it('deriveConversationType identifie INDIVIDUAL et GROUP', () => {
    const d = messageHistory.deriveConversationType;
    assert.equal(d('22670001111@c.us'), 'INDIVIDUAL');
    assert.equal(d('1203630123456@g.us'), 'GROUP');
    assert.equal(d('1203630123456@broadcast'), 'GROUP');
    assert.equal(d('-1001234567890'), 'GROUP');
    assert.equal(d('22670001111'), 'INDIVIDUAL');
  });

  it('message sortant est enregistré avec direction=out', async () => {
    const t = tenant();
    const entry = await messageHistory.record(t, {
      channel: 'WHATSAPP', direction: 'out', party: '22670001111@c.us',
      text: 'réponse auto', ts: Math.floor(Date.now() / 1000),
      chatId: '22670001111@c.us', confirmationId: 'conf-001',
    });
    assert.equal(entry.direction, 'out');
    assert.equal(entry.confirmationId, 'conf-001');
    const recent = await messageHistory.getRecent(t, 'WHATSAPP', 1);
    assert.equal(recent[0].direction, 'out');
  });

  it('compatibilité : tous les exports historiques existent', () => {
    const fns = ['record', 'getRecent', 'getLastIncoming', 'getConversation', 'getSince'];
    for (const fn of fns) {
      assert.equal(typeof messageHistory[fn], 'function', `${fn} exporté`);
    }
    assert.equal(typeof messageHistory.NAMESPACE, 'string');
    assert.equal(typeof messageHistory.RETENTION_DAYS, 'number');
  });
});

describe('messageHistory — exports 7 jours', () => {
  it('exports les nouvelles fonctions', () => {
    const fns = ['listConversations', 'findConversations', 'getConversationMessages',
      'getGroupMessages', 'cleanupExpired', 'sweepAllExpired', 'startMaintenance', 'stopMaintenance',
      'updateConversationIndex', 'normalizeSearch', 'deriveConversationType', 'prune'];
    for (const fn of fns) {
      assert.equal(typeof messageHistory[fn], 'function', `${fn} exporté`);
    }
    assert.equal(messageHistory.INDEX_NAMESPACE, 'conversation_index');
    assert.equal(messageHistory.MAX_MESSAGES, 2000);
  });
});
