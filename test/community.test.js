// TEST — modules Communautés : création/invitation de groupes (respect de la confidentialité, DM d'invitation, cadence, pause anti-flood,
// reprise, un seul job à la fois, opt-out, isolation) + découverte de communautés (Telegram/WhatsApp) + synchronisation CRM + liaison Chat
// intelligent / Tool Registry / interface. Moteurs WhatsApp/Telegram simulés (codes de statut réels : 200/403/408/409, USER_PRIVACY_RESTRICTED,
// PEER_FLOOD) — la vraie plateforme n'est pas appelée.
//   node --test test/community.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-comm-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;
process.env.GITHUB_TOKEN = '';
require('./helpers/auth').actAsAdmin();

const XLSX = require('xlsx');
const authz = require('../ai-engine/authz');
const svc = require('../ai-engine/communityService');
const disc = require('../ai-engine/communityDiscovery');
const contactCrm = require('../ai-engine/contactCrm');
const chatUploads = require('../ai-engine/chatUploads');
const toolRegistry = require('../ai-engine/toolRegistry');
const chatOrchestrator = require('../ai-engine/chatOrchestrator');
const waManager = require('../adapters/whatsappManager');
const tgManager = require('../adapters/telegramManager');

const sleeps = []; svc._setSleep(async (ms) => { sleeps.push(ms); }); disc._setSleep(async () => {});
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* nettoyage */ } });

const owner = (t) => authz.issuePrincipal({ tenant: t, role: 'OWNER', channel: 'WEB', via: 'test', allowedModules: ['whatsapp', 'telegram'] });
const customer = (t) => authz.issuePrincipal({ tenant: t, role: 'CUSTOMER', channel: 'WHATSAPP', via: 'test' });

// ---- faux moteur WhatsApp (mêmes primitives que adapters/whatsappEngineBaileys.js) ---------------------------------------------------
function fakeWa(opts) {
  const o = Object.assign({ statuses: {}, notOnWa: [], connected: true }, opts || {});
  const s = { calls: [], dms: [], added: [], groups: [], participants: {} };
  Object.assign(s, {
    isConnected: () => o.connected,
    checkNumbersOnWhatsApp: async (nums) => nums.map((n) => ({ number: n, exists: !o.notOnWa.includes(n), jid: `${n}@s.whatsapp.net` })),
    getGroupsSummary: async () => s.groups.map((g) => Object.assign({ size: (s.participants[g.id] || []).length }, g)),
    getGroupParticipants: async (id) => s.participants[id] || [],
    createGroup: async (subject) => { s.calls.push(['create', subject]); const g = { id: '120363999@g.us', subject, name: subject, isAdmin: true }; s.groups.push(g); s.participants[g.id] = []; return g; },
    setGroupDescription: async () => {},
    addGroupParticipants: async (gid, nums) => { s.calls.push(['add', nums.slice()]); if (o.floodOn && nums.includes(o.floodOn)) throw new Error('rate-overlimit'); return nums.map((n) => { const st = o.statuses[n] || '200'; if (st === '200') { s.added.push(n); (s.participants[gid] || (s.participants[gid] = [])).push({ id: `${n}@s.whatsapp.net`, phoneNumber: n }); } return { number: n, status: st }; }); },
    getGroupInviteLink: async () => 'https://chat.whatsapp.com/AbCdEfGhIjKlMnOp',
    sendMessage: async (jid, text) => { s.dms.push({ jid, text }); return { key: { id: 'm' + s.dms.length } }; },
    getInviteInfo: async (code) => { if (code === 'EXPIREDEXPIREDEXPIRED') throw new Error('gone'); return { subject: 'Groupe ' + code.slice(0, 4), size: 120, description: 'desc' }; },
  });
  return s;
}
const useWa = (session) => { waManager.getOrCreate = () => ({ session }); };
const useTg = (session) => { tgManager.getOrCreate = () => ({ session }); };
const members = (nums) => nums.map((n, i) => ({ number: n, name: 'C' + i }));

