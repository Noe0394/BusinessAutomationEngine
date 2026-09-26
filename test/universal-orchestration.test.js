'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-universal-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;
process.env.SECRET_VAULT_KEY = 'test-vault-key-universal';

const authz = require('../ai-engine/authz');
const registry = require('../ai-engine/toolRegistry');
const agentLoop = require('../ai-engine/jarvis/agentLoop');
const pendingActions = require('../ai-engine/pendingToolActions');
const missions = require('../ai-engine/missionOrchestrator');
const storage = require('../ai-engine/storageAdapter');

const A = 'universal-account-a';
const B = 'universal-account-b';
const C = 'universal-account-c';
const owner = (tenant, userId = `${tenant}-owner`) => authz.issuePrincipal({
  tenant, userId, role: 'OWNER', channel: 'WEB', via: 'test', allowedModules: [],
});
const ownerA = owner(A);
const ownerB = owner(B);
const ownerC = owner(C);

test('nouvel outil du registre: contrat complet, découverte et exécution sans nouveau routeur', async () => {
  const name = 'discoverableCustomerCardProbe';
  let executions = 0;
  registry.registerTool(name, {
    id: name,
    description: 'Recherche les fiches clients par nom ou numéro et retourne les données trouvées.',
    feature: 'customer_cards',
    capabilities: ['search', 'read'],
    category: 'contacts',
    requiredModule: null,
    permission: null,
    permissions: [],
    platforms: ['web', 'chat', 'whatsapp', 'telegram', 'self_whatsapp', 'self_telegram'],
    risk: 'READ',
    timeout: 3000,
    retryPolicy: { maxRetries: 0 },
    availability: 'available',
    dependencies: [],
    inputSchema: { query: { type: 'string', required: true, description: 'Nom ou numéro à rechercher.' } },
    outputSchema: { count: 'number', records: 'array' },
    async execute(args) {
      executions += 1;
      return { ok: true, result: { count: 1, records: [{ query: args.query }] } };
    },
  });

  const ctx = { principal: ownerA, permissions: [] };
  const described = registry.describe().find((tool) => tool.name === name);
  for (const key of ['id', 'category', 'inputSchema', 'outputSchema', 'permissions', 'platforms', 'riskLevel', 'timeout', 'retryPolicy', 'availability', 'dependencies']) {
    assert.ok(Object.hasOwn(described, key), `contrat: ${key}`);
  }
  assert.ok(registry.describe().length >= 100, 'le catalogue dépasse déjà 100 outils');
  assert.ok((await registry.discover('cherche la fiche client Amadou', ctx)).some((tool) => tool.name === name));

  const plans = [
    { tool: name, args: { query: 'Amadou' } },
    { done: true },
  ];
  let planIndex = 0;
  const result = await authz.runAs(ownerA, () => agentLoop.runAgentLoop({
    text: 'Recherche la fiche client Amadou.', tenantId: A, sessionId: 'discover-chat',
  }, {
    permissions: [],
    llm: async (prompt) => prompt.includes('Réponds UNIQUEMENT en JSON')
      ? JSON.stringify(plans[planIndex++]) : 'Une fiche client a été trouvée.',
  }));
  assert.equal(result.steps[0].name, name);
  assert.equal(result.steps[0].state, 'SUCCESS');
  assert.equal(executions, 1);
});

test('les écritures sans preuve backend ne deviennent jamais SUCCESS', async () => {
  const name = 'unverifiedWriteProbe';
  registry.registerTool(name, {
    description: 'Écrit une donnée de test sans preuve de relecture.',
    feature: 'test_writes', capabilities: ['write'], requiredModule: null,
    risk: 'WRITE', inputSchema: {},
    async execute() { return { ok: true, result: { accepted: true } }; },
  });
  const result = await authz.runAs(ownerA, () => registry.execute(A, name, {}, { permissions: [] }));
  assert.equal(result.state, 'UNCONFIRMED');
  assert.equal(result.verified, false);

  let lateFinish = false;
  registry.registerTool('slowWriteProbe', {
    description: 'Écriture de test qui dépasse son délai déclaré.',
    feature: 'test_writes', capabilities: ['write'], requiredModule: null,
    risk: 'WRITE', timeout: 5, inputSchema: {},
    async execute() { await new Promise((resolve) => setTimeout(resolve, 30)); lateFinish = true; return { ok: true, result: { confirmed: true } }; },
  });
  const timedOut = await authz.runAs(ownerA, () => registry.execute(A, 'slowWriteProbe', {}, { permissions: [] }));
  assert.equal(timedOut.state, 'UNCONFIRMED');
  assert.equal(timedOut.error.code, 'TOOL_TIMEOUT');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(lateFinish, true, 'le résultat tardif n’est jamais requalifié en succès dans ce tour');
});

