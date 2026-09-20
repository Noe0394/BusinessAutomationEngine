// TEST — Onglet Campagnes : destinataires (texte/CSV/Excel/photo) -> campagne -> lancement/programmation ->
// suivi réel -> pause/reprise/annulation -> rapport ; plus un passage par le VRAI moteur de campagne (session simulée).
//   node --test test/campaign-service.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-cmp-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;
process.env.SECRET_VAULT_KEY = 'test-vault-key-cmp';
process.env.DEFAULT_COUNTRY_CODE = '226';

const svc = require('../ai-engine/campaignService');
const taskQueue = require('../ai-engine/taskQueue');
const contactCrm = require('../ai-engine/contactCrm');
const chatUploads = require('../ai-engine/chatUploads');
const continuity = require('../ai-engine/campaignContinuity');
const { queueHandlers } = require('../ai-engine/toolsExtra');
const statusLib = require('../lib/campaignStatus');

const T = 'tCmp';

// Moteur simulé : mêmes formes de réponses que vps-runtime (statuts internes des moteurs réels).
function fakeRuntime() {
  const calls = { send: [], pause: [], resume: [], stop: [] };
  const state = { live: { id: 'eng1', name: 'n', status: 'running', paused: false, userPaused: false, networkStatus: 'normal', retryAfterSeconds: 0, total: 3, sent: 1, success: 1, failed: 0, skippedDuplicates: 0, pendingCount: 2, createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), assistedMode: false },
    rows: [
      { index: 0, name: 'Awa', number: '+22670000001', status: 'sent', lastAttemptAt: 't1', error: null },
      { index: 1, name: 'Koffi', number: '+22670000002', status: 'processing', lastAttemptAt: null, error: null },
      { index: 2, name: '', number: '+22670000003', status: 'failed', lastAttemptAt: 't3', error: 'timeout' },
    ] };
  return {
    calls, state,
    sendCampaign: async (p) => { calls.send.push(p); return { ok: true, result: { channel: p.channel, recipients: p.recipients.length, status: 'started', campaignId: 'eng1' } }; },
    getCampaignStatus: async (p) => (p.campaignId === 'eng1' ? { ok: true, result: Object.assign({}, state.live, { manualQueue: 5 }) } : (p.campaignId ? { ok: false, error: 'CAMPAIGN_NOT_FOUND' } : { ok: true, result: { campaigns: [Object.assign({}, state.live, { id: 'legacy1', name: 'Ancienne' })] } })),
    getCampaignRecipients: async () => ({ ok: true, result: { recipients: state.rows } }),
    pauseCampaign: async (p) => { calls.pause.push(p); state.live.userPaused = true; state.live.status = 'paused'; return { ok: true }; },
    resumeCampaign: async (p) => { calls.resume.push(p); state.live.userPaused = false; state.live.status = 'running'; return { ok: true }; },
    stopCampaign: async (p) => { calls.stop.push(p); state.live.status = 'cancelled'; return { ok: true }; },
  };
}

test('statuts : traduction des moteurs vers le vocabulaire de l\'interface', () => {
  assert.equal(statusLib.recipientStatus('sent_manual'), 'manual_sent');
  assert.equal(statusLib.recipientStatus('skipped_duplicate'), 'skipped');
  assert.equal(statusLib.recipientStatus('pending', true), 'processing');
  assert.equal(statusLib.recipientStatus('interrupted', false), 'pending');
  assert.equal(statusLib.campaignState({ status: 'running', networkStatus: 'circuit_open' }), 'protection_triggered');
  assert.equal(statusLib.campaignState({ status: 'running', networkStatus: 'circuit_open', assistedMode: true }), 'manual_fallback');
  assert.equal(statusLib.campaignState({ status: 'paused', userPaused: true }), 'paused');
  assert.equal(statusLib.campaignState({ status: 'completed' }), 'completed');
  assert.equal(statusLib.campaignState({ status: 'queued' }), 'waiting');
});

