'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TOOLS } = require('../ai-engine/tool-modules/render-platforms');

test('les tools Facebook appellent l’adaptateur existant et exigent une preuve de résultat', async () => {
  const calls = [];
  const ctx = { facebook: {
    async publishPost(args) { calls.push(args); return { id: 'page-post-42' }; },
    getManagedGroups() { return [{ id: 'group-9', name: 'Groupe réel' }]; },
    async publishToGroup(id, args) { calls.push({ id, ...args }); return { id: 'group-post-11' }; },
  } };
  const page = await TOOLS.publishFacebookPagePost.execute({ message: 'Annonce' }, ctx);
  assert.deepEqual(calls[0], { message: 'Annonce', link: undefined, mediaBuffer: null, mediaMimetype: null, mediaFilename: null });
  assert.deepEqual(await TOOLS.publishFacebookPagePost.verify(page.result), { verified: true, postId: 'page-post-42' });
  const group = await TOOLS.publishFacebookManagedGroupPost.execute({ groupId: 'group-9', message: 'Rappel' }, ctx);
  assert.equal(group.result.postId, 'group-post-11');
  const unknown = await TOOLS.publishFacebookManagedGroupPost.execute({ groupId: 'inventé', message: 'Rappel' }, ctx);
  assert.equal(unknown.error.code, 'GROUP_NOT_MANAGED');
});

test('la génération de PDF réutilise le moteur existant et enregistre le vrai fichier du tenant', async () => {
  let generatedSpec; let saved;
  const ctx = {
    tenant: 'tenant-1',
    ebookGenerator: { async generateEbookPdf(spec) { generatedSpec = spec; return Buffer.from('%PDF-real'); } },
    chatUploads: {
      async save(tenant, file) { saved = { tenant, file }; return { id: 'f_pdf_1', name: file.originalname, size: file.buffer.length, type: file.mimetype }; },
      async get(tenant, id) { return tenant === 'tenant-1' && id === 'f_pdf_1' ? { id } : null; },
    },
  };
  const out = await TOOLS.generateEbookPdf.execute({
    title: 'Guide réel', subtitle: 'Sous-titre', chaptersJson: '[{"title":"Chapitre 1","content":"Texte fourni"}]',
  }, ctx);
  assert.equal(generatedSpec.title, 'Guide réel');
  assert.equal(saved.tenant, 'tenant-1');
  assert.equal(saved.file.mimetype, 'application/pdf');
  assert.equal(out.result.fileId, 'f_pdf_1');
  assert.deepEqual(await TOOLS.generateEbookPdf.verify(out.result, {}, ctx), { verified: true });
});

test('le statut Studio rapporte les moteurs configurés sans révéler les identifiants', async () => {
  const result = await TOOLS.getStudioMediaStatus.execute({}, {
    imageAiEngine: { isConfigured: () => ({ fal: true }) },
    videoAiEngine: { isConfigured: () => ({ fal: false, replicate: true }) },
    mediaPublisher: { isYoutubeConfigured: () => true, isInstagramConfigured: () => false, isTikTokConfigured: () => true },
  });
  assert.deepEqual(result.result, { image: { fal: true }, video: { fal: false, replicate: true }, youtube: true, instagram: false, tiktok: true });
  assert.doesNotMatch(JSON.stringify(result), /token|secret|key/i);
});

test('l’export CRM crée un vrai CSV tenant-scoped sans inventer de contact', async () => {
  let saved;
  const result = await TOOLS.exportContacts.execute({}, {
    tenant: 'tenant-export-empty',
    chatUploads: { async save(tenant, file) { saved = { tenant, file }; return { id: 'csv-1', name: file.originalname, size: file.buffer.length, type: file.mimetype }; } },
  });
  assert.equal(result.result.count, 0);
  assert.equal(saved.tenant, 'tenant-export-empty');
  assert.equal(saved.file.mimetype, 'text/csv');
  assert.match(saved.file.buffer.toString('utf8'), /name,phone,channel,tags,stage,optOut,firstSeen,lastSeen/);
  assert.equal(await TOOLS.exportContacts.verify(result.result, {}, { tenant: 'tenant-export-empty', chatUploads: { async get(_tenant, id) { return id === 'csv-1' ? {} : null; } } }).then((x) => x.verified), true);
});