// ============================================================================ création de groupe WhatsApp
test('WHATSAPP : ajout direct si possible ; 403/408 → lien d\'invitation OFFICIEL en DM ; absents/opt-out ignorés ; rapport réel par membre', async () => {
  const T = 'tWa1';
  const wa = fakeWa({ statuses: { 22670000002: '403', 22670000003: '408', 22670000004: '409', 22670000005: '401' }, notOnWa: ['22670000006'] });
  useWa(wa);
  await contactCrm.markOptOut(T, 'WHATSAPP', '22670000007@s.whatsapp.net', 'STOP');
  const job = await svc.startGroup(T, { channel: 'WHATSAPP', title: 'Formation Marketing — Promo 1', recipients: members(['22670000001', '22670000002', '22670000003', '22670000004', '22670000005', '22670000006', '22670000007', '22670000001']) });
  await svc.waitFor(job.id);
  const r = await svc.getJob(T, job.id);
  assert.equal(r.status, 'DONE_WITH_ISSUES');
  assert.equal(r.group.subject, 'Formation Marketing — Promo 1'); assert.match(r.group.link, /^https:\/\/chat\.whatsapp\.com\//);
  const st = Object.fromEntries(r.members.map((m) => [m.identifier, m.status]));
  assert.equal(st['22670000001'], 'added'); assert.equal(st['22670000002'], 'invited_dm'); assert.equal(st['22670000003'], 'invited_dm');
  assert.equal(st['22670000004'], 'already_member'); assert.equal(st['22670000005'], 'failed'); assert.equal(st['22670000006'], 'not_on_platform'); assert.equal(st['22670000007'], 'opted_out');
  assert.equal(r.counts.total, 7, 'doublon retiré');
  // privacy : aucune tentative d'ajout pour absents/opt-out ; DM uniquement pour ceux dont l'ajout direct est restreint
  const addedNums = wa.calls.filter((c) => c[0] === 'add').flatMap((c) => c[1]);
  assert.ok(!addedNums.includes('22670000006') && !addedNums.includes('22670000007'));
  assert.deepEqual(wa.dms.map((d) => d.jid).sort(), ['22670000002@s.whatsapp.net', '22670000003@s.whatsapp.net']);
  assert.ok(wa.dms.every((d) => d.text.includes('https://chat.whatsapp.com/AbCdEfGhIjKlMnOp') && d.text.includes('Formation Marketing')));
  assert.ok(sleeps.length > 0, 'cadence espacée entre les lots et les DM');
});

test('WHATSAPP : liste issue d\'un fichier EXCEL (pipeline contacts existant : normalisation, doublons, invalides écartés)', async () => {
  const T = 'tWa2'; const wa = fakeWa(); useWa(wa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Nom', 'Téléphone'], ['Awa', '22670111111'], ['Issa', '22670222222'], ['Awa bis', '22670111111'], ['Faux', '12']]), 'Clients');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const job = await svc.startGroup(T, { channel: 'WHATSAPP', title: 'Clients VIP', file: { buffer, name: 'clients.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } });
  await svc.waitFor(job.id);
  const r = await svc.getJob(T, job.id);
  assert.equal(r.counts.total, 2); assert.equal(r.counts.added, 2); assert.equal(r.status, 'DONE');
  assert.deepEqual(wa.added.sort(), ['22670111111', '22670222222']);
});

test('WHATSAPP : ajoute une liste dédupliquée à un groupe existant réel et confirme les nouveaux membres', async () => {
  const T = 'tExistingGroup'; const wa = fakeWa(); useWa(wa);
  const id = '120363123456@g.us';
  wa.groups.push({ id, name: 'Formation Cuisine', subject: 'Formation Cuisine', isAdmin: true, channel: 'WHATSAPP' });
  wa.participants[id] = [{ id: '22670000999@s.whatsapp.net', phoneNumber: '22670000999' }];
  const found = await svc.listExistingGroups(T, 'WHATSAPP');
  assert.equal(found[0].id, id); assert.equal(found[0].name, 'Formation Cuisine');
  const job = await svc.addMembersToGroup(T, { channel: 'WHATSAPP', groupName: 'Formation Cuisine', recipients: members(['22670000999', '22670000123', '22670000123']) });
  await svc.waitFor(job.id);
  const result = await svc.getJob(T, job.id);
  assert.equal(result.operation, 'ADD_TO_EXISTING'); assert.equal(result.group.id, id); assert.equal(result.status, 'DONE');
  assert.equal(result.counts.total, 2); assert.equal(result.counts.duplicate_input, 1); assert.equal(result.counts.already_member, 1);
  assert.equal(result.counts.added, 1); assert.equal(result.counts.verified_added, 1); assert.equal(result.counts.unverified_added, 0);
  assert.equal(wa.calls.filter((c) => c[0] === 'create').length, 0, 'aucun groupe parallèle créé');
  assert.equal(wa.calls.filter((c) => c[0] === 'add').flatMap((c) => c[1]).join(','), '22670000123');
  await assert.rejects(() => svc.resolveExistingGroup(T, 'WHATSAPP', { groupName: 'Absent' }), (e) => e.code === 'GROUP_NOT_FOUND');
});

test('WHATSAPP : liste issue d\'un texte collé et d\'une IMAGE (OCR)', async () => {
  const wa = fakeWa(); useWa(wa);
  const j1 = await svc.startGroup('tWa3', { channel: 'WHATSAPP', title: 'Texte', text: 'Awa +226 70 33 33 33\nIssa 22670444444' });
  await svc.waitFor(j1.id); assert.equal((await svc.getJob('tWa3', j1.id)).counts.added, 2);
  const ocr = require('../ai-engine/ocrProvider'); const orig = ocr.recognize;
  ocr.recognize = async () => ({ text: 'Liste: 22670555555 Fatou\n22670666666 Moussa', words: [] });
  try {
    const j2 = await svc.startGroup('tWa4', { channel: 'WHATSAPP', title: 'Image', image: Buffer.from([1, 2, 3]) });
    await svc.waitFor(j2.id); assert.equal((await svc.getJob('tWa4', j2.id)).counts.added, 2);
  } finally { ocr.recognize = orig; }
});