let listId;
test('destinataires : liste collée avec formats mélangés -> table et compteurs réels', async () => {
  const text = 'Jean : +226 70 12 34 56\nPaul: +22676123456\n(+226) 50 12 34 56\n00226 70123456\n+22670123456\n123456789012345678';
  const r = await svc.prepareRecipients(T, { text });
  listId = r.recipientsId;
  assert.deepEqual(r.counts, { total: 6, valid: 3, duplicate: 2, invalid: 1, uncertain: 0 });
  assert.equal(r.rows[0].number, '22670123456');
  assert.equal(r.rows.find((x) => x.state === 'invalid').reason, 'TOO_LONG');
});

test('destinataires : CSV, Excel réel (.xlsx) et photo (OCR simulé, valeur incertaine signalée)', async () => {
  const csv = await svc.prepareRecipients(T, { file: { buffer: Buffer.from('Nom;Téléphone\nAwa;70000001\nKoffi;70000002\n'), name: 'liste.csv', type: 'text/csv' } });
  assert.equal(csv.counts.valid, 2);
  assert.equal(csv.rows[0].name, 'Awa');

  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ Nom: 'A', Téléphone: '70000011' }, { Nom: 'B', Téléphone: '+226 70 00 00 11' }, { Nom: 'C', Téléphone: '70000012' }]), 'S');
  const xl = await svc.prepareRecipients(T, { file: { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), name: 'liste.xlsx', type: 'application/octet-stream' } });
  assert.equal(xl.counts.valid, 2); assert.equal(xl.counts.duplicate, 1);

  const ocr = { recognize: async () => ({ text: 'Awa 70000021\nKoffi 70000022', words: [{ text: '70000021', confidence: 96 }, { text: '70000022', confidence: 41 }] }) };
  const img = await svc.prepareRecipients(T, { image: Buffer.from('png') }, { ocr });
  assert.equal(img.counts.valid, 1); assert.equal(img.counts.uncertain, 1);
  assert.equal(img.rows.find((x) => x.state === 'uncertain').reason, 'OCR_LOW_CONFIDENCE');

  await assert.rejects(() => svc.prepareRecipients(T, { image: Buffer.from('png') }), (e) => e.code === 'OCR_ENGINE_MISSING' && e.http === 501, 'OCR absent : erreur explicite');
  await assert.rejects(() => svc.prepareRecipients(T, {}), (e) => e.code === 'EMPTY_SOURCE');
});

test('numéro local sans indicatif pays : incertain, jamais modifié', async () => {
  const saved = process.env.DEFAULT_COUNTRY_CODE; delete process.env.DEFAULT_COUNTRY_CODE;
  const r = await svc.prepareRecipients(T, { text: '70123456' });
  process.env.DEFAULT_COUNTRY_CODE = saved;
  assert.equal(r.counts.uncertain, 1);
  assert.equal(r.rows[0].state, 'uncertain');
});

let cmp;
test('création : seuls les destinataires valides partent ; contrôles de saisie', async () => {
  await assert.rejects(() => svc.createCampaign(T, { name: '', channel: 'WHATSAPP', text: 'x', recipientsId: listId }), (e) => e.code === 'NAME_REQUIRED');
  await assert.rejects(() => svc.createCampaign(T, { name: 'A', channel: 'WHATSAPP', text: '', recipientsId: listId }), (e) => e.code === 'MESSAGE_REQUIRED');
  await assert.rejects(() => svc.createCampaign(T, { name: 'A', channel: 'SMS', text: 'x', recipientsId: listId }), (e) => e.code === 'INVALID_CHANNEL');
  await assert.rejects(() => svc.createCampaign(T, { name: 'A', channel: 'TELEGRAM', text: 'x', recipientsId: listId }, ['whatsapp']), (e) => e.code === 'MODULE_NOT_ALLOWED' && e.http === 403);
  await assert.rejects(() => svc.createCampaign(T, { name: 'A', channel: 'TELEGRAM', text: 'x', recipientsId: listId, mediaFileId: 'f_x' }), (e) => e.code === 'MEDIA_NOT_SUPPORTED_CHANNEL');
  const bad = await svc.prepareRecipients(T, { text: 'rien de valide 123' });
  await assert.rejects(() => svc.createCampaign(T, { name: 'A', channel: 'WHATSAPP', text: 'x', recipientsId: bad.recipientsId }), (e) => e.code === 'EMPTY_SOURCE' || e.code === 'NO_VALID_RECIPIENT');
  cmp = await svc.createCampaign(T, { name: 'Promo', channel: 'WHATSAPP', text: 'Bonjour {nom}', recipientsId: listId });
  assert.equal(cmp.state, 'draft');
  const d = await svc.get(T, cmp.id, fakeRuntime());
  assert.equal(d.progress.total, 3);
  assert.equal(d.recipientRows.length, 3);
});

