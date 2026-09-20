// TEST — outils étendus : pipeline contacts, brouillons/lancement/programmation de campagne, file durable
// (retry, reprise, idempotence), CRM, diagnostic, notifications. Runtime injecté (aucun envoi réel).
//   node --test test/tools-extra.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-tools-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;
process.env.SECRET_VAULT_KEY = 'test-vault-key-tools';
process.env.DEFAULT_COUNTRY_CODE = '226';

const toolRegistry = require('../ai-engine/toolRegistry');
const pipeline = require('../ai-engine/contactsPipeline');
const taskQueue = require('../ai-engine/taskQueue');
const contactCrm = require('../ai-engine/contactCrm');
const chatUploads = require('../ai-engine/chatUploads');
const { queueHandlers } = require('../ai-engine/toolsExtra');

const T = 'tTools';
function runtime(rec) {
  return {
    sendCampaign: async (p) => { rec.push(p); return { ok: true, result: { channel: p.channel, recipients: p.recipients.length, status: 'started', campaignId: 'c1' } }; },
    pauseCampaign: async () => ({ ok: true }), resumeCampaign: async () => ({ ok: true }), stopCampaign: async () => ({ ok: true }),
    getCampaignStatus: async (p) => ({ ok: true, result: { id: p.campaignId || 'c1', name: 'n', status: 'running', total: 2, success: 1, failed: 0, skippedDuplicates: 0, pendingCount: 1, manualQueue: 0, results: p.withResults ? [{ to: '22670000001', status: 'sent', timestamp: 't' }, { to: '22670000002', status: 'pending' }] : undefined } }),
    getConnectionStatus: async () => ({ ok: true, result: { whatsapp: { available: true, connected: false }, telegram: { available: true, connected: true } } }),
    sendMessageVerified: async (p) => { rec.push(p); return { status: 'SUCCESS', confirmationId: 'W-1' }; },
  };
}
const run = (name, args, ctx) => toolRegistry.execute(T, name, args, Object.assign({ runtime: null }, ctx));

test('pipeline : formats mélangés -> destinataires propres + rapport honnête', () => {
  const out = pipeline.runPipeline('Awa 70 12 34 56\n+226 76-00-11-22 Koffi\n0022670123456\n70123456\nabc 123');
  assert.deepEqual(out.recipients.map((r) => r.telephone), ['22670123456', '22676001122']);
  assert.equal(out.report.duplicates, 2);
  assert.equal(pipeline.runPipeline('nom;telephone\nAwa;70123456\nMoussa;+22675000000').recipients.length, 2);
  assert.equal(pipeline.runPipeline([{ Nom: 'A', Telephone: '70000001' }, { name: 'B', phone: '+22670000001' }]).recipients.length, 1);
  assert.ok(pipeline.runPipeline('2260000000000').invalid.some((i) => i.reason === 'REPEATED_DIGITS'));
  assert.equal(pipeline.runPipeline('texte sans numéro 12345').recipients.length, 0, 'suite trop courte ignorée');
  assert.ok(pipeline.runPipeline([{ phone: '+2261234' }]).invalid.some((i) => i.reason === 'TOO_SHORT'));
});

test('sans indicatif pays : numéro local signalé, jamais deviné', () => {
  const saved = process.env.DEFAULT_COUNTRY_CODE; delete process.env.DEFAULT_COUNTRY_CODE;
  const out = pipeline.runPipeline('70123456');
  process.env.DEFAULT_COUNTRY_CODE = saved;
  assert.equal(out.recipients.length, 0);
  assert.equal(out.invalid[0].reason, 'COUNTRY_CODE_UNKNOWN');
});

