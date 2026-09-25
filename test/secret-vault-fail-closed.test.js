'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const previousKey = process.env.SECRET_VAULT_KEY;
const previousAdmin = process.env.ADMIN_PASSWORD;
const previousDir = process.env.AI_ENGINE_STORAGE_DIR;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-vault-deny-'));
delete process.env.SECRET_VAULT_KEY;
delete process.env.ADMIN_PASSWORD;
process.env.AI_ENGINE_STORAGE_DIR = tempDir;
const vault = require('../ai-engine/secretVault');

test('secret vault refuses storage and encryption without a server key', async () => {
  assert.equal(vault.isEncryptionConfigured(), false);
  assert.throws(() => vault.encrypt('sensitive-value'), /SECRET_VAULT_KEY_NOT_CONFIGURED/);
  await assert.rejects(vault.setSecret('ACCOUNT_A', 'api-key', 'sensitive-value'), /SECRET_VAULT_KEY_NOT_CONFIGURED/);
  assert.equal(fs.readdirSync(tempDir).length, 0);
});

test.after(() => {
  if (previousKey === undefined) delete process.env.SECRET_VAULT_KEY; else process.env.SECRET_VAULT_KEY = previousKey;
  if (previousAdmin === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = previousAdmin;
  if (previousDir === undefined) delete process.env.AI_ENGINE_STORAGE_DIR; else process.env.AI_ENGINE_STORAGE_DIR = previousDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});