test('une lecture de groupe fonctionne sans droits admin ; le prérequis reste propre à chaque opération', async () => {
  const community = require('../ai-engine/communityService');
  const previous = community.DRIVERS.WHATSAPP;
  community.DRIVERS.WHATSAPP = () => ({
    connected: () => true,
    groups: async () => [{ id: 'group-read-only', subject: 'Groupe ouvert', isAdmin: false, size: 1 }],
    membersOf: async () => [{ id: 'member-1', name: 'Membre' }],
  });
  // Le principal immuable n'accorde pas de licence; émettre un principal de test
  // avec le module effectivement autorisé côté serveur.
  const whatsappOwner = authz.issuePrincipal({ tenant: A, userId: ownerA.userId, role: 'OWNER', channel: 'WEB', via: 'test', allowedModules: ['whatsapp'] });
  try {
    const candidates = await registry.discover('Crée un groupe WhatsApp avec ces contacts', {
      principal: whatsappOwner, permissions: ['messages:send'],
    });
    assert.ok(candidates.some((tool) => tool.name === 'createCommunityGroup'), 'le module messaging virtuel doit respecter la licence WhatsApp');
    const read = await authz.runAs(whatsappOwner, () => registry.execute(A, 'extractMyCommunityGroupMembers', {
      channel: 'WHATSAPP', groupName: 'Groupe ouvert',
    }, { permissions: [] }));
    assert.equal(read.state, 'SUCCESS');
    assert.equal(read.result.total, 1);
    await assert.rejects(() => community.resolveExistingGroup(A, 'WHATSAPP', { groupName: 'Groupe ouvert', requireAdmin: true }), { code: 'GROUP_ADMIN_REQUIRED' });
  } finally { community.DRIVERS.WHATSAPP = previous; }
});

test('missions et confirmations sont liées au compte, à l’identité et à la conversation', async () => {
  const mission = await authz.runAs(ownerA, () => missions.start({
    text: 'Prépare cette mission de test.', tenantId: A, sessionId: 'conversation-a', channel: 'WEB',
  }, { llm: async () => JSON.stringify({ needsInput: true, question: 'Quel canal ?', steps: [] }) }));
  assert.equal(mission.state, 'waiting_input');

  for (const foreignPrincipal of [ownerB, ownerC]) {
    const foreignResume = await authz.runAs(foreignPrincipal, () => missions.resume({
      tenantId: A, id: mission.missionId, answer: 'WhatsApp', sessionId: 'conversation-a',
    }, { llm: async () => JSON.stringify({ needsInput: false, steps: [] }) }));
    assert.equal(foreignResume.blocked, true);
    const foreignControl = await authz.runAs(foreignPrincipal, () => missions.control({
      tenantId: A, id: mission.missionId, action: 'stop',
    }, {}));
    assert.equal(foreignControl.blocked, true);
    assert.equal(await missions.get(foreignPrincipal.tenant, mission.missionId), null);
  }

  const action = await pendingActions.create(A, {
    userId: ownerA.userId, role: ownerA.role, sessionId: 'conversation-a', conversationId: 'conversation-a',
    tool: 'unverifiedWriteProbe', riskLevel: 'WRITE', payload: { pendingArgs: { marker: 'exact' } },
  });
  assert.equal((await pendingActions.listForIdentity(A, {
    tenant: A, userId: ownerA.userId, role: ownerA.role, conversationId: 'conversation-a',
  })).length, 1);
  assert.equal((await pendingActions.listForIdentity(A, {
    tenant: A, userId: ownerA.userId, role: ownerA.role, conversationId: 'other-conversation',
  })).length, 0);
  assert.equal((await pendingActions.listForIdentity(B, {
    tenant: B, userId: ownerB.userId, role: ownerB.role, conversationId: 'conversation-a',
  })).length, 0);
  assert.equal((await pendingActions.listForIdentity(C, {
    tenant: C, userId: ownerC.userId, role: ownerC.role, conversationId: 'conversation-a',
  })).length, 0);
  assert.equal((await pendingActions.get(A, action.pendingActionId)).status, 'PENDING');

  const missionId = 'mis_action_reference_test';
  const missionDoc = await storage.get(missions.NS, A, { tenant: A, missions: {} });
  missionDoc.missions[missionId] = {
    id: missionId, tenant: A, userId: ownerA.userId, sessionId: 'conversation-a',
    ownerConversationId: 'conversation-a', state: 'needs_confirmation', pendingActionId: 'ACT-111111111111',
    objective: 'test', steps: [], createdAt: Date.now(), updatedAt: Date.now(),
  };
  await storage.set(missions.NS, A, missionDoc);
  const mismatchedConfirmation = await authz.runAs(ownerA, () => missions.resume({
    tenantId: A, id: missionId, sessionId: 'conversation-a', answer: 'Oui ACT-222222222222',
  }, {}));
  assert.equal(mismatchedConfirmation.blocked, true);

  const crossTenantCall = await authz.runAs(ownerB, () => registry.execute(A, 'getBusinessServices', {}, {}));
  assert.equal(crossTenantCall.state, 'BLOCKED');
  assert.equal(crossTenantCall.error.code, 'TENANT_MISMATCH');
});