test('lancement : moteur appelé avec message + média + destinataires valides, jamais deux fois', async () => {
  const rt = fakeRuntime();
  const img = await chatUploads.save(T, { originalname: 'promo.png', mimetype: 'image/png', buffer: Buffer.alloc(512) });
  const c2 = await svc.createCampaign(T, { name: 'Avec image', channel: 'WHATSAPP', text: 'Salut', recipientsId: listId, mediaFileId: img.id });
  await contactCrm.markOptOut(T, 'WHATSAPP', '22676123456', 'REFUSAL');
  const out = await svc.launch(T, c2.id, rt);
  assert.equal(out.state, 'waiting');
  assert.equal(rt.calls.send.length, 1);
  assert.deepEqual(rt.calls.send[0].recipients.map((r) => r.telephone), ['22670123456', '2265012345'.length ? '22650123456' : '']);
  assert.equal(rt.calls.send[0].sequence[0].type, 'media');
  assert.equal(rt.calls.send[0].sequence[0].buffer.length, 512);
  await assert.rejects(() => svc.launch(T, c2.id, rt), (e) => e.code === 'INVALID_STATE' && e.http === 409);
  assert.equal(rt.calls.send.length, 1);
  await assert.rejects(() => svc.launch(T, c2.id, null), (e) => e.code === 'INVALID_STATE');
  const c3 = await svc.createCampaign(T, { name: 'Sans moteur', channel: 'WHATSAPP', text: 'x', recipientsId: listId });
  await assert.rejects(() => svc.launch(T, c3.id, null), (e) => e.code === 'RUNTIME_MISSING' && e.http === 503);
  assert.equal((await svc.get(T, c3.id, null)).state, 'draft', 'échec de lancement : la campagne reste un brouillon');
});

test('suivi réel : progression, tableau de destinataires, protection et continuité', async () => {
  const rt = fakeRuntime();
  const c = await svc.createCampaign(T, { name: 'Suivi', channel: 'WHATSAPP', text: 'x', recipientsId: listId });
  await svc.launch(T, c.id, rt);
  let d = await svc.get(T, c.id, rt);
  assert.equal(d.state, 'running');
  assert.deepEqual(d.recipientRows.map((r) => r.status), ['sent', 'processing', 'failed']);
  assert.equal(d.progress.total, 3); assert.equal(d.progress.sent, 1); assert.equal(d.progress.failed, 1);
  assert.equal(d.progress.percent, 66.7);
  assert.equal(d.recipientRows[2].error, 'timeout');

  rt.state.live.networkStatus = 'circuit_open'; rt.state.live.retryAfterSeconds = 600;
  d = await svc.get(T, c.id, rt);
  assert.equal(d.state, 'protection_triggered'); assert.equal(d.retryAfterSeconds, 600);

  rt.state.live.assistedMode = true;
  await continuity.ensureFallback(T, { channel: 'WHATSAPP', campaignId: 'eng1', campaignName: 'Suivi' });
  d = await svc.get(T, c.id, rt);
  assert.equal(d.state, 'manual_fallback');
  assert.equal(d.fallback.status, 'manual_fallback');
  assert.equal(d.manualQueue, 5);

  const list = await svc.list(T, rt);
  assert.ok(list.some((x) => x.id === c.id && x.state === 'manual_fallback'));
  assert.ok(list.some((x) => x.id === 'legacy1' && x.legacy), 'les campagnes des anciens onglets restent visibles');
});

