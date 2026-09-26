'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AI_ENGINE_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-context-tools-'));
process.env.SPECIALISTS_ENABLED = 'false';
require('./helpers/auth').actAsAdmin();

const authz = require('../ai-engine/authz');
const registry = require('../ai-engine/toolRegistry');
const orchestrator = require('../ai-engine/chatOrchestrator');

test('un suivi anaphorique d’un résultat backend relance les outils avec le bon contexte', async () => {
  const tenant = 'contextual-followup-account';
  const principal = authz.issuePrincipal({ tenant, userId: `${tenant}-owner`, role: 'OWNER', channel: 'WEB', via: 'test', allowedModules: ['whatsapp'] });
  const toolName = 'filterContextualCommunityGroupsProbe';
  registry.registerTool(toolName, {
    description: 'Filtre et recherche les groupes de communautés du compte par thème ou par nom.',
    feature: 'communities', capabilities: ['read', 'search'], requiredModule: 'whatsapp', risk: 'READ',
    inputSchema: { channel: { type: 'string' }, query: { type: 'string', required: true } },
    async execute(args) { return { ok: true, result: { query: args.query, groups: ['Épicerie Awa', 'Épicerie Nord'] } }; },
  });

  const history = [
    { role: 'user', text: 'Donne-moi tous mes groupes.' },
    { role: 'assistant', text: 'Tes groupes : Épicerie Awa, Foot entre amis.', toolCall: { name: 'listMyCommunityGroups', state: 'SUCCESS', result: { groups: [{ name: 'Épicerie Awa' }, { name: 'Foot entre amis' }] } } },
  ];
  assert.equal(orchestrator.isContextualToolRequest('Ceux qui parlent d’épicerie.', history), true);
  assert.equal(orchestrator.isContextualToolRequest('Ce groupe et les mêmes membres, il y a trois jours.', history), true);
  assert.equal(orchestrator.isContextualToolRequest('Configure mon Service métier.', history), false, 'un changement de sujet ne reprend pas les groupes');

  let planCalls = 0;
  const output = await orchestrator.handle({
    text: 'Ceux qui parlent d’épicerie.', history, tenantId: tenant, sessionId: 'web-natural', principal,
  }, {
    toolPermissions: [],
    llm: async (prompt) => {
      if (prompt.includes('RÉSULTATS backend vérifiés') || prompt.includes('Résultats backend vérifiés')) {
        assert.match(prompt, /Épicerie Awa/);
        assert.match(prompt, /Donne-moi tous mes groupes/);
      }
      if (prompt.includes('Réponds UNIQUEMENT en JSON')) {
        planCalls += 1;
        return planCalls === 1
          ? JSON.stringify({ tool: toolName, args: { query: 'épicerie' } })
          : JSON.stringify({ done: true });
      }
      return 'J’ai filtré les groupes précédemment récupérés.';
    },
  });

  assert.ok(output);
  assert.equal(output.steps[0].name, toolName);
  assert.equal(output.steps[0].state, 'SUCCESS');
  assert.equal(output.steps[0].result.query, 'épicerie');
});

test('le self-chat conserve les résultats structurés pour que WhatsApp et Telegram puissent continuer la mission', async () => {
  const saved = [];
  const assistantLayer = require('../ai-engine/assistantLayer');
  const layer = assistantLayer.create({
    aiStudioStore: {
      async listSessions() { return []; },
      async createSession() { return { id: 'owner-session' }; },
      async appendMessages(_tenant, _id, messages) { saved.push(...messages); },
    },
  });
  await layer.ownerDeps.history.append('owner-context-account', 'Donne-moi tous mes groupes.', 'Résultats reçus.', {
    toolCall: { name: 'listMyCommunityGroups', state: 'SUCCESS', result: { groups: [{ name: 'Épicerie Awa' }] } },
  });
  assert.equal(saved[1].toolCall.state, 'SUCCESS');
  assert.equal(saved[1].toolCall.result.groups[0].name, 'Épicerie Awa');
});
