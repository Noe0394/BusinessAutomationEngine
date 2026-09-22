// GARDE D'ÉCHANGE CLIENT — ai-engine/clientLimitGuard.js
// ---------------------------------------------------------------------------
// Enveloppe le traitement IA d'un message/lot d'un CLIENT (conversation privée, campagne, réponse en groupe). Jamais utilisée sur
// le chemin propriétaire (self-chat, Chat intelligent) : illimité.
//   1. limite déjà atteinte  -> AUCUN appel IA, aucune réponse ; message conservé pour le propriétaire ;
//   2. sinon                 -> le traitement s'exécute sous le contexte de quota (chaque appel IA est compté par le gateway,
//                               un échange = un exchangeId) ;
//   3. limite atteinte (10e échange terminé, ou refus du gateway) -> HANDOFF vers le propriétaire, notification UNIQUE par fenêtre,
//      contexte conservé (l'état conversationnel n'est pas touché), reprise automatique quand la fenêtre se libère.
const quota = require('./clientAiQuota');

async function labelOf(tenantId, channel, from, identity, name) {
  if (identity && identity.label) return identity.labelWithPhone || identity.label;
  try { return await require('./contactIdentity').labelFor(tenantId, channel, from, name ? { pushName: name } : null); } catch (e) { return 'un client'; }
}

async function onLimit({ tenantId, channel, from, senderId, clientKey, identity, name, isGroup, snap }) {
  try {
    if (!(await quota.claimLimitNotice(tenantId, clientKey))) return { notified: false };
    const who = isGroup ? `${await labelOf(tenantId, channel, senderId || from, null, name)} (dans un groupe)` : await labelOf(tenantId, channel, from, identity, name);
    const n = (snap && snap.limit) || quota.limit();
    const mins = Math.round(quota.windowMs() / 60000);
    const windowTxt = mins === 60 ? 'la dernière heure' : `les ${mins} dernières minutes`;
    // Handoff : conversation privée -> réponse manuelle jusqu'à la libération de la fenêtre ; en groupe, seul CE membre est
    // limité (la clé de quota est celle de l'expéditeur) — l'état du groupe n'est jamais mis en pause pour les autres.
    if (!isGroup) {
      const conversationState = require('./jarvis/conversationState');
      const st = await conversationState.get(tenantId, channel, from);
      const until = (snap && snap.resumeAt) || (Date.now() + quota.windowMs());
      st.humanUntil = Math.max(st.humanUntil || 0, until);
      st.handoff = Object.assign({}, st.handoff || {}, { state: 'HUMAN_REQUIRED', reason: 'AI_LIMIT', at: Date.now(), until, contactLabel: who });
      await conversationState.save(st);
    }
    await require('./alertCenter').raise(tenantId, {
      type: 'HUMAN_INTERVENTION_REQUIRED', level: 'ACTION_REQUIRED', notify: true,
      title: `Limite IA atteinte : ${who}`,
      body: `⚠️ La limite de conversation IA a été atteinte pour ${who}. ${n} échanges ont été traités sur ${windowTxt}. La conversation est maintenant passée en réponse manuelle.`,
      hint: 'Réponds directement dans la conversation ; l\'IA reprendra seule quand la fenêtre se libère.',
      contact: identity || null, idempotencyKey: `ailimit:${tenantId}:${clientKey}:${snap && snap.windowStart}`,
    });
    return { notified: true };
  } catch (e) {
    console.warn(`clientLimitGuard — notification de limite en échec (tenant "${tenantId}") : ${e && e.message}`);
    return { notified: false };
  }
}

// ctx : { tenantId, channel, from, senderId?, identity?, name?, exchangeId?, isGroup? } ; fn : le traitement IA du lot.
async function guardExchange(ctx, fn) {
  const clientKey = quota.clientKeyFor(ctx);
  const base = Object.assign({ clientKey }, ctx);
  const before = await quota.status(ctx.tenantId, clientKey);
  if (before.exhausted) { await onLimit(Object.assign({ snap: before }, base)); return { skipped: 'AI_LIMIT', limited: true }; }
  let out;
  try {
    out = await quota.runFor({ tenant: ctx.tenantId, clientKey, exchangeId: ctx.exchangeId }, fn);
  } catch (err) {
    if (err && err.code === 'CLIENT_AI_LIMIT') { await onLimit(Object.assign({ snap: err.snapshot }, base)); return { skipped: 'AI_LIMIT', limited: true }; }
    throw err;
  }
  const after = await quota.status(ctx.tenantId, clientKey);
  if (after.exhausted) await onLimit(Object.assign({ snap: after }, base)); // 10e échange terminé : passage au propriétaire
  return out;
}

module.exports = { guardExchange, onLimit };
