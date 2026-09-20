// Continuité des campagnes : lorsque la protection réseau bascule une campagne en mode assisté, une SEULE fiche de
// continuité (idempotente par campagne parente) est créée, le vendeur est notifié, et la fiche est refermée si la
// campagne reprend automatiquement. Le pipeline manuel existant (file « Relance Manuelle Express », deep-link) reste
// le mécanisme d'envoi : il s'ouvre sur l'appareil de l'utilisateur et ne peut pas être exécuté depuis le serveur.
const storageAdapter = require('./storageAdapter');
const notifications = require('./notifications');

const NS = 'campaign_fallbacks';
const sanitize = (id) => String(id || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'default';
const chains = new Map();
function serial(tenant, fn) {
  const k = sanitize(tenant);
  const next = (chains.get(k) || Promise.resolve()).then(fn, fn);
  chains.set(k, next.catch(() => {}));
  return next;
}
const load = (tenant) => storageAdapter.get(NS, sanitize(tenant), { tenant: sanitize(tenant), byParent: {} });

// detect_protection_event -> switch_campaign_to_manual : idempotent (un seul fallback par campagne parente).
function ensureFallback(tenant, { channel, campaignId, campaignName, reason }) {
  return serial(tenant, async () => {
    const doc = await load(tenant);
    const existing = doc.byParent[campaignId];
    if (existing && existing.status === 'manual_fallback') { existing.events += 1; storageAdapter.set(NS, sanitize(tenant), doc); return { created: false, fallback: existing }; }
    const fb = {
      parentCampaignId: campaignId, fallbackCampaignId: `fb_${campaignId}`, channel: String(channel || 'WHATSAPP').toUpperCase(),
      name: campaignName || null, status: 'manual_fallback', reason: reason || 'PROTECTION_TRIGGERED', events: 1, createdAt: Date.now(), closedAt: null, closeReason: null,
    };
    doc.byParent[campaignId] = fb;
    storageAdapter.set(NS, sanitize(tenant), doc);
    await notifications.create(tenant, {
      title: 'Campagne en mode assisté', level: 'warning', ref: fb.fallbackCampaignId,
      body: `La protection a interrompu l'envoi automatique de « ${fb.name || campaignId} ». Les destinataires restants sont dans la file de relance manuelle (état conservé).`,
    });
    return { created: true, fallback: fb };
  });
}

function closeFallback(tenant, campaignId, closeReason) {
  return serial(tenant, async () => {
    const doc = await load(tenant);
    const fb = doc.byParent[campaignId];
    if (!fb || fb.status !== 'manual_fallback') return null;
    fb.status = 'closed'; fb.closedAt = Date.now(); fb.closeReason = closeReason || 'AUTO_RESUMED';
    storageAdapter.set(NS, sanitize(tenant), doc);
    return fb;
  });
}

async function list(tenant) { const doc = await load(tenant); return Object.values(doc.byParent); }

// Abonnement au bus de platformOrchestrator (événements des moteurs de campagne WhatsApp et Telegram).
function attach(bus) {
  bus.on('campaign:network_status', (evt) => {
    if (!evt || !evt.tenantId || !evt.campaignId) return;
    if (evt.status === 'circuit_open' && evt.assistedMode) ensureFallback(evt.tenantId, evt).catch(() => {});
    else if (evt.status === 'normal') closeFallback(evt.tenantId, evt.campaignId, 'AUTO_RESUMED').catch(() => {});
  });
}

module.exports = { ensureFallback, closeFallback, list, attach, NS };