test('WHATSAPP : limitation de débit → PAUSE automatique (jamais d\'insistance) puis REPRISE des membres restants', async () => {
  const T = 'tWa5'; const wa = fakeWa({ floodOn: '22670000014' }); useWa(wa);
  const job = await svc.startGroup(T, { channel: 'WHATSAPP', title: 'Flood', recipients: members(['22670000011', '22670000012', '22670000013', '22670000014', '22670000015', '22670000016']) });
  await svc.waitFor(job.id);
  let r = await svc.getJob(T, job.id);
  assert.equal(r.status, 'PAUSED_RATE_LIMIT'); assert.match(r.error, /reprise possible/);
  assert.equal(r.counts.added, 3, 'le premier lot est passé'); assert.equal(r.counts.pending, 3, 'les autres attendent : contexte conservé');
  const callsAtPause = wa.calls.length;
  wa.addGroupParticipants = async (gid, nums) => nums.map((n) => { wa.added.push(n); (wa.participants[gid] || (wa.participants[gid] = [])).push({ id: `${n}@s.whatsapp.net`, phoneNumber: n }); return { number: n, status: '200' }; }); // limitation levée, membres reflétés par le groupe simulé
  const resumed = await svc.resumeJob(T, job.id); await svc.waitFor(resumed.id);
  r = await svc.getJob(T, job.id);
  assert.equal(r.status, 'DONE'); assert.equal(r.counts.added, 6);
  assert.ok(wa.calls.length === callsAtPause, 'un seul groupe créé (la reprise ne recrée rien)');
});

test('un SEUL traitement à la fois par compte et canal ; titre et canal validés ; WhatsApp non connecté → échec explicite', async () => {
  const T = 'tWa6'; const wa = fakeWa(); useWa(wa);
  let release; svc._setSleep(() => new Promise((r) => { release = r; }));
  const j1 = await svc.startGroup(T, { channel: 'WHATSAPP', title: 'Premier', recipients: members(['22670000021', '22670000022', '22670000023', '22670000024']) });
  await assert.rejects(() => svc.startGroup(T, { channel: 'WHATSAPP', title: 'Deuxième', recipients: members(['22670000025']) }), (e) => e.code === 'JOB_ALREADY_RUNNING');
  await svc.startGroup('tWa6b', { channel: 'WHATSAPP', title: 'Autre compte', recipients: members(['22670000026']) }).then((j) => svc.waitFor(j.id)); // un autre compte n'est pas bloqué
  svc._setSleep(async () => {}); if (release) release(); await svc.waitFor(j1.id);
  await assert.rejects(() => svc.startGroup(T, { channel: 'WHATSAPP', title: 'x', recipients: members(['1']) }), (e) => e.code === 'TITLE_REQUIRED');
  await assert.rejects(() => svc.startGroup(T, { channel: 'SIGNAL', title: 'Groupe', recipients: members(['22670000027']) }), (e) => e.code === 'INVALID_CHANNEL');
  await assert.rejects(() => svc.startGroup(T, { channel: 'WHATSAPP', title: 'Vide', recipients: [] }), (e) => e.code === 'NO_VALID_MEMBER');
  useWa(fakeWa({ connected: false }));
  const off = await svc.startGroup('tWa7', { channel: 'WHATSAPP', title: 'Hors ligne', recipients: members(['22670000028']) }); await svc.waitFor(off.id);
  const r = await svc.getJob('tWa7', off.id); assert.equal(r.status, 'FAILED'); assert.equal(r.error, 'WHATSAPP_NOT_CONNECTED');
});

test('ISOLATION : un compte ne voit jamais les groupes/rapports d\'un autre compte', async () => {
  const wa = fakeWa(); useWa(wa);
  const j = await svc.startGroup('tIsoA', { channel: 'WHATSAPP', title: 'Privé A', recipients: members(['22670000031']) }); await svc.waitFor(j.id);
  assert.equal(await svc.getJob('tIsoB', j.id), null);
  assert.equal((await svc.listJobs('tIsoB')).length, 0);
  await assert.rejects(() => svc.resumeJob('tIsoB', j.id), (e) => e.code === 'NOT_FOUND');
});

