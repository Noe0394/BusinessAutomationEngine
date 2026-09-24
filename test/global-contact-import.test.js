'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-global-contact-import-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;
process.env.CLOUDFLARE_ADMIN_SECRET = 'test-contact-durable-key';
const sync = require('../ai-engine/globalContactSync');
sync.request = async (_path, opts = {}) => {
  const phones = opts.body && opts.body.phones || [];
  return { ok: true, results: phones.map((phone) => ({ phone, exists: false, country: { countryCode: 'CI' } })) };
};
const importer = require('../ai-engine/globalContactImport');
const durable = require('../ai-engine/contactDurableStore');

test('file de reprise : les contacts sont chiffrés et déchiffrables avec la clé serveur', () => {
  const value = { events: [{ phone: '+225070000001', name: 'Awa' }] };
  const encrypted = durable.encrypt(value);
  assert.equal(encrypted.includes('+225070000001'), false);
  assert.deepEqual(durable.decrypt(encrypted), value);
});

test('import D1 : valide, déduplique et rejette les numéros répétés avant la file centrale', async () => {
  const file = {
    originalname: 'contacts.csv', mimetype: 'text/csv',
    buffer: Buffer.from('Name,Phone\nAwa,+225070000001\nDoublon,+225070000001\nFaux,00000000000\n', 'utf8'),
  };
  const report = await importer.preview(file, { channel: 'WHATSAPP' });
  assert.equal(report.totalFound, 3);
  assert.equal(report.uniqueContacts, 1);
  assert.equal(report.duplicatesInFile, 1);
  assert.equal(report.invalid, 1);
  assert.equal(report.newContacts, 1);
});
