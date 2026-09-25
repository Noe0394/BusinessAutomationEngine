// TEST — VPS Runtime : bras d'exécution réel de la couche intelligence
// -----------------------------------------------------------------------------
// Vérifie le contrat du runtime (lib/intelligence/runtimes/vps-runtime.js)
// AVEC des gestionnaires simulés (whatsappManager/telegramManager/licences) :
// aucun envoi réel, mais toutes les méthodes concrètes sont exercées et le
// dispatch des 12 actions passe bien par le registre partagé (parité
// ZERO_VPS). Combiné à vps-bridge.test.js (câblage HTTP réel), il couvre le
// chemin execute()->registry->runtime->moteurs avec zéro réseau.
//
// Contrat vérifié :
//   - execute() délègue au registre (les 12 actions résolvent, inconnue = erreur) ;
//   - EXTRACT_MEMBERS -> memebres filtrés @lid -> persistés -> SEND_CAMPAIGN
//     recipientsSource:'extract' les réutilise ;
//   - PAUSE/RESUME_CAMPAIGN atteignent le moteur de campagne du canal ;
//   - GENERATE_ACCESS_KEY crée une vraie licence (stub) ;
//   - CREATE_USER_ACCOUNT retombe sur le repli local (jamais d'échec) ;
//   - GENERATE_VIDEO sans image = bad_request structuré (jamais de throw) ;
//   - runtime sans moteur injecté = zéro-effet garanti (ok, jamais de throw).

'use strict';

const path = require('path');
const { createVpsRuntime } = require('../lib/intelligence/runtimes/vps-runtime');
const humanContextEngine = require('../lib/intelligence/human-context-engine');