// ============================================================================ création de groupe Telegram
test('TELEGRAM : ajout direct ; USER_PRIVACY_RESTRICTED / missingInvitees → lien d\'invitation en DM ; entité BigInt jamais persistée ; PEER_FLOOD → pause', async () => {
  const T = 'tTg1'; const dms = []; const invited = [];
  const tg = {
    isConnected: () => true,
    resolveRecipient: async (id) => { if (id === '+22670999999') throw new Error('RECIPIENT_NOT_FOUND'); return { id: 100n + BigInt(String(id).length), ident: id }; },
    createCommunityGroup: async () => ({ id: '555', entity: { id: 555n, accessHash: 9007199254740993n } }),
    getGroupEntity: async (id) => ({ id: BigInt(id) }),
    getGroupMembers: async () => invited.map((ident) => ({ id: String(100 + String(ident).length), username: ident.startsWith('@') ? ident.slice(1) : null, phone: ident.replace(/\D/g, '') })),
    inviteUserToGroup: async (g, u) => {
      if (u.ident === '+22670000002') throw Object.assign(new Error('x'), { errorMessage: 'USER_PRIVACY_RESTRICTED' });
      if (u.ident === '@prive') return { added: false, privacyRestricted: true };
      if (u.ident === '+22670000004') throw Object.assign(new Error('x'), { errorMessage: 'PEER_FLOOD' });
      invited.push(u.ident); return { added: true };
    },
    exportGroupInviteLink: async () => 'https://t.me/+AAAAAAAAAAAA',
    sendMessage: async (u, text) => { dms.push({ to: u.ident, text }); },
  };
  useTg(tg);
  const job = await svc.startGroup(T, { channel: 'TELEGRAM', title: 'Communauté Telegram', recipients: [{ identifier: '+22670000001', name: 'A' }, { identifier: '+22670000002', name: 'B' }, { identifier: '@prive', name: 'C' }, { identifier: '+22670999999', name: 'D' }, { identifier: '+22670000004', name: 'E' }, { identifier: '+22670000005', name: 'F' }] });
  await svc.waitFor(job.id);
  const r = await svc.getJob(T, job.id);
  assert.equal(r.status, 'PAUSED_RATE_LIMIT', 'PEER_FLOOD : pause pour protéger le compte');
  const st = Object.fromEntries(r.members.map((m) => [m.identifier, m.status]));
  assert.equal(st['+22670000001'], 'added'); assert.equal(st['+22670000002'], 'needs_invite'); assert.equal(st['@prive'], 'needs_invite'); assert.equal(st['+22670999999'], 'not_on_platform');
  assert.ok(!JSON.stringify(fs.readdirSync(TMP, { recursive: true })).includes('undefined'));
  // reprise : la limitation est levée -> les invitations DM partent, sans recréer le groupe
  tg.inviteUserToGroup = async (g, u) => { invited.push(u.ident); return { added: true }; };
  const res = await svc.resumeJob(T, job.id); await svc.waitFor(res.id);
  const r2 = await svc.getJob(T, job.id);
  assert.equal(r2.status, 'DONE'); assert.equal(r2.counts.invited_dm, 2);
  assert.deepEqual(dms.map((d) => d.to).sort(), ['+22670000002', '@prive']);
  assert.ok(dms.every((d) => d.text.includes('https://t.me/+AAAAAAAAAAAA')));
});

// ============================================================================ découverte
test('TELEGRAM : recherche globale → seuls les canaux/groupes PUBLICS (avec @username et lien officiel), dédoublonnés par mot-clé', async () => {
  const T = 'tDisc1';
  useTg({ isConnected: () => true, searchPublicCommunities: async (q) => (q === 'marketing' ? [{ id: '1', title: 'Marketing Pro', username: 'marketingpro', isChannel: true, participants: 5400 }, { id: '2', title: 'Growth FR', username: 'growthfr', isChannel: false, participants: 1200 }] : [{ id: '1', title: 'Marketing Pro', username: 'marketingpro', isChannel: true, participants: 5400 }]) });
  const out = await disc.discover(T, { channel: 'TELEGRAM', keywords: 'Marketing, digital ; a', sync: true });
  assert.deepEqual(out.keywords, ['marketing', 'digital']);
  assert.equal(out.results.length, 2);
  const mp = out.results.find((c) => c.ref === '@marketingpro');
  assert.equal(mp.link, 'https://t.me/marketingpro'); assert.equal(mp.kind, 'channel'); assert.equal(mp.members, 5400); assert.deepEqual(mp.keywords.sort(), ['digital', 'marketing']);
  assert.equal(out.synced, 2);
  await assert.rejects(() => disc.discover(T, { channel: 'TELEGRAM', keywords: '' }), (e) => e.code === 'KEYWORDS_REQUIRED');
  useTg({ isConnected: () => false });
  await assert.rejects(() => disc.discover(T, { channel: 'TELEGRAM', keywords: 'x1' }), (e) => e.code === 'TELEGRAM_NOT_CONNECTED');
});