test('les règles Facebook et prospects utilisent leurs modèles existants', async () => {
  const rules = [{ id: 'r1', keyword: 'FORMATION', replyMessage: 'Détails', mediaUrl: 'local:private', createdAt: 'now' }];
  const ctx = {
    keywordRules: {
      list() { return rules.slice(); },
      create(value) { const row = { id: 'r2', ...value }; rules.push(row); return row; },
      remove(id) { const next = rules.filter((r) => r.id !== id); rules.splice(0, rules.length, ...next); return next; },
    },
    contactsStore: { list() { return [{ id: 'p1', psid: 'psid-1', name: 'Ada', source: 'comment' }]; } },
    tenant: 'tenant-fb',
    chatUploads: { async save(_tenant, file) { return { id: 'prospects-1', name: file.originalname, size: file.buffer.length }; } },
  };
  const listed = await TOOLS.listFacebookKeywordRules.execute({}, ctx);
  assert.equal(listed.result.rules[0].hasMedia, true);
  assert.doesNotMatch(JSON.stringify(listed.result), /local:private/);
  const created = await TOOLS.createFacebookKeywordRule.execute({ keyword: 'CLIENTS', replyMessage: 'Bienvenue' }, ctx);
  assert.equal((await TOOLS.createFacebookKeywordRule.verify(created.result, {}, ctx)).verified, true);
  const prospectList = await TOOLS.listFacebookProspects.execute({}, ctx);
  assert.equal(prospectList.result.count, 1);
  const exportResult = await TOOLS.exportFacebookProspects.execute({}, ctx);
  assert.equal(exportResult.result.count, 1);
  assert.equal((await TOOLS.exportFacebookProspects.verify(exportResult.result, {}, { ...ctx, chatUploads: { async get(_tenant, id) { return id === 'prospects-1' ? {} : null; } } })).verified, true);
  const removed = await TOOLS.deleteFacebookKeywordRule.execute({ id: 'r2' }, ctx);
  assert.equal((await TOOLS.deleteFacebookKeywordRule.verify(removed.result, {}, ctx)).verified, true);
});

test('l’import Facebook lit un fichier appartenant au tenant, résout les conversations et enregistre le CRM existant', async () => {
  const contactCrm = require('../ai-engine/contactCrm');
  const originalRecordBatch = contactCrm.recordBatch;
  const originalGetContact = contactCrm.getContact;
  let recorded;
  contactCrm.recordBatch = async (tenant, entries, opts) => { recorded = { tenant, entries, opts }; return { imported: entries.length }; };
  contactCrm.getContact = async (tenant, channel, psid) => tenant === 'tenant-import' && channel === 'FACEBOOK' && psid === 'psid-1' ? { from: psid } : null;
  const csv = Buffer.from('PSID,Name\npsid-1,Ada\npsid-2,Bob');
  const ctx = {
    tenant: 'tenant-import',
    facebook: {
      isConfigured: () => true,
      async resolveRecipientsFromConversations(rows) { return rows.map((row) => ({ ...row, recipientId: row.psid === 'psid-1' ? row.psid : null, matched: row.psid === 'psid-1' })); },
    },
    chatUploads: {
      async readFile(tenant, id) { return tenant === 'tenant-import' && id === 'f_1' ? { meta: { name: 'contacts.csv', type: 'text/csv' }, buffer: csv } : null; },
    },
  };
  try {
    const out = await TOOLS.importFacebookContactsFromFile.execute({ fileId: 'f_1' }, ctx);
    assert.equal(out.result.total, 2);
    assert.equal(out.result.matched, 1);
    assert.equal(out.result.savedToCrm, 1);
    assert.equal(recorded.tenant, 'tenant-import');
    assert.deepEqual(out.result.contacts.map((c) => c.matched), [true, false]);
    assert.deepEqual(recorded.entries.map((entry) => entry.from), ['psid-1']);
    assert.deepEqual(await TOOLS.importFacebookContactsFromFile.verify(out.result, {}, ctx), { verified: true, matched: 1, savedToCrm: 1 });
  } finally {
    contactCrm.recordBatch = originalRecordBatch;
    contactCrm.getContact = originalGetContact;
  }
});
