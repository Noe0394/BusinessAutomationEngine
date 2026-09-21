// Outils du ToolRegistry pour PILOTER et COMPRENDRE le répondeur : politique (privé / groupes / présentation des services, exceptions par discussion),
// explication « pourquoi as-tu répondu / pas répondu ? », lecture du contexte d'une discussion. Réservés au propriétaire (rôle), jamais à un client.
// Fusionné dans TOOLS par toolsExtra.js.
const policy = require('./conversationPolicy');

const fail = (code, message) => ({ ok: false, error: { code, message: message || code, retryable: false } });
const chan = (c) => String(c || 'WHATSAPP').toUpperCase();
const DAY = 24 * 3600 * 1000;

// Retrouve UNE discussion (privée ou groupe) à partir d'un nom, d'un numéro ou d'un identifiant, dans la mémoire des 7 jours.
async function findConversation(tenant, query, channel) {
  const q = String(query || '').trim(); if (!q) return { error: 'QUERY_REQUIRED' };
  const rows = await require('./messageHistory').findConversations(tenant, { query: q, channel: channel || undefined });
  if (!rows.length) return { error: 'NOT_FOUND' };
  if (rows.length > 1) {
    const exact = rows.filter((c) => [c.contactName, c.groupName].some((n) => n && String(n).toLowerCase() === q.toLowerCase()));
    if (exact.length !== 1) return { error: 'AMBIGUOUS', candidates: rows.slice(0, 5).map((c) => c.groupName || c.contactName || c.contactId) };
    return { conv: exact[0] };
  }
  return { conv: rows[0] };
}
const convChannel = (c) => String(c.channel || 'WHATSAPP').toUpperCase();
const convId = (c) => c.groupId || c.chatId || c.contactId;
const convLabel = (c) => c.groupName || c.contactName || c.phoneNumber || c.contactId;
const isGroupConv = (c) => String(c.type).toUpperCase() === 'GROUP' || !!c.groupId;