test('registre : les nouveaux outils sont enregistrés avec contrat et risque', () => {
  const names = toolRegistry.describe().map((t) => t.name);
  for (const n of ['prepareContactsFromSource', 'createCampaignDraft', 'launchCampaign', 'scheduleCampaign', 'pauseCampaign', 'resumeCampaign', 'cancelCampaign', 'getCampaignStatus', 'generateCampaignReport', 'getQueueStatus', 'getSystemStatus', 'createCustomer', 'getNotifications', 'extractNumbersFromImage']) assert.ok(names.includes(n), n);
  assert.equal(toolRegistry.describe().find((t) => t.name === 'cancelCampaign').risk, 'SENSITIVE');
});

let recipientsDraft; let campaignDraft;
test('chaîne réelle : texte -> destinataires -> brouillon -> lancement confirmé -> moteur appelé', async () => {
  const rec = [];
  const rt = runtime(rec);
  await contactCrm.markOptOut(T, 'WHATSAPP', '22670000003', 'REFUSAL');
  const p = await run('prepareContactsFromSource', { text: 'Awa 70000001\nKoffi 70000002\n70000003\n70000001' });
  assert.equal(p.state, 'SUCCESS');
  assert.equal(p.result.report.valid, 3);
  recipientsDraft = p.result.recipientsDraftId;
  const d = await run('createCampaignDraft', { recipientsDraftId: recipientsDraft, text: 'Bonjour {nom}', name: 'Test' });
  assert.equal(d.state, 'SUCCESS');
  campaignDraft = d.result.draftId;
  assert.equal(rec.length, 0, 'rien lancé au stade brouillon');

  const ctx = { runtime: rt, confirmFrom: 'WRITE', permissions: ['messages:send'] };
  const need = await run('launchCampaign', { draftId: campaignDraft }, ctx);
  assert.equal(need.state, 'NEEDS_CONFIRMATION');
  assert.equal(need.result.preview.recipients, 2, 'le contact en refus est exclu de l\'aperçu');
  assert.equal(rec.length, 0);

  const ok = await run('launchCampaign', { draftId: campaignDraft }, Object.assign({ confirmed: true }, ctx));
  assert.equal(ok.state, 'SUCCESS', JSON.stringify(ok));
  assert.equal(rec.length, 1);
  assert.deepEqual(rec[0].recipients.map((r) => r.telephone), ['22670000001', '22670000002']);
  const again = await run('launchCampaign', { draftId: campaignDraft }, Object.assign({ confirmed: true }, ctx));
  assert.equal(again.error.code, 'ALREADY_LAUNCHED');
  assert.equal(rec.length, 1, 'jamais deux lancements');
});

test('lancement sans runtime -> échec honnête, pas de faux succès', async () => {
  const p = await run('prepareContactsFromSource', { text: '70000009' });
  const d = await run('createCampaignDraft', { recipientsDraftId: p.result.recipientsDraftId, text: 'x' });
  const out = await run('launchCampaign', { draftId: d.result.draftId }, { confirmed: true, confirmFrom: 'WRITE', permissions: ['messages:send'] });
  assert.equal(out.state, 'FAILED');
  assert.equal(out.error.code, 'RUNTIME_MISSING');
});