test('pause / reprise / annulation passent par le moteur ; annulation d\'une campagne programmée = tâche annulée', async () => {
  const rt = fakeRuntime();
  const c = await svc.createCampaign(T, { name: 'Ctrl', channel: 'WHATSAPP', text: 'x', recipientsId: listId });
  await svc.launch(T, c.id, rt);
  assert.equal((await svc.control(T, c.id, 'pause', rt)).state, 'paused');
  assert.equal(rt.calls.pause[0].campaignId, 'eng1');
  assert.equal((await svc.control(T, c.id, 'resume', rt)).state, 'running');
  assert.equal((await svc.control(T, c.id, 'cancel', rt)).state, 'cancelled');
  assert.equal(rt.calls.stop.length, 1);

  const s = await svc.createCampaign(T, { name: 'Prog', channel: 'WHATSAPP', text: 'x', recipientsId: listId, scheduledAt: new Date(Date.now() + 3600000).toISOString() });
  assert.equal(s.state, 'scheduled');
  const tasks = await taskQueue.list(T, { ref: s.id });
  assert.equal(tasks.length, 1);
  await svc.control(T, s.id, 'cancel', rt);
  assert.equal((await taskQueue.list(T, { ref: s.id }))[0].state, 'CANCELLED');
  assert.equal((await svc.get(T, s.id, rt)).state, 'cancelled');
  await assert.rejects(() => svc.schedule(T, s.id, new Date(Date.now() + 1000).toISOString()), (e) => e.code === 'INVALID_STATE');
  await assert.rejects(() => svc.createCampaign(T, { name: 'P', channel: 'WHATSAPP', text: 'x', recipientsId: listId, scheduledAt: '2020-01-01T00:00:00Z' }), (e) => e.code === 'DATE_IN_PAST');
});

test('lancement manuel d’une campagne programmée : échec = la programmation est conservée', async () => {
  const s = await svc.createCampaign(T, { name: 'Garde tâche', channel: 'WHATSAPP', text: 'x', recipientsId: listId, scheduledAt: new Date(Date.now() + 3600000).toISOString() });
  await assert.rejects(() => svc.launch(T, s.id, null), (e) => e.code === 'RUNTIME_MISSING');
  assert.equal((await taskQueue.list(T, { ref: s.id }))[0].state, 'QUEUED', 'tâche programmée intacte');
  assert.equal((await svc.get(T, s.id, null)).state, 'scheduled');
});

test('programmation : le worker lance la campagne à l\'heure et l\'identifiant du moteur est conservé', async () => {
  const rt = fakeRuntime();
  const s = await svc.createCampaign(T, { name: 'Programmée', channel: 'WHATSAPP', text: 'x', recipientsId: listId, scheduledAt: new Date(Date.now() + 3600000).toISOString() });
  const store = require('../ai-engine/storageAdapter');
  const raw = await store.get('task_queue', T, null);
  raw.tasks.find((t) => t.ref === s.id).runAt = Date.now() - 1000;
  store.set('task_queue', T, raw);
  const done = await taskQueue.processTenant(T, queueHandlers(T, rt));
  assert.equal(done.filter((x) => x.ok).length >= 1, true);
  assert.equal(rt.calls.send.length, 1);
  const d = await svc.get(T, s.id, rt);
  assert.equal(d.state, 'running');
  assert.equal(d.progress.total, 3);
});

test('rapport : totaux réels, durée, continuité utilisée, erreurs et CSV', async () => {
  const rt = fakeRuntime();
  const c = await svc.createCampaign(T, { name: 'Rapport', channel: 'WHATSAPP', text: 'x', recipientsId: listId });
  await svc.launch(T, c.id, rt);
  const r = await svc.report(T, c.id, rt);
  assert.equal(r.total, 3); assert.equal(r.sent, 1); assert.equal(r.failed, 1);
  assert.equal(r.fallbackUsed, true);
  assert.deepEqual(r.errors, [{ number: '+22670000003', error: 'timeout' }]);
  assert.match(r.csv, /nom,numero,statut,derniere_tentative,erreur/);
  assert.match(r.csv, /"Awa","\+22670000001","sent"/);
  assert.equal(typeof r.durationSeconds, 'number');
});

