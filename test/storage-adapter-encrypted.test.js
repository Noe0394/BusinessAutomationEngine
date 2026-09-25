'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-encrypted-storage-'));
process.env.AI_ENGINE_STORAGE_DIR = ROOT;
process.env.SECRET_VAULT_KEY = 'test-storage-vault-key';
delete process.env.ADMIN_PASSWORD;
const githubStore = require('../githubStore');
const storage = require('../ai-engine/storageAdapter');
const remoteFiles = new Map();
const prior = { enabled: githubStore.enabled, createStore: githubStore.createStore, listDirectory: githubStore.listDirectory };
githubStore.enabled = true;
githubStore.createStore = (filePath) => ({
  enabled: true,
  pushRemote: async (content) => { remoteFiles.set(filePath, content); },
  fetchRemote: async () => remoteFiles.has(filePath) ? { content: remoteFiles.get(filePath) } : null,
  deleteRemote: async () => { remoteFiles.delete(filePath); },
});
githubStore.listDirectory = async (directory) => Array.from(remoteFiles.keys())
  .filter((file) => file.startsWith(directory + '/')).map((file) => file.slice(directory.length + 1));

test('les files sensibles sont chiffrées dans le miroir et restaurées après perte du disque local', async () => {
  const data = { tenant: 'tenant-safe', tasks: [{ type: 'SEND_MESSAGE', payload: { to: '+22670000001', text: 'Message privé' } }] };
  await storage.setDurable('task_queue', 'tenant-safe', data);
  const serializedRemote = Array.from(remoteFiles.values())[0];
  assert.match(serializedRemote, /"_cyrusEncrypted":1/);
  assert.doesNotMatch(serializedRemote, /22670000001|Message privé/);

  fs.rmSync(path.join(ROOT, 'task_queue', 'tenant-safe.json'), { force: true });
  assert.deepEqual(await storage.get('task_queue', 'tenant-safe', null), data);
  assert.deepEqual(await storage.listIdsAsync('task_queue'), ['tenant-safe']);
  assert.equal(storage.persistenceStatus().encryptedNamespaces.find((x) => x.namespace === 'task_queue').durableAcrossRestarts, true);
});

test('le miroir durable refuse les données sensibles sans clé de chiffrement', async () => {
  delete process.env.SECRET_VAULT_KEY;
  await assert.rejects(() => storage.setDurable('objective_missions', 'tenant-safe', { objective: 'secret' }), /DURABLE_STORAGE_KEY_MISSING/);
  process.env.SECRET_VAULT_KEY = 'test-storage-vault-key';
});

test.after(() => {
  githubStore.enabled = prior.enabled;
  githubStore.createStore = prior.createStore;
  githubStore.listDirectory = prior.listDirectory;
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* nettoyage */ }
});