test('programmation : file durable, idempotence, exécution réelle par le worker', async () => {
  const rec = [];
  const rt = runtime(rec);
  const p = await run('prepareContactsFromSource', { text: '70000021\n70000022' });
  const d = await run('createCampaignDraft', { recipientsDraftId: p.result.recipientsDraftId, text: 'Salut' });
  const at = new Date(Date.now() + 3600000).toISOString();
  const ctx = { permissions: ['messages:send'] };
  const s1 = await run('scheduleCampaign', { draftId: d.result.draftId, at }, ctx);
  const s2 = await run('scheduleCampaign', { draftId: d.result.draftId, at }, ctx);
  assert.equal(s1.state, 'SUCCESS');
  assert.equal(s2.result.deduplicated, true, 'pas de double programmation');
  assert.equal((await run('scheduleCampaign', { draftId: d.result.draftId, at: 'n\'importe quoi' }, ctx)).error.code, 'INVALID_DATE');

  // pas encore dû : le worker ne fait rien
  assert.equal((await taskQueue.processTenant(T, queueHandlers(T, rt))).length, 0);
  assert.equal(rec.length, 0);
  // l'heure arrive : on avance la date d'échéance de la tâche (persistée) puis le worker exécute
  const doc = await taskQueue.list(T, { ref: d.result.draftId });
  const task = doc[0];
  const done = await taskQueue.processTenant(T, queueHandlers(T, rt), {});
  assert.equal(done.length, 0);
  const store = require('../ai-engine/storageAdapter');
  const raw = await store.get('task_queue', T, null);
  raw.tasks.find((t) => t.id === task.id).runAt = Date.now() - 1000;
  store.set('task_queue', T, raw);
  const done2 = await taskQueue.processTenant(T, queueHandlers(T, rt));
  assert.equal(done2.length, 1);
  assert.equal(done2[0].ok, true);
  assert.equal(rec.length, 1, 'campagne réellement lancée par le worker');
  assert.equal((await taskQueue.list(T, { ref: d.result.draftId }))[0].state, 'COMPLETED');
});

test('file : retry avec backoff puis échec définitif, et reprise après crash (bail expiré)', async () => {
  const q = 'tQueue';
  const { task } = await taskQueue.enqueue(q, { type: 'X', payload: {}, maxAttempts: 2 });
  let calls = 0;
  const h = { X: async () => { calls += 1; return { ok: false, error: 'boom', retryable: true }; } };
  await taskQueue.processTenant(q, h);
  let t = (await taskQueue.list(q))[0];
  assert.equal(t.state, 'QUEUED'); assert.equal(t.attempts, 1);
  assert.ok(t.runAt > Date.now(), 'backoff appliqué');
  const store = require('../ai-engine/storageAdapter');
  const raw = await store.get('task_queue', q, null); raw.tasks[0].runAt = Date.now() - 1; store.set('task_queue', q, raw);
  await taskQueue.processTenant(q, h);
  t = (await taskQueue.list(q))[0];
  assert.equal(t.state, 'FAILED'); assert.equal(calls, 2, 'limite de retries respectée');

  // crash : tâche restée PROCESSING avec bail expiré -> remise en file
  const { task: t2 } = await taskQueue.enqueue(q, { type: 'Y', payload: {} });
  await taskQueue.claimNext(q);
  assert.equal(await taskQueue.recover(q), 0, 'bail encore valide');
  assert.equal(await taskQueue.recover(q, Date.now() + 10 * 60 * 1000), 1, 'bail expiré -> récupérée');
  assert.equal((await taskQueue.list(q, { type: 'Y' }))[0].state, 'QUEUED');
  assert.ok(t2.id);
  assert.equal((await taskQueue.cancel(q, t2.id)).state, 'CANCELLED');
});

test('campagne : pause/reprise/statut/rapport passent par le moteur réel', async () => {
  const rt = runtime([]);
  const ctx = { runtime: rt, permissions: ['messages:send'] };
  assert.equal((await run('pauseCampaign', { campaignId: 'c1' }, ctx)).state, 'SUCCESS');
  assert.equal((await run('resumeCampaign', { campaignId: 'c1' }, ctx)).state, 'SUCCESS');
  assert.equal((await run('cancelCampaign', { campaignId: 'c1' }, ctx)).state, 'NEEDS_CONFIRMATION', 'annulation = sensible');
  assert.equal((await run('getCampaignStatus', { campaignId: 'c1' }, ctx)).result.status, 'running');
  const rep = await run('generateCampaignReport', { campaignId: 'c1' }, ctx);
  assert.match(rep.result.csv, /destinataire,statut,horodatage/);
  assert.match(rep.result.csv, /22670000001,"sent"|"22670000001","sent"/);
});

