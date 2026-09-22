// TEST — opérations de groupe visibles dans Rapport & Activité (mission §18) : plateforme, groupe, nombre prévu/traité/réussi/échoué, pauses, durée,
// statut, intervention nécessaire ; diagnostic d'auto-amélioration sur des opérations de groupe réellement en difficulté (§19).
//   node --test test/group-report.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.AI_ENGINE_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-greport-'));
process.env.GITHUB_TOKEN = '';
require('./helpers/auth').actAsAdmin();
const svc = require('../ai-engine/communityService');
const intel = require('../ai-engine/activityIntelligence');
const waManager = require('../adapters/whatsappManager');

function fakeWa() {
  const s = { calls: [] };
  Object.assign(s, {
    isConnected: () => true,
    checkNumbersOnWhatsApp: async (nums) => nums.map((n) => ({ number: n, exists: true })),
    createGroup: async (subject) => { s.calls.push(['create', subject]); return { id: '1@g.us', subject }; },
    setGroupDescription: async () => {},
    addGroupParticipants: async (gid, nums) => nums.map((n) => ({ number: n, status: '200' })),
    getGroupInviteLink: async () => 'https://chat.whatsapp.com/X',
  });
  return s;
}
const members = (nums) => nums.map((n, i) => ({ number: n, name: 'C' + i }));

test("Rapport & Activité : une opération de groupe TERMINÉE apparaît FAITE, avec plateforme, groupe, prévu/traité/réussi, cadence", async () => {
  const T = 'gr1'; waManager.getOrCreate = () => ({ session: fakeWa() });
  svc._setSleep(async () => {});
  const job = await svc.startGroup(T, { channel: 'WHATSAPP', title: 'Grill Club', recipients: members(['22670000001', '22670000002']), timing: { batchSize: 2 } });
  await svc.waitFor(job.id);
  const rep = await intel.buildReport(T);
  const item = [...rep.sections.done].find((i) => i.actionType === 'group_operation');
  assert.ok(item, 'opération de groupe présente dans le rapport'); assert.match(item.title, /Grill Club \(WHATSAPP\)/);
  assert.match(item.detail, /2\/2 ajoutés/); assert.match(item.how, /lots de 2/);
});

test("Une opération BLOQUÉE (limite de débit) apparaît BLOQUÉE avec le motif réel, jamais « faite »", async () => {
  const T = 'gr2'; const wa = fakeWa(); wa.addGroupParticipants = async (gid, nums) => { throw new Error('rate-overlimit'); };
  waManager.getOrCreate = () => ({ session: wa }); svc._setSleep(async () => {});
  const job = await svc.startGroup(T, { channel: 'WHATSAPP', title: 'Limité', recipients: members(['22670000101']) });
  await svc.waitFor(job.id);
  const rep = await intel.buildReport(T);
  const item = [...rep.sections.blocked].find((i) => i.actionType === 'group_operation');
  assert.ok(item); assert.match(item.reason, /limité le débit/);
});

test("Isolation stricte : les opérations de groupe d'un autre compte n'apparaissent jamais", async () => {
  const T = 'gr3'; const OTHER = 'gr3_other';
  waManager.getOrCreate = () => ({ session: fakeWa() }); svc._setSleep(async () => {});
  const job = await svc.startGroup(OTHER, { channel: 'WHATSAPP', title: 'Secret', recipients: members(['22670000201']) });
  await svc.waitFor(job.id);
  const rep = await intel.buildReport(T);
  assert.ok(!JSON.stringify(rep).includes('Secret'));
});

test("Auto-amélioration : plusieurs opérations de groupe en échec/limitées cette semaine → recommandation réelle de ralentir la cadence", async () => {
  const T = 'gr4';
  const wa1 = fakeWa(); wa1.addGroupParticipants = async () => { throw new Error('rate-overlimit'); };
  waManager.getOrCreate = () => ({ session: wa1 }); svc._setSleep(async () => {});
  await svc.waitFor((await svc.startGroup(T, { channel: 'WHATSAPP', title: 'G1', recipients: members(['22670000301']) })).id);
  await svc.waitFor((await svc.startGroup(T, { channel: 'WHATSAPP', title: 'G2', recipients: members(['22670000302']) })).id);
  const { created } = await intel.refresh(T);
  const rec = created.find((r) => r.key === 'GROUP_OPS_STRUGGLING');
  assert.ok(rec, 'diagnostic réel basé sur les opérations réellement en difficulté'); assert.match(rec.recommendation, /Ralentir la cadence/);
});