let passed = 0;
let failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed += 1; console.log('  ✓ ' + name); }
  else { failed += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(title) { console.log('\n■ ' + title); }

// --- Stubs des moteurs existants (même contrat public que les vrais) --------
function makeManagers() {
  const calls = { sent: [], waStarted: [], tgStarted: [], paused: [], resumed: [], licences: [], sessionTenants: [] };
  const session = {
    tenantId: 'stub',
    sendMessage: async (to, text) => { calls.sent.push({ to, text }); return {}; },
    getGroupParticipants: async () => [
      { id: '2250700000000@s.whatsapp.net', name: 'Alpha' },
      { id: '8@lid', name: 'Anonyme' },
      { id: '2250700000001@s.whatsapp.net', name: 'Beta' },
    ],
    resolveRecipient: async (id) => ({ id: String(id) }),
  };
  const tgSession = {
    tenantId: 'stub-tg',
    resolveRecipient: async (id) => ({ id: (id.startsWith('@') ? id.slice(1) : id) }),
    sendMessage: async (chat, text) => { calls.sent.push({ to: chat.id, text }); return {}; },
    getGroupMembers: async () => [
      { id: '123', username: 'alpha_b', firstName: 'Alpha', lastName: 'B', phone: null },
      { id: '456', username: null, firstName: null, lastName: null, phone: '+2250700000000' },
    ],
  };
  const campaignEngine = {
    start: async (recipients, options) => { calls.waStarted.push({ recipients, options }); return {}; },
    pause: (id) => { calls.paused.push(['wa', id]); },
    resume: async (id) => { calls.resumed.push(['wa', id]); return {}; },
  };
  const tgCampaignEngine = {
    start: async (recipients, message, options) => { calls.tgStarted.push({ recipients, message, options }); return {}; },
    pause: (id) => { calls.paused.push(['tg', id]); },
    resume: async (id) => { calls.resumed.push(['tg', id]); return {}; },
  };
  const whatsappManager = {
    ADMIN_TENANT_ID: '__admin__',
    getOrCreate: (tenantId) => { calls.sessionTenants.push(tenantId); return { session, campaignEngine }; },
  };
  const telegramManager = {
    ADMIN_TENANT_ID: '__admin__',
    getOrCreate: (tenantId) => { calls.sessionTenants.push(tenantId); return { session: tgSession, campaignEngine: tgCampaignEngine }; },
  };
  const licenses = {
    createLicense: async (opts) => { calls.licences.push(opts); return { key: 'KEY-TEST-2026', createdAt: new Date().toISOString() }; },
  };
  return { calls, whatsappManager, telegramManager, licenses };
}

(async () => {
  const { calls, whatsappManager, telegramManager, licenses } = makeManagers();
  const runtime = createVpsRuntime({
    whatsappManager,
    telegramManager,
    licenses,
    humanContext: humanContextEngine,
    env: {},
    http: async () => { throw new Error('transport simulé'); },
  });

  section('Contrat execute() — délègue au registre des 12 actions');
  {
    const r1 = await runtime.execute('ANALYZE_HUMAN_CONTEXT', { text: 'Je vais réfléchir' });
    assert('ANALYZE_HUMAN_CONTEXT passe par le registre (ok, sentiment)', r1.ok === true && r1.result && typeof r1.result.sentiment === 'string', JSON.stringify(r1));
    const r2 = await runtime.execute('FOLLOW_UP', { channel: 'WHATSAPP', to: '+2250700000000', text: 'Rappel', tenantId: 't1' });
    assert('FOLLOW_UP envoie via runtime.sendMessage', r2.ok === true && calls.sent.some((s) => s.text === 'Rappel' || (s.text && s.text.length > 3)), JSON.stringify(r2));
    const r3 = await runtime.execute('NO_SUCH_ACTION', {});
    assert('action inconnue : erreur explicite', r3.ok === false && /UNKNOWN_ACTION/.test(r3.error || ''), JSON.stringify(r3));
  }

  section('EXTRACT_MEMBERS → store → SEND_CAMPAIGN recipientsSource:extract');
  {
    const r = await runtime.execute('EXTRACT_MEMBERS', { channel: 'WHATSAPP', groupId: 'g1', tenantId: 't1' });
    assert('ok + membres renvoyés', r.ok === true && Array.isArray(r.result.members), JSON.stringify(r));
    assert('@lid filtrés (2 participants réels sur 3)', r.result.count === 2 && r.result.members.every((m) => !/@lid/.test(m.id)), JSON.stringify(r.result && r.result.members && r.result.members.map((m) => m.id)));
    const s = await runtime.execute('SEND_CAMPAIGN', { channel: 'WHATSAPP', recipientsSource: 'extract', tenantId: 't1', text: 'Offre' });
    assert('SEND_CAMPAIGN ok', s.ok === true, JSON.stringify(s));
    assert('le moteur WA a reçu les membres extraits', calls.waStarted.length === 1 && calls.waStarted[0].recipients.includes('2250700000000@s.whatsapp.net'), JSON.stringify(calls.waStarted[0] && calls.waStarted[0].recipients));
    assert('séquence texte construite', calls.waStarted[0].options && calls.waStarted[0].options.sequence && calls.waStarted[0].options.sequence[0].text === 'Offre', JSON.stringify(calls.waStarted[0] && calls.waStarted[0].options));
  }

  section('Isolation des contacts extraits et du tenant de session');
  {
    await runtime.execute('EXTRACT_MEMBERS', { channel: 'WHATSAPP', groupId: 'g1', tenantId: 'ACCOUNT_A' });
    const before = calls.waStarted.length;
    const other = await runtime.execute('SEND_CAMPAIGN', {
      channel: 'WHATSAPP', recipientsSource: 'extract', tenantId: 'ACCOUNT_B', text: 'Ne pas réutiliser A',
    }, { tenantId: 'ACCOUNT_B' });
    assert('ACCOUNT_B ne réutilise pas les contacts extraits par ACCOUNT_A', other.ok === false && calls.waStarted.length === before, JSON.stringify(other));
    await runtime.execute('FOLLOW_UP', {
      channel: 'WHATSAPP', to: '+2250700000099', text: 'Tenant méta prioritaire', tenantId: 'ACCOUNT_B',
    }, { tenantId: 'ACCOUNT_A' });
    assert('les métadonnées de tâche empêchent un payload B de rediriger vers B', calls.sessionTenants[calls.sessionTenants.length - 1] === 'ACCOUNT_A', JSON.stringify(calls.sessionTenants.slice(-3)));
  }

  section('SEND_CAMPAIGN Telegram (recipientType contacts)');
  {
    await runtime.execute('SEND_CAMPAIGN', { channel: 'TELEGRAM', recipients: ['@alpha_b', '+2250700000000'], text: 'Salut', tenantId: 't1' });
    assert('moteur TG reçoit recipients + message + recipientType', calls.tgStarted.length === 1 && calls.tgStarted[0].recipients.length === 2 && calls.tgStarted[0].message === 'Salut' && calls.tgStarted[0].options.recipientType === 'contacts', JSON.stringify(calls.tgStarted));
  }

  section('PAUSE / RESUME_CAMPAIGN (par canal)');
  {
    await runtime.execute('PAUSE_CAMPAIGN', { channel: 'WHATSAPP', tenantId: 't1' });
    await runtime.execute('RESUME_CAMPAIGN', { channel: 'TELEGRAM', tenantId: 't1' });
    assert('pause WA sur le bon moteur', calls.paused.some(([c]) => c === 'wa'), JSON.stringify(calls.paused));
    assert('reprise TG sur le bon moteur', calls.resumed.some(([c]) => c === 'tg'), JSON.stringify(calls.resumed));
  }

  section('GENERATE_ACCESS_KEY — vraie licence (stub licenses)');
  {
    const authz = require('../ai-engine/authz');
    const admin = authz.issuePrincipal({ tenant: '__test__', role: 'ADMIN' });
    const r = await authz.runAs(admin, () => runtime.execute('GENERATE_ACCESS_KEY', { sku: 'formation-01', tenantId: '__test__' }));
    assert('ok + clé licence', r.ok === true && r.result && r.result.accessKey === 'KEY-TEST-2026', JSON.stringify(r));
    assert('licence créée avec le bon sku', calls.licences.length === 1 && calls.licences[0].note.includes('formation-01'));
    const owner = require('../ai-engine/authz').issuePrincipal({ tenant: 't1', role: 'OWNER', allowedModules: ['whatsapp'] });
    const denied = await authz.runAs(owner, () => runtime.execute('GENERATE_ACCESS_KEY', { sku: 'forbidden', tenantId: 't1' }));
    assert('un propriétaire de licence ne peut pas créer une licence Cyrus', denied.ok === false && denied.error === 'ADMIN_REQUIRED' && calls.licences.length === 1, JSON.stringify(denied));
  }

  section('CREATE_USER_ACCOUNT — repli local (jamais d’échec)');
  {
    const r = await runtime.execute('CREATE_USER_ACCOUNT', { studentName: 'Ada', email: 'ada@ex.com', sku: 'formation-default', tenantId: '__test__' });
    assert('ok + clé générée localement en attente de sync', r.ok === true && r.result.status === 'CREATED_LOCALLY_AWAITING_SYNC' && r.result.accessKey, JSON.stringify(r));
    assert('clé 24 caractères en 6 groupes de 4', /^([A-Za-z0-9]{4}-){5}[A-Za-z0-9]{4}$/.test(r.result.accessKey), r.result.accessKey);
  }

  section('GENERATE_VIDEO — structuré, jamais de throw');
  {
    const r = await runtime.execute('GENERATE_VIDEO', {});
    assert('sans image : {ok:false, kind:bad_request}', r.ok === false && r.error && r.result.kind === 'bad_request', JSON.stringify(r));
  }

  section('Runtime sans moteur injecté — zéro-effet garanti');
  {
    const bare = createVpsRuntime({ http: async () => { throw new Error('no'); } });
    const r = await bare.execute('EXTRACT_MEMBERS', { channel: 'WHATSAPP', groupId: 'g', tenantId: 't1' });
    assert('EXTRACT_MEMBERS ok avec 0 membre (pas de throw)', r.ok === true && r.result.count === 0, JSON.stringify(r));
    const c = await bare.execute('SEND_CAMPAIGN', { channel: 'WHATSAPP', recipients: ['+2250700000000'], text: 'x', tenantId: 't1' });
    assert('SEND_CAMPAIGN : erreur honnête (RUNTIME_MISSING)', c.ok === false && /RUNTIME_MISSING/.test(c.error || ''), JSON.stringify(c));
  }

  section('SEND_MESSAGE direct via execute');
  {
    await runtime.execute('FOLLOW_UP', { channel: 'WHATSAPP', to: '+2250700000009', text: 'Message direct', tenantId: 't1' });
    assert('envoi direct normalisé en JID', calls.sent.some((s) => s.to === '2250700000009@s.whatsapp.net'), JSON.stringify(calls.sent.slice(-1)));
  }

  console.log('\n========================================');
  console.log('RÉSULTATS : ' + passed + ' passés, ' + failed + ' échoués');
  console.log('========================================');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => { console.error('RUNNER CRASH:', err); process.exit(1); });