const TOOLS = {
  getConversationPolicy: {
    description: 'Comportement actuel du répondeur : discussions privées (auto / natural / business), groupes (topic / addressed / off), présentation de vos services (when-relevant / on-request / never), mémoire utilisée, exceptions par discussion.',
    permission: null, risk: 'READ', inputSchema: {},
    async execute(a, ctx) { const p = await policy.get(ctx.tenant); return { ok: true, result: { policy: p, resume: policy.describe(p) } }; },
  },
  setConversationPolicy: {
    description: 'Règle le comportement du répondeur. Global : private (auto|natural|business), group (topic|addressed|off), presentServices (when-relevant|on-request|never), windowDays (1-7), groupMaxRepliesPer10Min. Exception pour UNE discussion ou UN groupe (par nom ou numéro) : conversation + mode et/ou presentServices ; clear:true pour retirer l\'exception.',
    permission: null, risk: 'LOW_WRITE',
    inputSchema: { private: { type: 'string' }, group: { type: 'string' }, presentServices: { type: 'string' }, windowDays: { type: 'number' }, groupMaxRepliesPer10Min: { type: 'number' }, aiJudgment: { type: 'boolean', description: 'true : l\'IA (cascade) tranche les cas ambigus ; false : règles seules.' }, conversation: { type: 'string', description: 'Nom du groupe/contact ou numéro (exception).' }, channel: { type: 'string' }, mode: { type: 'string' }, clear: { type: 'boolean' } },
    async execute(a, ctx) {
      const patch = {}; const invalid = [];
      const check = (k, list) => { if (a[k] === undefined) return; if (!list.includes(a[k])) invalid.push(`${k} doit valoir : ${list.join(' | ')}`); else patch[k] = a[k]; };
      check('private', policy.PRIVATE_MODES); check('group', policy.GROUP_MODES); check('presentServices', policy.PRESENT_MODES);
      for (const k of ['windowDays', 'groupMaxRepliesPer10Min']) if (a[k] !== undefined) patch[k] = a[k];
      if (a.aiJudgment !== undefined) patch.aiJudgment = a.aiJudgment === true || a.aiJudgment === 'true';
      if (invalid.length) return fail('INVALID_VALUE', invalid.join(' ; '));
      let target = null;
      if (a.conversation) {
        const f = await findConversation(ctx.tenant, a.conversation, a.channel ? chan(a.channel) : null);
        if (f.error === 'AMBIGUOUS') return fail('AMBIGUOUS', `Plusieurs discussions correspondent : ${f.candidates.join(', ')}. Précisez le nom complet.`);
        if (f.error) return fail('CONVERSATION_NOT_FOUND', 'Je ne retrouve pas cette discussion dans les 7 derniers jours.');
        const list = isGroupConv(f.conv) ? policy.GROUP_MODES : policy.PRIVATE_MODES;
        if (a.mode !== undefined && !list.includes(a.mode)) return fail('INVALID_VALUE', `Pour ${isGroupConv(f.conv) ? 'un groupe' : 'une discussion privée'}, mode doit valoir : ${list.join(' | ')}`);
        if (a.presentServices !== undefined && !policy.PRESENT_MODES.includes(a.presentServices)) return fail('INVALID_VALUE', `presentServices doit valoir : ${policy.PRESENT_MODES.join(' | ')}`);
        patch.override = { channel: convChannel(f.conv), id: convId(f.conv), mode: a.mode, presentServices: a.presentServices, clear: a.clear === true };
        target = { channel: convChannel(f.conv), id: convId(f.conv), label: convLabel(f.conv) };
      }
      if (!Object.keys(patch).length) return fail('NOTHING_TO_CHANGE', 'Dites-moi ce que vous voulez régler (privé, groupes, présentation des services, ou une exception pour une discussion).');
      const p = await policy.set(ctx.tenant, patch);
      return { ok: true, result: { policy: p, resume: policy.describe(p), exception: target } };
    },
    async verify(r, a, ctx) { const p = await policy.get(ctx.tenant); return { verified: JSON.stringify(p) === JSON.stringify(r.policy) }; },
  },
  explainReply: {
    description: 'Explique POURQUOI le répondeur a répondu ou est resté silencieux pour une discussion (nom, numéro ou groupe) : décision, raison en français simple, registre (naturel / business / présentation). Sans nom : les dernières décisions.',
    permission: null, risk: 'READ', inputSchema: { conversation: { type: 'string' }, channel: { type: 'string' } },
    async execute(a, ctx) {
      const act = require('./activityStore'); let digits = ''; let label = null;
      if (a.conversation) {
        const f = await findConversation(ctx.tenant, a.conversation, a.channel ? chan(a.channel) : null);
        if (f.error === 'AMBIGUOUS') return fail('AMBIGUOUS', `Plusieurs discussions correspondent : ${f.candidates.join(', ')}.`);
        if (f.error) return fail('CONVERSATION_NOT_FOUND', 'Je ne retrouve pas cette discussion dans les 7 derniers jours.');
        digits = String(convId(f.conv)).split('@')[0]; label = convLabel(f.conv);
      }
      const rows = [];
      for (let d = 0; d < 3 && rows.length < 12; d += 1) {
        const s = await act.summary(new Date(Date.now() - d * DAY).toISOString().slice(0, 10), 300).catch(() => ({ events: [] }));
        for (const e of s.events) if (e.type === 'engagement' && String(e.tenant) === String(ctx.tenant) && (!digits || String(e.target || '').split('@')[0] === digits)) rows.push(e);
      }
      const out = rows.slice(0, 12).map((e) => { const [code, why] = String(e.detail || '').split(' | '); return { when: e.ts, decision: e.action, code: code || null, why: why || null, channel: e.channel }; });
      return { ok: true, result: { conversation: label, count: out.length, decisions: out, note: out.length ? null : 'Aucune décision enregistrée pour ce périmètre sur les 3 derniers jours.' } };
    },
  },
  describeConversation: {
    description: 'Ce que je sais d\'une discussion ou d\'un groupe d\'après la mémoire des 7 jours : thèmes, service concerné, température business, participants, et ce que je ferais maintenant (politique appliquée).',
    permission: null, risk: 'READ', inputSchema: { conversation: { type: 'string', required: true }, channel: { type: 'string' } },
    async execute(a, ctx) {
      const f = await findConversation(ctx.tenant, a.conversation, a.channel ? chan(a.channel) : null);
      if (f.error === 'AMBIGUOUS') return fail('AMBIGUOUS', `Plusieurs discussions correspondent : ${f.candidates.join(', ')}.`);
      if (f.error) return fail('CONVERSATION_NOT_FOUND', 'Je ne retrouve pas cette discussion dans les 7 derniers jours.');
      const cctx = require('./conversationContext'); const group = isGroupConv(f.conv);
      const pol = policy.resolveFor(await policy.get(ctx.tenant), convChannel(f.conv), convId(f.conv), group);
      const c = await cctx.analyze({ tenant: ctx.tenant, channel: convChannel(f.conv), from: convId(f.conv), isGroup: group, windowDays: pol.windowDays });
      return { ok: true, result: { conversation: convLabel(f.conv), type: group ? 'groupe' : 'privée', resume: cctx.summarize(c), themes: c.themes, service: c.service, business: c.business, group: c.group, politiqueAppliquee: pol } };
    },
  },
};

module.exports = { TOOLS };