test('WHATSAPP : liens d\'annuaires publics VÉRIFIÉS auprès de WhatsApp (nom/taille réels) ; lien expiré écarté ; sans session : « non vérifié »', async () => {
  const html = '<a href="https://chat.whatsapp.com/AbCdEfGhIjKlMnOp">x</a> chat.whatsapp.com/EXPIREDEXPIREDEXPIRED chat.whatsapp.com/ZzZzZzZzZzZzZzZz &amp; chat.whatsapp.com/AbCdEfGhIjKlMnOp';
  assert.deepEqual(disc.extractInviteCodes(html).sort(), ['AbCdEfGhIjKlMnOp', 'EXPIREDEXPIREDEXPIRED', 'ZzZzZzZzZzZzZzZz']);
  const directorySearch = async () => disc.extractInviteCodes(html);
  useWa(fakeWa());
  const ok = await disc.discover('tDisc2', { channel: 'WHATSAPP', keywords: 'immobilier' }, { directorySearch });
  assert.equal(ok.results.length, 2, 'le lien expiré est écarté'); assert.ok(ok.results.every((c) => c.verified === true && c.members === 120));
  assert.ok(ok.results.every((c) => /^https:\/\/chat\.whatsapp\.com\//.test(c.link)));
  useWa(fakeWa({ connected: false }));
  const off = await disc.discover('tDisc2', { channel: 'WHATSAPP', keywords: 'immobilier' }, { directorySearch });
  assert.ok(off.results.length === 3 && off.results.every((c) => c.verified === false && /non vérifié/.test(c.name)), 'jamais présenté comme confirmé');
});

test('SYNCHRONISATION CRM : communautés enregistrées dans la base CRM, SÉPARÉES des contacts-personnes (jamais ciblées par une campagne)', async () => {
  const T = 'tCrm1';
  useTg({ isConnected: () => true, searchPublicCommunities: async () => [{ id: '9', title: 'Immo Afrique', username: 'immoafrique', isChannel: true, participants: 900 }] });
  await disc.discover(T, { channel: 'TELEGRAM', keywords: 'immobilier', sync: true });
  await disc.discover(T, { channel: 'TELEGRAM', keywords: 'afrique', sync: true }); // deuxième synchro : mise à jour, pas de doublon
  const list = await contactCrm.listCommunities(T, { channel: 'TELEGRAM' });
  assert.equal(list.length, 1); assert.deepEqual(list[0].keywords.sort(), ['afrique', 'immobilier']); assert.ok(list[0].tags.includes('communauté'));
  assert.equal((await contactCrm.list(T)).length, 0, 'aucune communauté parmi les contacts-personnes');
  assert.equal((await contactCrm.listCommunities('tCrm2')).length, 0, 'isolation entre comptes');
});

// ============================================================================ Chat intelligent / Tool Registry
test('Tool de fonctionnalité enregistré dynamiquement est découvert et appelé par le routeur générique', async () => {
  const toolName = 'renderVpsCapabilityProbe'; let executions = 0; let llmCalls = 0;
  const toolDefinition = {
    feature: 'test-vps-feature', capabilities: ['export', 'natural-language'], description: 'Exporte un rapport de test réellement disponible.',
    permission: null, risk: 'LOW_WRITE', inputSchema: {},
    async execute() { executions += 1; return { ok: true, result: { reportId: 'real-report-1' } }; },
    async verify(result) { return { verified: result.reportId === 'real-report-1' }; },
  };
  toolRegistry.registerTool(toolName, toolDefinition);
  assert.equal(toolRegistry.registerTool(toolName, toolDefinition), toolName, 'un rechargement idempotent ne duplique pas le tool');
  const described = toolRegistry.describe();
  assert.ok(described.length >= 100, 'le registre expose les tools hérités réellement présents');
  assert.ok(described.every((t) => t.feature && t.capabilities.length), 'tous les tools hérités ont un domaine et des capacités exposés');
  const llm = async (prompt) => {
    if (prompt.includes('Réponds UNIQUEMENT en JSON')) {
      llmCalls += 1;
      return llmCalls === 1 ? JSON.stringify({ tool: toolName, args: {} }) : JSON.stringify({ done: true });
    }
    return 'Le rapport réel a été exporté.';
  };
  const result = await authz.runAs(owner('tDynamicTool'), () => chatOrchestrator.handle(
    { text: 'Exporte mes rapports de test', tenantId: 'tDynamicTool', sessionId: 'dynamic-tool' }, { llm },
  ));
  assert.equal(executions, 1); assert.equal(result.toolCall.name, toolName); assert.equal(result.toolCall.state, 'SUCCESS');
  assert.ok(toolRegistry.describe().find((t) => t.name === toolName).capabilities.includes('natural-language'));
});

test('un nouveau module tool-modules est découvert automatiquement et supporte le rechargement', () => {
  const dir = path.join(__dirname, '..', 'ai-engine', 'tool-modules');
  const file = path.join(dir, 'renderNaturalLanguageDiscovery.js');
  const hadDir = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, "module.exports = { renderLoadedFeatureProbe: { feature: 'test-discovery', capabilities: ['natural-language'], description: 'Probe de découverte automatique.', execute: async () => ({ ok: true, result: { discovered: true } }) } };\n");
  try {
    toolRegistry.loadToolModules();
    toolRegistry.loadToolModules();
    const meta = toolRegistry.describe().find((t) => t.name === 'renderLoadedFeatureProbe');
    assert.ok(meta); assert.equal(meta.feature, 'test-discovery'); assert.deepEqual(meta.capabilities, ['natural-language']);
  } finally {
    delete require.cache[require.resolve(file)];
    fs.rmSync(file, { force: true });
    if (!hadDir) fs.rmdirSync(dir);
  }
});

test('les outils du Studio IA sont filtrés par licence et bloqués aussi à l’exécution; Facebook reste accessible comme module libre', async () => {
  const T = 'tModuleGate';
  const principal = owner(T);
  const allowedModules = ['whatsapp', 'telegram'];
  const visible = toolRegistry.list({ principal, allowedModules }).map((t) => t.name);
  assert.ok(!visible.includes('listAiStudioSessions'));
  assert.ok(!visible.includes('generateImage'));
  assert.ok(visible.includes('getFacebookConnectionStatus'));
  const result = await authz.runAs(principal, () => toolRegistry.execute(T, 'listAiStudioSessions', {}, {
    allowedModules,
    aiStudioStore: { async listSessions() { throw new Error('ne doit pas être appelé'); } },
  }));
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.error.code, 'MODULE_NOT_ALLOWED');
  const image = await authz.runAs(principal, () => toolRegistry.execute(T, 'generateImage', { prompt: 'test' }, {
    allowedModules, generateImage() { throw new Error('ne doit pas être appelé'); },
  }));
  assert.equal(image.error.code, 'MODULE_NOT_ALLOWED');
});