test('une confirmation rejoue les arguments préparés une seule fois', async () => {
  const name = 'idempotentConfirmedProbe';
  const seen = [];
  registry.registerTool(name, {
    description: 'Enregistre une valeur de test après confirmation.',
    feature: 'test_writes', capabilities: ['write'], requiredModule: null,
    risk: 'WRITE', inputSchema: { value: { type: 'string', required: true } },
    async execute(args) {
      seen.push(args.value);
      return { ok: true, result: { value: args.value, confirmed: true } };
    },
  });
  const planned = await authz.runAs(ownerA, () => agentLoop.runAgentLoop({
    text: 'Enregistre exactement « valeur préparée ».', tenantId: A, sessionId: 'confirm-conversation',
  }, {
    permissions: [], confirmFrom: 'WRITE',
    llm: async (prompt) => prompt.includes('Réponds UNIQUEMENT en JSON')
      ? JSON.stringify({ tool: name, args: { value: 'valeur préparée' } }) : 'Action préparée, en attente de confirmation.',
  }));
  assert.equal(planned.stopReason, 'NEEDS_CONFIRMATION');
  assert.equal(seen.length, 0);
  const ref = planned.pendingActionId;
  assert.match(ref, /^ACT-[A-F0-9]{12}$/);

  const wrongConversation = await authz.runAs(ownerA, () => agentLoop.resolvePending({
    tenantId: A, sessionId: 'another-conversation', text: 'oui',
  }, { ctx: { permissions: [], confirmFrom: 'WRITE' } }));
  assert.equal(wrongConversation, null);

  const confirmed = await authz.runAs(ownerA, () => agentLoop.resolvePending({
    tenantId: A, sessionId: 'confirm-conversation', conversationId: 'confirm-conversation', text: 'Oui, lance',
  }, { ctx: { permissions: [], confirmFrom: 'WRITE' }, llm: async () => JSON.stringify({ done: true }) }));
  assert.equal(confirmed.confirmedActionId, ref);
  assert.deepEqual(seen, ['valeur préparée']);

  const duplicate = await authz.runAs(ownerA, () => agentLoop.resolvePending({
    tenantId: A, sessionId: 'confirm-conversation', conversationId: 'confirm-conversation', text: ref,
  }, { ctx: { permissions: [], confirmFrom: 'WRITE' } }));
  assert.match(duplicate.text, /déjà été exécutée/);
  assert.deepEqual(seen, ['valeur préparée']);
});
