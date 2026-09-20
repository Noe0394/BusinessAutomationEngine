// TEST RUNNER — résolveur d'identité des contacts (ai-engine/contactIdentity.js).
//   node --test test/contact-identity.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.AI_ENGINE_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-ident-'));
const ci = require('../ai-engine/contactIdentity');

const LID = '218374650128374@lid';

test('LID sans aucune autre donnée : jamais un numéro, libellé « non identifié »', () => {
  const r = ci.resolveIdentity({ channel: 'WHATSAPP', jid: LID });
  assert.equal(r.phoneNumber, null);
  assert.equal(r.internationalPhoneNumber, null);
  assert.equal(r.displayName, null);
  assert.equal(r.identitySource, 'unidentified');
  assert.equal(r.label, 'Contact WhatsApp non identifié');
  assert.ok(!/\d{10,}/.test(r.label));
  assert.equal(r.lid, LID);
});

test('LID + pushName : le nom prime', () => {
  const r = ci.resolveIdentity({ jid: LID, pushName: 'Jean Dupont' });
  assert.equal(r.label, 'Jean Dupont');
  assert.equal(r.identitySource, 'whatsapp_pushname');
  assert.equal(r.phoneNumber, null);
});

test('JID téléphonique : vrai numéro, affichage humain, aucun indicatif ajouté', () => {
  const r = ci.resolveIdentity({ jid: '22670123456@s.whatsapp.net' });
  assert.equal(r.phoneNumber, '22670123456');
  assert.equal(r.internationalPhoneNumber, '+22670123456');
  assert.equal(r.label, '+226 70 12 34 56');
  assert.equal(r.identitySource, 'phone_number');
});

test('suffixe appareil ":12" ignoré pour le numéro', () => {
  const r = ci.resolveIdentity({ jid: '22670123456:12@s.whatsapp.net' });
  assert.equal(r.phoneNumber, '22670123456');
});

test('LID + vrai JID téléphonique fourni par WhatsApp (senderPn) : numéro connu', () => {
  const r = ci.resolveIdentity({ jid: LID, altJids: ['22507080910@s.whatsapp.net'] });
  assert.equal(r.phoneNumber, '22507080910');
  assert.equal(r.lid, LID);
  assert.match(r.label, /^\+225 /);
});

test('un nom qui est une suite de chiffres / un JID est rejeté', () => {
  assert.equal(ci.cleanName('218374650128374'), null);
  assert.equal(ci.cleanName('218374650128374@lid'), null);
  assert.equal(ci.cleanName('+226 70 12 34 56'), null);
  assert.equal(ci.cleanName('Marie'), 'Marie');
  const r = ci.resolveIdentity({ jid: LID, pushName: '218374650128374' });
  assert.equal(r.label, 'Contact WhatsApp non identifié');
});

test('priorité : nom du répertoire > pushName > nom connu de Cyrus > numéro', () => {
  const r = ci.resolveIdentity({ jid: '22670123456@s.whatsapp.net', contactName: 'Papa', pushName: 'Jean', knownName: 'J.D.' });
  assert.equal(r.displayName, 'Papa');
  assert.equal(r.labelWithPhone, 'Papa (+226 70 12 34 56)');
  const r2 = ci.resolveIdentity({ jid: '22670123456@s.whatsapp.net', knownName: 'Awa' });
  assert.equal(r2.label, 'Awa');
});

test('id trop long pour un numéro E.164 dans un JID téléphonique : pas un numéro', () => {
  const r = ci.resolveIdentity({ jid: '12345678901234567890@s.whatsapp.net' });
  assert.equal(r.phoneNumber, null);
});

test('Telegram : un id numérique n’est jamais un téléphone', () => {
  const r = ci.resolveIdentity({ channel: 'TELEGRAM', jid: '123456789', username: 'jdupont' });
  assert.equal(r.phoneNumber, null);
  assert.equal(r.label, '@jdupont');
  const r2 = ci.resolveIdentity({ channel: 'TELEGRAM', jid: '123456789' });
  assert.equal(r2.label, 'Contact Telegram non identifié');
});

test('groupe reconnu comme tel', () => {
  const r = ci.resolveIdentity({ jid: '120363041234567890@g.us' });
  assert.equal(r.isGroup, true);
  assert.equal(r.phoneNumber, null);
});

test('annuaire : un même contact vu par LID puis par numéro garde le même contactId et le nom appris', async () => {
  const a = await ci.resolveContact('T1', { jid: LID, pushName: 'Marie K' });
  assert.equal(a.label, 'Marie K');
  // plus tard WhatsApp fournit le vrai numéro pour ce LID
  const b = await ci.resolveContact('T1', { jid: LID, altJids: ['22670999888@s.whatsapp.net'] });
  assert.equal(b.contactId, a.contactId);
  assert.equal(b.label, 'Marie K');
  assert.equal(b.phoneNumber, '22670999888');
  // et un message ultérieur sous le numéro seul retrouve le nom
  const c = await ci.resolveContact('T1', { jid: '22670999888@s.whatsapp.net' });
  assert.equal(c.contactId, a.contactId);
  assert.equal(c.label, 'Marie K');
  // isolation par tenant
  const d = await ci.resolveContact('T2', { jid: '22670999888@s.whatsapp.net' });
  assert.equal(d.displayName, null);
});

test('deux contacts de même nom restent distincts (identifiants internes)', async () => {
  const a = await ci.resolveContact('T3', { jid: '22670000001@s.whatsapp.net', pushName: 'Jean' });
  const b = await ci.resolveContact('T3', { jid: '22670000002@s.whatsapp.net', pushName: 'Jean' });
  assert.notEqual(a.contactId, b.contactId);
});

test('scrubTechnicalIds retire JID/LID explicites d’un texte utilisateur', () => {
  const t = ci.scrubTechnicalIds(`Message de ${LID} et 22670123456@s.whatsapp.net`);
  assert.ok(!t.includes('@lid') && !t.includes('@s.whatsapp.net'));
});