test('CRM : créer, lire, mettre à jour, étiqueter, segmenter, supprimer', async () => {
  await run('createCustomer', { phone: '22670001111', name: 'Awa', tags: ['vip'] });
  assert.equal((await run('getCustomer', { phone: '22670001111' })).result.name, 'Awa');
  await run('updateCustomer', { phone: '22670001111', stage: 'negociation' });
  await run('tagCustomer', { phone: '22670001111', tags: ['relance'] });
  const seg = await run('segmentCustomers', { tag: 'vip', stage: 'negociation' });
  assert.equal(seg.result.count, 1);
  assert.equal((await run('deleteCustomer', { phone: '22670001111' })).state, 'NEEDS_CONFIRMATION');
  assert.equal((await run('deleteCustomer', { phone: '22670001111' }, { confirmed: true })).state, 'SUCCESS');
  assert.equal((await run('getCustomer', { phone: '22670001111' })).error.code, 'CUSTOMER_NOT_FOUND');
});

test('diagnostic : détecte WhatsApp déconnecté et tâches bloquées avec des données réelles', async () => {
  const q = 'tDiag';
  await taskQueue.enqueue(q, { type: 'Z', payload: {}, runAt: Date.now() - 30 * 60 * 1000 });
  await taskQueue.claimNext(q, Date.now() - 20 * 60 * 1000);
  const out = await toolRegistry.execute(q, 'getSystemStatus', {}, { runtime: runtime([]) });
  assert.equal(out.state, 'SUCCESS');
  assert.ok(out.result.problems.includes('WHATSAPP_DECONNECTE'));
  assert.ok(out.result.problems.some((p) => p.startsWith('TACHES_BLOQUEES')));
  const noRt = await toolRegistry.execute(q, 'getSystemStatus', {}, {});
  assert.ok(noRt.result.problems.includes('STATUT_CONNEXION_INDISPONIBLE'), 'jamais un « tout va bien » inventé');
});

test('notifications : créer, lister, marquer lue', async () => {
  const c = await run('createNotification', { title: 'Campagne terminée', body: '2 envoyés' });
  assert.equal((await run('getNotifications', {})).result.count, 1);
  await run('markNotificationRead', { id: c.result.id });
  assert.equal((await run('getNotifications', {})).result.count, 0);
});

test('OCR : moteur absent -> échec honnête ; moteur présent -> numéros + valeurs incertaines signalées', async () => {
  const up = await chatUploads.save(T, { originalname: 'liste.png', mimetype: 'image/png', buffer: Buffer.from('fakepng') });
  const missing = await run('extractNumbersFromImage', { fileId: up.id });
  assert.equal(missing.state, 'FAILED');
  assert.equal(missing.error.code, 'OCR_ENGINE_MISSING');
  const fakeOcr = { recognize: async () => ({ text: 'Awa 70000031\nKoffi 70000032', words: [{ text: '70000031', confidence: 95 }, { text: '70000032', confidence: 40 }] }) };
  const ok = await run('extractNumbersFromImage', { fileId: up.id }, { ocr: fakeOcr });
  assert.equal(ok.state, 'SUCCESS');
  assert.equal(ok.result.report.valid, 2);
  assert.deepEqual(ok.result.needsReview, ['22670000032']);
});

test('Excel joint -> pipeline (fichier réel .xlsx)', async () => {
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ Nom: 'A', Telephone: '70000041' }, { Nom: 'B', Telephone: '70000041' }, { Nom: 'C', Telephone: '70000042' }]), 'S');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const up = await chatUploads.save(T, { originalname: 'contacts.xlsx', mimetype: 'application/octet-stream', buffer });
  const out = await run('prepareContactsFromSource', { fileId: up.id });
  assert.equal(out.state, 'SUCCESS', JSON.stringify(out));
  assert.equal(out.result.report.valid, 2);
  assert.equal(out.result.report.duplicates, 1);
});
