// Vocabulaire unique des statuts (destinataires et campagnes) pour l'interface, les outils et les rapports.
// Fonctions pures : les moteurs WhatsApp/Telegram gardent leurs statuts internes, ce module les traduit.

const RECIPIENT_STATUS = ['pending', 'processing', 'sent', 'failed', 'skipped', 'manual_pending', 'manual_processing', 'manual_sent'];
const CAMPAIGN_STATE = ['draft', 'scheduled', 'running', 'paused', 'protection_triggered', 'waiting', 'manual_fallback', 'completed', 'cancelled', 'error'];

// raw : statut interne du moteur ('pending', 'sent', 'failed', 'skipped_duplicate', 'skipped_optout', 'sent_manual', 'interrupted'...)
function recipientStatus(raw, isCurrent) {
  switch (raw) {
    case 'sent': return 'sent';
    case 'failed': return 'failed';
    case 'sent_manual': return 'manual_sent';
    case 'skipped_duplicate': case 'skipped_optout': case 'skipped': return 'skipped';
    case 'manual_pending': case 'manual_processing': case 'manual_sent': return raw;
    default: return isCurrent ? 'processing' : 'pending';
  }
}

// campaign : statut public d'un moteur { status, paused, userPaused, networkStatus, assistedMode, cancelReason, resumeError }
function campaignState(c) {
  if (!c) return 'draft';
  if (c.status === 'completed') return 'completed';
  if (c.status === 'cancelled' || c.status === 'stopped') return 'cancelled';
  if (c.status === 'error' || c.status === 'failed' || c.resumeError) return 'error';
  if (c.userPaused) return 'paused';
  if (c.status === 'running' || c.status === 'paused') {
    if (c.assistedMode) return 'manual_fallback';
    if (c.networkStatus === 'circuit_open') return 'protection_triggered';
    if (c.networkStatus === 'degraded_network' || c.paused) return 'waiting';
    return 'running';
  }
  if (c.status === 'queued') return 'waiting';
  return 'waiting';
}

// Compteurs réels à partir des statuts de destinataires traduits.
function summarize(rows) {
  const s = { total: rows.length, pending: 0, processing: 0, sent: 0, failed: 0, skipped: 0, manual_sent: 0, manual_pending: 0, manual_processing: 0 };
  for (const r of rows) s[r.status] = (s[r.status] || 0) + 1;
  const done = s.sent + s.failed + s.skipped + s.manual_sent;
  s.progressPercent = s.total ? Math.round((done / s.total) * 1000) / 10 : 0;
  s.remaining = s.total - done;
  return s;
}

module.exports = { RECIPIENT_STATUS, CAMPAIGN_STATE, recipientStatus, campaignState, summarize };
