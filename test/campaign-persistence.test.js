'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const persistence = require('../queues/campaignPersistence');
const { CampaignEngine } = require('../queues/campaignEngine');
const { TelegramCampaignEngine } = require('../queues/telegramCampaignEngine');

test('les états et médias de campagne sont chiffrés au miroir distant et déchiffrables après redémarrage', () => {
  const previous = {
    mirror: process.env.GITHUB_MIRROR_USER_DATA,
    vault: process.env.SECRET_VAULT_KEY,
  };
  process.env.GITHUB_MIRROR_USER_DATA = 'true';
  process.env.SECRET_VAULT_KEY = 'campaign-persistence-test-key';
  try {
    const plain = JSON.stringify({ campaigns: [{ recipients: ['+22501020304'], message: 'secret test' }] });
    const encoded = persistence.encodeText(plain);
    assert.equal(JSON.parse(encoded)._cyrusEncrypted, 1);
    assert.deepEqual(persistence.decodeText(encoded), { text: plain, encrypted: true });

    const binary = Buffer.from('contenu Excel de test');
    const encryptedBinary = persistence.encodeBuffer(binary);
    assert.equal(persistence.isEncryptedBuffer(encryptedBinary), true);
    assert.deepEqual(persistence.decodeBuffer(encryptedBinary), binary);
  } finally {
    if (previous.mirror === undefined) delete process.env.GITHUB_MIRROR_USER_DATA; else process.env.GITHUB_MIRROR_USER_DATA = previous.mirror;
    if (previous.vault === undefined) delete process.env.SECRET_VAULT_KEY; else process.env.SECRET_VAULT_KEY = previous.vault;
  }
});

test('un envoi interrompu reste non confirmé et ne peut pas être rejoué après reprise', () => {
  for (const Engine of [CampaignEngine, TelegramCampaignEngine]) {
    const campaign = {
      results: [
        { to: 'contact-1', status: 'sending' },
        { to: 'contact-2', status: 'pending' },
      ],
      nextIndex: 0,
      sent: 0,
      unconfirmed: 0,
    };

    const recovered = Engine.prototype._recoverInFlight(campaign);
    assert.equal(recovered, 1);
    assert.equal(campaign.results[0].status, 'unconfirmed');
    assert.equal(campaign.nextIndex, 1);
    assert.equal(campaign.sent, 1);
    assert.equal(campaign.unconfirmed, 1);

    assert.equal(Engine.prototype._recoverInFlight(campaign), 0);
    assert.equal(campaign.sent, 1);
    assert.equal(campaign.unconfirmed, 1);
  }
});
