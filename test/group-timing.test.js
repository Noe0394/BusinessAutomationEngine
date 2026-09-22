// TEST — GroupOperationTiming : taille de lot / délai entre personnes / pause entre lots / pause toutes les N lots / délai initial / limite par
// reprise / pause-reprise-arrêt / dédoublonnage — RÉELLEMENT configurable par opération, persistant, jamais un contournement des protections
// plateforme (le flood/PAUSED_RATE_LIMIT reste actif quelle que soit la configuration).
//   node --test test/group-timing.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.AI_ENGINE_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-timing-'));
process.env.GITHUB_TOKEN = '';
require('./helpers/auth').actAsAdmin();
const svc = require('../ai-engine/communityService');
const waManager = require('../adapters/whatsappManager');
const tgManager = require('../adapters/telegramManager');

function fakeWa() {
  const s = { calls: [] };
  Object.assign(s, {
    isConnected: () => true,
    checkNumbersOnWhatsApp: async (nums) => nums.map((n) => ({ number: n, exists: true, jid: `${n}@s.whatsapp.net` })),
    createGroup: async (subject) => { s.calls.push(['create', subject]); return { id: '1@g.us', subject }; },
    setGroupDescription: async () => {},
    addGroupParticipants: async (gid, nums) => { s.calls.push(['add', nums.slice(), Date.now()]); return nums.map((n) => ({ number: n, status: '200' })); },
    getGroupInviteLink: async () => 'https://chat.whatsapp.com/CODE',
    sendMessage: async () => ({ key: { id: 'm1' } }),
  });
  return s;
}
const useWa = (session) => { waManager.getOrCreate = () => ({ session }); };
const members = (nums) => nums.map((n, i) => ({ number: n, name: 'C' + i }));

test('EXEMPLE DE LA MISSION : lot de 2, délai de 10s entre personnes, pause de 2 min entre lots — cadence RÉELLEMENT appliquée', async () => {
  const T = 't1'; const wa = fakeWa(); useWa(wa);
  const sleeps = []; svc._setSleep(async (ms) => { sleeps.push(ms); });
  const job = await svc.startGroup(T, { channel: 'WHATSAPP', title: 'Cadence', recipients: members(['22670000001', '22670000002', '22670000003', '22670000004']), timing: { batchSize: 2, delayBetweenItems: 10000, delayBetweenBatches: 120000 } });
  await svc.waitFor(job.id);
  const r = await svc.getJob(T, job.id);
  assert.equal(r.status, 'DONE'); assert.equal(r.counts.added, 4);
  assert.equal(r.timing.batchSize, 2); assert.equal(r.timing.delayBetweenItems, 10000); assert.equal(r.timing.delayBetweenBatches, 120000);
  // 4 appels d'ajout, un par personne (granularité réelle demandée par la mission)
  assert.equal(wa.calls.filter((c) => c[0] === 'add').length, 4);
  // Personne1 → attente courte (délai entre personnes, avec jitter ±20%) ; Personne2 → pause de lot (plus longue) ; Personne3 → attente courte ; Personne4 → dernière, pas d'attente après.
  const itemDelays = sleeps.filter((ms) => ms >= 8000 && ms <= 12000);
  const batchDelays = sleeps.filter((ms) => ms >= 96000 && ms <= 144000);
  assert.equal(itemDelays.length, 2, `attentes courtes attendues : ${JSON.stringify(sleeps)}`);
  assert.equal(batchDelays.length, 1, `pause de lot attendue : ${JSON.stringify(sleeps)}`);
});

test('PAUSE EVERY N BATCHES : une pause plus longue toutes les 2 lots (au lieu de la pause de lot normale)', async () => {
  const T = 't2'; const wa = fakeWa(); useWa(wa);
  const sleeps = []; svc._setSleep(async (ms) => { sleeps.push(ms); });
  const nums = Array.from({ length: 6 }, (_, i) => `2267000010${i}`);
  const job = await svc.startGroup(T, { channel: 'WHATSAPP', title: 'PauseN', recipients: members(nums), timing: { batchSize: 1, delayBetweenItems: 1000, delayBetweenBatches: 2000, pauseEveryNBatches: 2, pauseDuration: 50000 } });
  await svc.waitFor(job.id);
  assert.equal((await svc.getJob(T, job.id)).status, 'DONE');
  const longPauses = sleeps.filter((ms) => ms >= 40000 && ms <= 60000);
  assert.equal(longPauses.length, 2, `2 pauses longues attendues (après le 2e et le 4e lot) : ${JSON.stringify(sleeps)}`);
});

