const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-tenant-isolation-'));
process.env.FB_TOKEN_PATH = path.join(root, 'facebook-token.json');
process.env.FB_GROUPS_PATH = path.join(root, 'facebook-groups.json');
process.env.YOUTUBE_TOKEN_PATH = path.join(root, 'youtube-token.json');
process.env.TIKTOK_TOKEN_PATH = path.join(root, 'tiktok-token.json');
process.env.CONTACTS_PATH = path.join(root, 'contacts.json');
process.env.KEYWORD_RULES_PATH = path.join(root, 'keyword-rules.json');
process.env.FB_PAGE_ACCESS_TOKEN = 'ADMIN_ONLY_FACEBOOK_TOKEN';
process.env.YOUTUBE_REFRESH_TOKEN = 'ADMIN_ONLY_YOUTUBE_TOKEN';
process.env.TIKTOK_ACCESS_TOKEN = 'ADMIN_ONLY_TIKTOK_TOKEN';

const ContactStore = require('../models/contact');
const KeywordRules = require('../models/keyword_rules');
const FacebookMessengerAdapter = require('../adapters/facebook');
const MediaPublisherAdapter = require('../adapters/media_publisher');

test('ACCOUNT_A, ACCOUNT_B and ACCOUNT_C keep Facebook CRM and rules isolated', () => {
  for (const tenantId of ['ACCOUNT_A', 'ACCOUNT_B', 'ACCOUNT_C']) {
    ContactStore.forTenant(tenantId).upsertFromLead({ psid: `${tenantId}_PSID`, source: 'message', sourceText: tenantId });
    KeywordRules.forTenant(tenantId).create({ keyword: tenantId, replyMessage: `${tenantId} reply` });
  }

  for (const owner of ['ACCOUNT_A', 'ACCOUNT_B', 'ACCOUNT_C']) {
    const contacts = ContactStore.forTenant(owner).list();
    const rules = KeywordRules.forTenant(owner).list();
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0].psid, `${owner}_PSID`);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].keyword, owner);
    for (const other of ['ACCOUNT_A', 'ACCOUNT_B', 'ACCOUNT_C'].filter((id) => id !== owner)) {
      assert.equal(ContactStore.forTenant(owner).get(`${other}_PSID`), null);
      assert.equal(KeywordRules.forTenant(owner).findMatch(other), null);
    }
  }
  assert.equal(ContactStore.forTenant('ACCOUNT_A').list().some((c) => c.psid === 'ACCOUNT_B_PSID'), false);
});

test('Facebook and publishing credentials, groups and temporary media are tenant scoped', () => {
  const facebookA = new FacebookMessengerAdapter({ tenantId: 'ACCOUNT_A' });
  const facebookB = new FacebookMessengerAdapter({ tenantId: 'ACCOUNT_B' });
  const facebookC = new FacebookMessengerAdapter({ tenantId: 'ACCOUNT_C' });
  const adminFacebook = new FacebookMessengerAdapter({ tenantId: '__admin__' });

  facebookA.addManagedGroup('A_GROUP', 'A');
  facebookB.addManagedGroup('B_GROUP', 'B');
  facebookC.addManagedGroup('C_GROUP', 'C');
  assert.deepEqual(facebookA.getManagedGroups().map((g) => g.id), ['A_GROUP']);
  assert.deepEqual(facebookB.getManagedGroups().map((g) => g.id), ['B_GROUP']);
  assert.deepEqual(facebookC.getManagedGroups().map((g) => g.id), ['C_GROUP']);
  assert.deepEqual(adminFacebook.getManagedGroups(), []);
  assert.equal(facebookA.getPageAccessToken(), null);
  assert.equal(adminFacebook.getPageAccessToken(), 'ADMIN_ONLY_FACEBOOK_TOKEN');

  const mediaA = new MediaPublisherAdapter({ tenantId: 'ACCOUNT_A' });
  const mediaB = new MediaPublisherAdapter({ tenantId: 'ACCOUNT_B' });
  const mediaC = new MediaPublisherAdapter({ tenantId: 'ACCOUNT_C' });
  const adminMedia = new MediaPublisherAdapter({ tenantId: '__admin__' });
  assert.equal(mediaA.isYoutubeConfigured(), false);
  assert.equal(mediaB.isTikTokConfigured(), false);
  assert.equal(adminMedia.getYoutubeRefreshToken(), 'ADMIN_ONLY_YOUTUBE_TOKEN');
  assert.equal(adminMedia.getTikTokAccessToken(), 'ADMIN_ONLY_TIKTOK_TOKEN');

  const token = mediaA.registerTempVideo(Buffer.from('A-only'), 'video/mp4');
  assert.equal(mediaA.getTempVideo(token).buffer.toString(), 'A-only');
  assert.equal(mediaB.getTempVideo(token), null);
  assert.equal(mediaC.getTempVideo(token), null);
  assert.equal(adminMedia.getTempVideo(token), null);
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
