'use strict';

const missions = require('../missionOrchestrator');

const metadata = {
  feature: 'objective_orchestration',
  roles: ['OWNER', 'ADMIN'],
  permission: null,
};

module.exports = {
  getObjectiveMission: Object.assign({}, metadata, {
    capabilities: ['read', 'status'],
    description: 'Lit l’état réel d’une mission orchestrée et ses étapes vérifiées. Sans identifiant, liste les missions récentes. N’invente aucune progression.',
    risk: 'READ',
    inputSchema: { id: { type: 'string', required: false, description: 'Identifiant de mission facultatif.' } },
    async execute(args, ctx) {
      if (args.id) {
        const before = await missions.get(ctx.tenant, args.id);
        if (before && ctx.principal.role !== 'ADMIN' && before.userId !== ctx.principal.userId) {
          return { ok: true, result: { found: false, mission: null } };
        }
        if (before && before.state === 'monitoring') await missions.monitorMission(ctx.tenant, args.id, { runtime: ctx.runtime, permissions: ctx.permissions, toolContext: ctx });
        const mission = await missions.get(ctx.tenant, args.id);
        return { ok: true, result: { found: !!mission, mission: mission ? missions.render(mission) : null } };
      }
      const visible = (await missions.list(ctx.tenant, 50)).filter((m) => ctx.principal.role === 'ADMIN' || m.userId === ctx.principal.userId);
      const items = visible.slice(0, 20);
      for (const item of items.filter((m) => m.state === 'monitoring')) await missions.monitorMission(ctx.tenant, item.id, { runtime: ctx.runtime, permissions: ctx.permissions, toolContext: ctx });
      const refreshed = (await missions.list(ctx.tenant, 50)).filter((m) => ctx.principal.role === 'ADMIN' || m.userId === ctx.principal.userId).slice(0, 20);
      return { ok: true, result: { count: refreshed.length, missions: refreshed.map((m) => missions.render(m)) } };
    },
  }),
  pauseObjectiveMission: Object.assign({}, metadata, {
    capabilities: ['control'],
    description: 'Met en pause une mission objective. Une campagne déjà lancée est contrôlée par les outils pauseCampaign/resumeCampaign.',
    risk: 'WRITE',
    inputSchema: { id: { type: 'string', required: true, description: 'Identifiant de la mission.' } },
    async execute(args, ctx) {
      const out = await missions.control({ tenantId: ctx.tenant, id: args.id, action: 'pause' }, { toolContext: ctx, runtime: ctx.runtime, permissions: ctx.permissions });
      return out && out.state !== 'needs_confirmation' ? { ok: true, result: out } : out ? { ok: false, error: { code: 'NEEDS_CONFIRMATION', message: out.text, result: out } } : { ok: false, error: { code: 'MISSION_NOT_FOUND' } };
    },
    async verify(result, args, ctx) {
      const mission = await missions.get(ctx.tenant, args.id);
      return { verified: !!mission && mission.state === 'paused', state: mission && mission.state || null };
    },
  }),
  resumeObjectiveMission: Object.assign({}, metadata, {
    capabilities: ['control'],
    description: 'Reprend une mission objective en pause. Si une étape a été interrompue pendant un envoi, elle reste bloquée jusqu’à vérification.',
    risk: 'WRITE',
    inputSchema: { id: { type: 'string', required: true, description: 'Identifiant de la mission.' } },
    async execute(args, ctx) {
      const out = await missions.control({ tenantId: ctx.tenant, id: args.id, action: 'resume' }, { toolContext: ctx, runtime: ctx.runtime, permissions: ctx.permissions });
      return out && out.state !== 'needs_confirmation' ? { ok: true, result: out } : out ? { ok: false, error: { code: 'NEEDS_CONFIRMATION', message: out.text, result: out } } : { ok: false, error: { code: 'MISSION_NOT_FOUND' } };
    },
    async verify(result, args, ctx) {
      const mission = await missions.get(ctx.tenant, args.id);
      return { verified: !!mission && ['running', 'monitoring', 'completed'].includes(mission.state), state: mission && mission.state || null };
    },
  }),
  stopObjectiveMission: Object.assign({}, metadata, {
    capabilities: ['control'],
    description: 'Arrête une mission objective. Une campagne déjà lancée doit aussi être arrêtée avec cancelCampaign.',
    risk: 'WRITE',
    inputSchema: { id: { type: 'string', required: true, description: 'Identifiant de la mission.' } },
    async execute(args, ctx) {
      const out = await missions.control({ tenantId: ctx.tenant, id: args.id, action: 'stop' }, { toolContext: ctx, runtime: ctx.runtime, permissions: ctx.permissions });
      return out && out.state !== 'needs_confirmation' ? { ok: true, result: out } : out ? { ok: false, error: { code: 'NEEDS_CONFIRMATION', message: out.text, result: out } } : { ok: false, error: { code: 'MISSION_NOT_FOUND' } };
    },
    async verify(result, args, ctx) {
      const mission = await missions.get(ctx.tenant, args.id);
      return { verified: !!mission && mission.state === 'stopped', state: mission && mission.state || null };
    },
  }),
};