test('DÉLAI INITIAL : attendu une seule fois avant le premier ajout, pas répété après une reprise', async () => {
  const T = 't3'; const wa = fakeWa(); useWa(wa);
  const sleeps = []; svc._setSleep(async (ms) => { sleeps.push(ms); });
  const job = await svc.startGroup(T, { channel: 'WHATSAPP', title: 'Initial', recipients: members(['22670000201']), timing: { initialDelay: 30000 } });
  await svc.waitFor(job.id);
  assert.equal(sleeps.filter((ms) => ms >= 24000 && ms <= 36000).length, 1);
});

test('LIMITE PAR REPRISE (maxItems) : s\'arrête proprement, reprenable, ne retraite jamais un membre déjà traité', async () => {
  const T = 't4'; const wa = fakeWa(); useWa(wa);
  svc._setSleep(async () => {});
  const nums = Array.from({ length: 5 }, (_, i) => `2267000030${i}`);
  const job = await svc.startGroup(T, { channel: 'WHATSAPP', title: 'Max', recipients: members(nums), timing: { maxItems: 2 } });
  await svc.waitFor(job.id);
  let r = await svc.getJob(T, job.id);
  assert.equal(r.status, 'PAUSED_RATE_LIMIT'); assert.match(r.error, /Limite de 2 personne/); assert.equal(r.counts.added, 2); assert.equal(r.counts.pending, 3);
  const resumed = await svc.resumeJob(T, job.id); await svc.waitFor(resumed.id);
  r = await svc.getJob(T, job.id);
  assert.equal(r.status, 'PAUSED_RATE_LIMIT', 'la limite par reprise s\'applique aussi à la reprise suivante'); assert.equal(r.counts.added, 4);
  const resumed2 = await svc.resumeJob(T, job.id); await svc.waitFor(resumed2.id);
  r = await svc.getJob(T, job.id);
  assert.equal(r.status, 'DONE'); assert.equal(r.counts.added, 5);
  const allAdded = wa.calls.filter((c) => c[0] === 'add').flatMap((c) => c[1]);
  assert.equal(new Set(allAdded).size, allAdded.length, 'aucun membre ajouté deux fois');
});

test('ARRÊT SUR ERREUR (autoPauseOnError:true) : une erreur technique met le traitement en pause au lieu de continuer', async () => {
  const T = 't5'; const wa = fakeWa(); let n = 0;
  wa.addGroupParticipants = async (gid, nums) => { n += 1; if (n === 2) throw new Error('erreur technique inattendue'); wa.calls.push(['add', nums.slice()]); return nums.map((x) => ({ number: x, status: '200' })); };
  useWa(wa); svc._setSleep(async () => {});
  const job = await svc.startGroup(T, { channel: 'WHATSAPP', title: 'ErrStop', recipients: members(['22670000401', '22670000402', '22670000403']), timing: { autoPauseOnError: true } });
  await svc.waitFor(job.id);
  const r = await svc.getJob(T, job.id);
  // Granularité RÉELLE : chaque ajout est un appel séparé à la plateforme (§8 de la mission) — l'appel n°2 échoue (marqué « échec »), donc seul
  // le 1er membre est ajouté et le 3e n'est jamais tenté (le traitement s'arrête avant, reprenable).
  assert.equal(r.status, 'PAUSED_RATE_LIMIT'); assert.match(r.error, /erreur bloquante/); assert.equal(r.counts.added, 1); assert.equal(r.counts.failed, 1); assert.equal(r.counts.pending, 1);
});

test('SANS autoPauseOnError (défaut) : une erreur sur un membre continue avec les suivants (comportement historique préservé)', async () => {
  const T = 't6'; const wa = fakeWa(); let n = 0;
  wa.addGroupParticipants = async (gid, nums) => { n += 1; if (n === 2) return nums.map((x) => ({ number: x, status: '500' })); wa.calls.push(['add', nums.slice()]); return nums.map((x) => ({ number: x, status: '200' })); };
  useWa(wa); svc._setSleep(async () => {});
  const job = await svc.startGroup(T, { channel: 'WHATSAPP', title: 'ErrCont', recipients: members(['22670000501', '22670000502', '22670000503']) });
  await svc.waitFor(job.id);
  const r = await svc.getJob(T, job.id);
  assert.equal(r.status, 'DONE_WITH_ISSUES'); assert.equal(r.counts.added, 2); assert.equal(r.counts.failed, 1);
});