test('VRAI moteur de campagne : envoi réel via la session, table de destinataires, protection intacte, arrêt propre', async (t) => {
  const { CampaignEngine } = require('../queues/campaignEngine');
  const sent = [];
  const session = {
    isConnected: () => true, getContactName: () => '', onIncomingMessage: () => {}, onAccountReset: () => {},
    sendMessage: async (to, text) => { sent.push({ to, text }); return { key: { id: 'X' + sent.length } }; },
    sendMedia: async () => ({}),
  };
  const events = [];
  const tenantId = 'tEngine_' + Date.now();
  const eng = new CampaignEngine(tenantId, session, () => {}, (e) => events.push(e));
  const st = await eng.start([{ telephone: '22670000901', nom: 'Awa' }, { telephone: '22670000902', nom: 'Koffi' }], { name: 'Réelle', sequence: [{ type: 'text', text: 'Bonjour {nom}' }], enqueueIfBusy: true });
  assert.ok(st.id, 'le moteur renvoie l\'identifiant de campagne');
  const deadline = Date.now() + 8000;
  while (!sent.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent.length, 1, 'premier message réellement transmis à la session');
  assert.equal(sent[0].to, '22670000901@s.whatsapp.net');
  assert.match(sent[0].text, /Bonjour Awa/);
  await new Promise((r) => setTimeout(r, 300));
  const rows = eng.getRecipients(st.id);
  assert.deepEqual(rows.map((r) => r.status), ['sent', 'processing'], 'statuts issus du moteur, pas de l\'interface');
  assert.equal(rows[0].name, 'Awa');
  assert.equal(eng.getStatus(st.id).assistedMode, false);
  eng.stop(st.id);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(eng.getStatus(st.id).status === 'cancelled' || eng.getStatus(st.id).status === 'stopped', true);
  assert.equal(sent.length, 1, 'aucun envoi après l\'arrêt : la cadence de protection (45 s minimum) reste active');
  try { eng.reset(); } catch (e) { /* nettoyage */ }
  for (const f of [path.join(__dirname, '..', 'campaigns_state', tenantId + '.json')]) { try { fs.unlinkSync(f); } catch (e) { /* absent */ } }
  t.diagnostic('cadence de protection préservée (délai minimum entre destinataires)');
});

test('VRAI moteur : reprise après redémarrage — les destinataires déjà envoyés ne sont jamais renvoyés', async () => {
  const { CampaignEngine } = require('../queues/campaignEngine');
  const sent = [];
  const mkSession = () => ({
    isConnected: () => true, getContactName: () => '', onIncomingMessage: () => {}, onAccountReset: () => {},
    sendMessage: async (to, text) => { sent.push(to); return { key: { id: 'Y' + sent.length } }; }, sendMedia: async () => ({}),
  });
  const tenantId = 'tRestart_' + Date.now();
  const e1 = new CampaignEngine(tenantId, mkSession(), () => {}, () => {});
  const st = await e1.start([{ telephone: '22670000951', nom: 'A' }, { telephone: '22670000952', nom: 'B' }, { telephone: '22670000953', nom: 'C' }], { name: 'Reprise', sequence: [{ type: 'text', text: 'Salut' }], enqueueIfBusy: true });
  const deadline = Date.now() + 8000;
  while (!sent.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent.length, 1);
  e1.pauseForShutdown(); // arrêt du processus : l'état est conservé sur disque
  await new Promise((r) => setTimeout(r, 400));

  const e2 = new CampaignEngine(tenantId, mkSession(), () => {}, () => {}); // « redémarrage »
  await e2.resumeIfPending();
  await new Promise((r) => setTimeout(r, 1500));
  const rows = e2.getRecipients(st.id);
  assert.ok(rows, 'la campagne a été retrouvée après redémarrage');
  assert.equal(rows[0].status, 'sent', 'le premier destinataire reste « envoyé »');
  assert.equal(sent.filter((t) => t === '22670000951@s.whatsapp.net').length, 1, 'jamais renvoyé');
  assert.ok(['running', 'paused'].includes(e2.getStatus(st.id).status));
  try { e2.stop(st.id); } catch (e) { /* déjà arrêtée */ }
  await new Promise((r) => setTimeout(r, 300));
  try { fs.unlinkSync(path.join(__dirname, '..', 'campaigns_state', tenantId + '.json')); } catch (e) { /* absent */ }
});
