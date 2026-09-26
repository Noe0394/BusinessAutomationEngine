'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const githubStore = require('../githubStore');
const authStoreModule = require('../adapters/whatsappAuthStore');

test('local Baileys credentials and Signal keys are never replaced by a stale remote snapshot', async (t) => {
  let fetches = 0;
  t.mock.method(githubStore, 'createStore', () => ({
    enabled: true,
    fetchRemote: async () => { fetches += 1; return { content: 'remote-stale-creds' }; },
    pushRemote: async () => {},
    getStatus: () => ({}),
  }));
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-wa-auth-'));
  t.after(() => fs.rmSync(authDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(authDir, 'creds.json'), 'local-current-creds');
  fs.writeFileSync(path.join(authDir, 'session-user.json'), 'local-signal-session');

  const store = authStoreModule.createAuthStore('tenant-test');
  assert.equal(await store.restoreSessionFromRemote(authDir), false);
  assert.equal(fetches, 0);
  assert.equal(fs.readFileSync(path.join(authDir, 'creds.json'), 'utf8'), 'local-current-creds');
  assert.equal(fs.readFileSync(path.join(authDir, 'session-user.json'), 'utf8'), 'local-signal-session');
});

test('credentials-only remote backup is never restored without its matching Signal keys', async (t) => {
  let fetches = 0;
  t.mock.method(githubStore, 'createStore', () => ({
    enabled: true,
    fetchRemote: async () => { fetches += 1; return { content: 'remote-creds-without-signal-keys' }; },
    pushRemote: async () => {},
    getStatus: () => ({}),
  }));
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-wa-auth-'));
  t.after(() => fs.rmSync(authDir, { recursive: true, force: true }));

  const store = authStoreModule.createAuthStore('tenant-test');
  assert.equal(await store.restoreSessionFromRemote(authDir), false);
  assert.equal(fetches, 0, 'a credentials-only snapshot cannot be a valid session restore');
  assert.equal(fs.existsSync(path.join(authDir, 'creds.json')), false, 'do not create a half-restored Baileys state');
});

test('credentials-only snapshots are not written to remote storage', async (t) => {
  const pushed = [];
  t.mock.method(githubStore, 'createStore', () => ({
    enabled: true,
    fetchRemote: async () => null,
    pushRemote: async (content) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      pushed.push(content);
    },
    getStatus: () => ({}),
  }));
  const store = authStoreModule.createAuthStore('tenant-test');
  await store.pushSnapshot('unused');
  store.startPeriodicSync('unused');
  assert.deepEqual(pushed, [], 'do not upload an incomplete and sensitive auth state');
  assert.equal(store.enabled, false);
  assert.equal(store.getStatus().restoreSupported, false);
});