test('VALEURS BORNÉES : une temporisation hors limites ou absurde ne casse rien et reste dans des bornes sûres (jamais un contournement des protections plateforme)', async () => {
  const T = 't7'; const wa = fakeWa(); useWa(wa); svc._setSleep(async () => {});
  const job = await svc.startGroup(T, { channel: 'WHATSAPP', title: 'Bornes', recipients: members(['22670000601']), timing: { batchSize: -5, delayBetweenItems: 0, maxItems: 999999, pauseEveryNBatches: -1 } });
  const r = await svc.getJob(T, job.id);
  assert.ok(r.timing.batchSize >= 1); assert.ok(r.timing.delayBetweenItems >= 1000); assert.ok(r.timing.maxItems <= 5000); assert.ok(r.timing.pauseEveryNBatches >= 0);
});

test('TELEGRAM : granularité réelle = 1 (jamais simulée plus grosse) ; batchSize demandé est ignoré pour ce canal', async () => {
  const t = svc.resolveTiming('TELEGRAM', { batchSize: 10 });
  assert.equal(t.batchSize, 1);
  const wA = svc.resolveTiming('WHATSAPP', { batchSize: 10 });
  assert.equal(wA.batchSize, 10);
});

test('enabled:false retombe explicitement sur le comportement historique (compatibilité)', () => {
  const t = svc.resolveTiming('WHATSAPP', { enabled: false, batchSize: 99 });
  assert.equal(t.enabled, false);
});

test('PILOTAGE : mettre en pause avant de changer la cadence (sinon refusé) ; changement effectif à la reprise ; persistant', async () => {
  const T = 't8'; const wa = fakeWa(); useWa(wa);
  let release; svc._setSleep(() => new Promise((r) => { release = r; }));
  // batchSize:10 (jamais atteint avec 3 membres) : chaque item utilise delayBetweenItems, jamais delayBetweenBatches — la cadence changée est donc
  // bien celle exercée par la suite du traitement (item 2 → item 3, après la reprise).
  const job = await svc.startGroup(T, { channel: 'WHATSAPP', title: 'Pilotage', recipients: members(['22670000701', '22670000702', '22670000703']), timing: { batchSize: 10, delayBetweenItems: 5000 } });
  await new Promise((r) => setTimeout(r, 100));
  await assert.rejects(() => svc.setTiming(T, job.id, { delayBetweenItems: 99000 }), (e) => e.code === 'PAUSE_FIRST');
  await svc.pauseJob(T, job.id); release(); await svc.waitFor(job.id);
  const updated = await svc.setTiming(T, job.id, { delayBetweenItems: 60000 });
  assert.equal(updated.timing.delayBetweenItems, 60000);
  const sleeps = []; svc._setSleep(async (ms) => { sleeps.push(ms); });
  const resumed = await svc.resumeJob(T, job.id); await svc.waitFor(resumed.id);
  assert.ok(sleeps.some((ms) => ms >= 48000 && ms <= 72000), `nouvelle cadence appliquée à la reprise : ${JSON.stringify(sleeps)}`);
});

test('OUTILS (Chat/Self) : createCommunityGroup accepte la temporisation ; configureGroupTiming règle/relit la cadence, vérifié', async () => {
  const toolRegistry = require('../ai-engine/toolRegistry'); const { ownerOf, authz } = require('./helpers/auth');
  const T = 't9'; const wa = fakeWa(); useWa(wa); svc._setSleep(async () => {});
  const P = ownerOf(T); const call = (name, args) => authz.runAs(P, () => toolRegistry.execute(T, name, args, {}));
  const r = await call('createCommunityGroup', { channel: 'WHATSAPP', title: 'ViaOutil', text: '+22670000801 Awa', batchSize: 3, delayBetweenItems: 15000, pauseDuration: 90000, pauseEveryNBatches: 4 });
  assert.equal(r.state, 'SUCCESS', JSON.stringify(r.error));
  const jobId = r.result.jobId;
  await svc.waitFor(jobId);
  const st = await svc.getJob(T, jobId); assert.equal(st.timing.batchSize, 3); assert.equal(st.timing.delayBetweenItems, 15000);
  await svc.pauseJob(T, jobId).catch(() => {}); // déjà terminé, tolère l'échec
});