test('TOOL REGISTRY : createCommunityGroup — identité obligatoire, rôle client refusé, tour teinté (fichier) → confirmation, puis exécution vérifiée', async () => {
  const T = 'tTool1'; const wa = fakeWa(); useWa(wa);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Nom', 'Telephone'], ['Awa', '22670777001'], ['Issa', '22670777002']]), 'S');
  const ref = await chatUploads.save(T, { originalname: 'liste.xlsx', mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) });
  const exec = (p, args, ctx, opts) => authz.runAs(p, () => toolRegistry.execute(T, 'createCommunityGroup', args, ctx || {}), opts);
  const args = { channel: 'WHATSAPP', title: 'Groupe Outil', fileId: ref.id };
  assert.equal((await exec(customer(T), args)).state, 'BLOCKED');
  assert.equal((await exec(customer(T), args)).error.code, 'ROLE_FORBIDDEN');
  const prep = await exec(owner(T), args, { permissions: ['messages:send'] }, { tainted: true });
  assert.equal(prep.state, 'NEEDS_CONFIRMATION'); assert.equal(prep.result.preview.contactsDetectes, 2);
  assert.equal(wa.calls.length, 0, 'rien n\'est créé avant confirmation');
  const done = await exec(owner(T), args, { permissions: ['messages:send'], confirmed: true }, { tainted: true });
  assert.equal(done.state, 'SUCCESS'); assert.ok(done.result.jobId);
  await svc.waitFor(done.result.jobId);
  assert.equal((await svc.getJob(T, done.result.jobId)).counts.added, 2);
  const other = await authz.runAs(owner('tAutre'), () => toolRegistry.execute('tAutre', 'createCommunityGroup', { channel: 'WHATSAPP', title: 'X', fileId: ref.id }, { permissions: ['messages:send'], confirmed: true }));
  assert.equal(other.state, 'BLOCKED'); assert.equal(other.error.code, 'RESOURCE_NOT_OWNED', 'le fichier d\'un autre compte est inaccessible');
});

test('CHAT INTELLIGENT : « crée un groupe » et « trouve des groupes publics » déclenchent les outils (même moteur que l\'interface), sans casser les commandes de groupes existantes', async () => {
  const T = 'tChat1'; const wa = fakeWa(); useWa(wa);
  const intents = (t) => chatOrchestrator.detectIntent(t, null);
  assert.equal(intents('Crée un groupe WhatsApp Formation Marketing avec ces contacts'), 'community');
  assert.equal(intents('Trouve des groupes Telegram publics sur le marketing digital'), 'community');
  assert.notEqual(intents('Liste mes groupes'), 'community');
  assert.notEqual(intents('Partage cette affiche dans mes groupes admin'), 'community');
  let step = 0; const plans = [{ tool: 'createCommunityGroup', args: { channel: 'WHATSAPP', title: 'Promo Chat', text: '22670888001 Awa\n22670888002 Issa' } }, { done: true }];
  const llm = async (prompt) => (/Réponds UNIQUEMENT en JSON/.test(prompt) ? JSON.stringify(plans[Math.min(step++, 1)]) : 'Le groupe « Promo Chat » est en cours de création.');
  for (const [channelLabel] of [['WEB'], ['WHATSAPP'], ['TELEGRAM']]) {
    step = 0; wa.calls.length = 0; wa.added.length = 0;
    const p = authz.issuePrincipal({ tenant: T, role: 'OWNER', channel: channelLabel, via: 'test', allowedModules: ['whatsapp', 'telegram'] });
    const r = await chatOrchestrator.handle({ text: 'Crée un groupe WhatsApp Promo Chat avec 22670888001 et 22670888002', history: [], tenantId: T, sessionId: 's-' + channelLabel, principal: p }, { llm, runtime: null });
    assert.ok(r && r.toolCall, `${channelLabel}: ${JSON.stringify(r)}`); assert.equal(r.intent, 'community', channelLabel); assert.equal(r.toolCall.name, 'createCommunityGroup'); assert.equal(r.toolCall.state, 'SUCCESS', JSON.stringify(r.toolCall));
    await svc.waitFor(r.toolCall.result.jobId);
    assert.deepEqual(wa.added.sort(), ['22670888001', '22670888002'], `${channelLabel} : même exécution`);
  }
  // découverte via le chat
  useTg({ isConnected: () => true, searchPublicCommunities: async () => [{ id: '3', title: 'Crypto FR', username: 'cryptofr', isChannel: true, participants: 100 }] });
  step = 0; const dplans = [{ tool: 'discoverCommunities', args: { channel: 'TELEGRAM', keywords: 'crypto' } }, { done: true }];
  const dllm = async (prompt) => (/Réponds UNIQUEMENT en JSON/.test(prompt) ? JSON.stringify(dplans[Math.min(step++, 1)]) : 'Voici les canaux trouvés.');
  const d = await chatOrchestrator.handle({ text: 'Trouve des canaux Telegram publics sur la crypto', history: [], tenantId: T, sessionId: 's-d', principal: owner(T) }, { llm: dllm, runtime: null });
  assert.equal(d.toolCall.name, 'discoverCommunities'); assert.equal(d.toolCall.result.communities[0].link, 'https://t.me/cryptofr');
});

// ============================================================================ interface + routes
test('INTERFACE + ROUTES : sections dans les onglets WhatsApp ET Telegram, routes protégées, script valide, aucun gestionnaire inline (compatible obfuscation)', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'dashboard.html'), 'utf8');
  assert.match(html, /id="cm-wa-section"/); assert.match(html, /id="cm-tg-section"/);
  // Les deux sections vivent dans un onglet dédié « Communautés », rattaché aux modules WhatsApp/Telegram de la licence (sinon masqué).
  const cm = html.slice(html.indexOf('id="panel-communities"'), html.indexOf('id="panel-reports"'));
  assert.ok(cm.includes('cm-wa-create-btn') && cm.includes('cm-tg-create-btn') && cm.includes('cm-wa-stop-btn') && cm.includes('cm-tg-stop-btn'));
  // Temporisation visible dans l'interface (pas seulement pilotable par l'IA) : champs de réglage à la création + ajustement pendant une pause.
  for (const p of ['wa', 'tg']) {
    for (const f of ['batch', 'items', 'batches', 'pause-every', 'pause-min', 'initial', 'max']) {
      assert.ok(cm.includes(`cm-${p}-timing-${f}`), `champ de temporisation manquant : cm-${p}-timing-${f}`);
      assert.ok(cm.includes(`cm-${p}-etiming-${f}`), `champ d'ajustement de temporisation manquant : cm-${p}-etiming-${f}`);
    }
    assert.ok(cm.includes(`cm-${p}-timing-edit-btn`) && cm.includes(`cm-${p}-etiming-apply-btn`));
    // Recherche parmi MES groupes visible dans l'interface (pas seulement accessible en discutant avec l'IA) — distincte de la découverte publique.
    assert.ok(cm.includes(`cm-${p}-mine-kw`) && cm.includes(`cm-${p}-mine-admin`) && cm.includes(`cm-${p}-mine-search-btn`) && cm.includes(`cm-${p}-mine-results`));
  }
  assert.match(html, /data-tab="communities"/); assert.match(html, /whatsapp: ['whatsapp', 'relance', 'communities']/); assert.match(html, /telegram: ['telegram', 'relance', 'communities']/);
  assert.ok(!/onclick=|onchange=|oninput=|onsubmit=/.test(html));
  const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi; let m; while ((m = re.exec(html))) assert.doesNotThrow(() => new Function(m[2]));
  const idx = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  for (const route of ["post('/api/communities/groups'", "get('/api/communities/groups'", "get('/api/communities/groups/:id'", "post('/api/communities/groups/:id/resume'", "post('/api/communities/groups/:id/timing'", "get('/api/communities/timing-bounds'", "get('/api/communities/my-groups'", "post('/api/communities/discover'", "get('/api/communities/directory'", "post('/api/communities/sync'"]) {
    const line = idx.split('\n').find((l) => l.includes(route)); assert.ok(line && /requireAccess/.test(line), route);
  }
  assert.match(idx, /MODULE_NOT_ALLOWED/);
});

// ============================================================================ arrêt + progression
test('ARRÊT : le traitement s\'arrête avant le prochain lot (CANCELLING → CANCELLED), le déjà-fait est conservé ; progression réelle', async () => {
  const T = 'tCancel1';
  const wa = fakeWa({});
  useWa(wa);
  let release; let gate = new Promise((r) => { release = r; });
  svc._setSleep(() => gate); // bloque après le premier lot
  const nums = Array.from({ length: 12 }, (_, i) => `2267000100${String(i).padStart(2, '0')}`);
  const job = await svc.startGroup(T, { channel: 'WHATSAPP', title: 'Groupe à arrêter', recipients: members(nums) });
  await new Promise((r) => setTimeout(r, 150));
  let mid = await svc.getJob(T, job.id);
  assert.ok(mid.progress.processed > 0 && mid.progress.processed < mid.progress.total, 'progression partielle réelle');
  assert.ok(mid.progress.percent > 0 && mid.progress.percent < 100);
  const req = await svc.cancelJob(T, job.id);
  assert.equal(req.status, 'CANCELLING');
  assert.equal((await svc.getJob(T, job.id)).status, 'CANCELLING');
  release(); await svc.waitFor(job.id);
  const end = await svc.getJob(T, job.id);
  assert.equal(end.status, 'CANCELLED'); assert.match(end.error, /conservés/);
  assert.ok(end.counts.added > 0 && end.counts.pending > 0, 'ajoutés conservés, reste non traité');
  const addCalls = wa.calls.filter((c) => c[0] === 'add').length;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(wa.calls.filter((c) => c[0] === 'add').length, addCalls, 'plus aucun ajout après l\'arrêt');
  svc._setSleep(async () => {});
  await assert.rejects(() => svc.cancelJob(T, job.id), (e) => e.code === 'INVALID_STATE');
  await assert.rejects(() => svc.cancelJob('autre-compte', job.id), (e) => e.code === 'NOT_FOUND', 'isolation');
});

test('ARRÊT d\'un traitement en pause (limite de débit) : passe directement à CANCELLED ; terminé = 100 %', async () => {
  const T = 'tCancel2';
  const wa = fakeWa({ floodOn: '22670002003' });
  useWa(wa);
  const job = await svc.startGroup(T, { channel: 'WHATSAPP', title: 'Groupe pause', recipients: members(['22670002001', '22670002002', '22670002003', '22670002004']) });
  await svc.waitFor(job.id);
  const paused = await svc.getJob(T, job.id);
  assert.equal(paused.status, 'PAUSED_RATE_LIMIT');
  const c = await svc.cancelJob(T, job.id);
  assert.equal(c.status, 'CANCELLED');
  const T3 = 'tCancel3'; useWa(fakeWa({}));
  const j3 = await svc.startGroup(T3, { channel: 'WHATSAPP', title: 'Groupe complet', recipients: members(['22670003001', '22670003002']) });
  await svc.waitFor(j3.id);
  assert.equal((await svc.getJob(T3, j3.id)).progress.percent, 100);
});

test('PAUSE / REPRISE à la demande + traitement INTERROMPU (redémarrage) : reprise là où il s\'est arrêté, rien n\'est refait', async () => {
  const T = 'tPause1';
  const wa = fakeWa({});
  useWa(wa);
  let release; const gate = new Promise((r) => { release = r; });
  svc._setSleep(() => gate);
  const nums = Array.from({ length: 12 }, (_, i) => `2267000200${String(i).padStart(2, '0')}`);
  const job = await svc.startGroup(T, { channel: 'WHATSAPP', title: 'Groupe pause user', recipients: members(nums) });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal((await svc.pauseJob(T, job.id)).status, 'PAUSING');
  release(); await svc.waitFor(job.id);
  const paused = await svc.getJob(T, job.id);
  assert.equal(paused.status, 'PAUSED_USER');
  const before = paused.counts.added; assert.ok(before > 0 && paused.counts.pending > 0);
  svc._setSleep(async () => {});
  await svc.resumeJob(T, job.id); await svc.waitFor(job.id);
  const done = await svc.getJob(T, job.id);
  assert.equal(done.status, 'DONE'); assert.equal(done.counts.added, 12); assert.equal(done.progress.percent, 100);
  const created = wa.calls.filter((c) => c[0] === 'create').length; assert.equal(created, 1, 'le groupe n\'est créé qu\'une fois');
  const allAdded = wa.calls.filter((c) => c[0] === 'add').flatMap((c) => c[1]); assert.equal(new Set(allAdded).size, allAdded.length, 'aucun membre ajouté deux fois');
  // traitement interrompu par un redémarrage : statut RUNNING en base sans exécution → INTERRUPTED, reprise possible
  const storage = require('../ai-engine/storageAdapter');
  const T2 = 'tPause2'; useWa(fakeWa({}));
  const j2 = await svc.startGroup(T2, { channel: 'WHATSAPP', title: 'Groupe orphelin', recipients: members(['22670004001', '22670004002']) });
  await svc.waitFor(j2.id);
  const doc = await storage.get('community_jobs', T2, null); doc.jobs[j2.id].status = 'RUNNING'; doc.jobs[j2.id].members[0].status = 'pending'; await storage.set('community_jobs', T2, doc);
  assert.equal((await svc.getJob(T2, j2.id)).status, 'INTERRUPTED');
  await svc.resumeJob(T2, j2.id); await svc.waitFor(j2.id);
  assert.equal((await svc.getJob(T2, j2.id)).status, 'DONE');
  // pause d'un traitement qui n'est pas en cours : refusé
  await assert.rejects(() => svc.pauseJob(T2, j2.id), (e) => e.code === 'INVALID_STATE');
});
