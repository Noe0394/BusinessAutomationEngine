// ASSISTANT LAYER — ai-engine/assistantLayer.js
// ---------------------------------------------------------------------------
// Colle entre les canaux (WhatsApp/Telegram, gérés par index.js) et les modules de la couche d'assistance générale :
//   contactIdentity (qui écrit ?)  ->  conversationRouter (métier / privé / urgent ?)  ->  alertCenter + ownerChannel.
// Ne contient AUCUNE intelligence propre : le Chat Intelligent (chatOrchestrator) reste le cerveau ; le WhatsApp du
// propriétaire n'est qu'une interface vers lui (ownerChannel).

const contactIdentity = require('./contactIdentity');
const conversationRouter = require('./conversationRouter');
const conversationState = require('./jarvis/conversationState');
const { shared: conversationQueue } = require('./jarvis/conversationQueue');
const alertCenter = require('./alertCenter');
const ownerChannel = require('./ownerChannel');
const contactCrm = require('./contactCrm');
const adCampaigns = require('./adCampaigns');

const DEFAULT_DEBOUNCE_MS = Math.max(0, parseInt(process.env.AUTO_REPLY_DEBOUNCE_MS, 10) || 1500);
const sanitize = (t) => String(t || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'unknown';

// d = { whatsappManager, telegramManager, autoResponder, getRuntime(), chatOrchestrator, aiStudioStore, llmFallbackEngine,
//       platformOrchestrator, chatDeps(tenantId) -> deps de chatOrchestrator.handle, transcribeVoice?(session,msg) }
function create(d) {
  // --- Identité ------------------------------------------------------------------------------------------------
  async function resolveIdentity({ channel, tenantId, session, msg }) {
    const ch = String(channel).toUpperCase();
    if (ch === 'TELEGRAM') {
      const sender = (msg && msg.sender) || {};
      const chatId = msg && (msg.chatId ? String(msg.chatId) : (msg.senderId ? String(msg.senderId) : null));
      const fullName = [sender.firstName, sender.lastName].filter(Boolean).join(' ') || null;
      return contactIdentity.resolveContact(tenantId, {
        channel: 'TELEGRAM', jid: chatId, telegramName: fullName, username: sender.username || null,
        phone: sender.phone ? String(sender.phone).replace(/\D/g, '') : null, // numéro fourni par Telegram lui-même, sinon rien
      });
    }
    const hints = session && typeof session.getIdentityHints === 'function'
      ? session.getIdentityHints(msg)
      : { jid: msg && msg.key && msg.key.remoteJid, senderJid: msg && msg.key && msg.key.remoteJid, altJids: [], pushName: msg && msg.pushName, knownName: null };
    let knownName = hints.knownName || null;
    if (!knownName && hints.jid) {
      try { const c = await contactCrm.getContact(tenantId, 'WHATSAPP', contactCrm.identityOf(hints.jid)); knownName = (c && c.name) || null; } catch (e) { /* facultatif */ }
    }
    return contactIdentity.resolveContact(tenantId, {
      channel: 'WHATSAPP', jid: hints.jid, altJids: hints.altJids, pushName: hints.pushName, knownName,
    });
  }

  // --- Routage privé / métier ------------------------------------------------------------------------------------
  const BUSINESS_CATS = new Set(['BUSINESS_LEAD', 'CUSTOMER_SUPPORT', 'PAYMENT_PROOF', 'PAYMENT_VALIDATION', 'CAMPAIGN', 'SERVICE_REQUEST', 'GENERAL_INFORMATION']);

  async function sendVia(tenantId, channel, from, text) {
    const rt = d.getRuntime && d.getRuntime();
    if (!rt || typeof rt.sendMessageVerified !== 'function') return { status: 'FAILED', error: 'NO_RUNTIME' };
    return rt.sendMessageVerified({ channel, to: from, text, tenantId });
  }

  // Retourne { handled: boolean }. handled=false -> le flux existant (autoResponder/Jarvis) continue.
  async function route({ tenantId, channel, session, msg, text, from, messageId, hasAttachment, identity }) {
    const settings = await d.autoResponder.getSettings(tenantId);
    if (!d.autoResponder.isEnabled(settings, channel)) return { handled: false, reason: 'DISABLED' };
    if (settings.assistant === false) return { handled: false, reason: 'ASSISTANT_OFF' };
    if (!from || d.autoResponder.isGroupChat(channel, from)) return { handled: false, reason: 'GROUP' };

    // Classification rapide par message : le métier suit le flux existant, inchangé.
    const state = await conversationState.get(tenantId, channel, from);
    if (state.ad) return { handled: false, reason: 'AD_CONTACT' }; // contact issu d'une campagne : conversation commerciale
    let crm = null; try { crm = await contactCrm.getContact(tenantId, channel, contactCrm.identityOf(from)); } catch (e) { crm = null; }
    const quick = conversationRouter.classify(text, { crmContact: crm, state, hasAttachment });
    if (BUSINESS_CATS.has(quick.category)) return { handled: false, reason: 'BUSINESS' };
    // Toute première salutation d'un inconnu, sur un compte qui a une activité configurée : c'est très probablement un
    // prospect -> accueil par le moteur commercial existant (réglage `firstContactMode: 'private'` pour l'éviter).
    if (quick.category === 'PRIVATE_CASUAL' && settings.firstContactMode !== 'private' && !crm && !state.turns && !state.lastReplyTs) {
      let hasBusiness = false;
      try { hasBusiness = !!(await require('./businessServices').getEngineContextText(tenantId)); } catch (e) { hasBusiness = false; }
      if (hasBusiness) return { handled: false, reason: 'FIRST_CONTACT_BUSINESS' };
    }

    const debounceMs = settings.debounceMs != null ? settings.debounceMs : DEFAULT_DEBOUNCE_MS;
    conversationQueue.submit(`priv:${sanitize(tenantId)}:${channel}:${from}`, { text, messageId },
      async (items) => {
        const out = await conversationRouter.processBatch({ tenantId, channel, from, identity, items, hasAttachment }, {
          send: (reply) => sendVia(tenantId, channel, from, reply), settings, llm: d.llm,
        });
        // Le lot pris ensemble ressemble à une demande métier : on laisse le moteur existant répondre.
        if (out.mode === 'BUSINESS') {
          await d.autoResponder.handleIncoming({ tenantId, channel, from, name: identity && identity.displayName, text: items.map((i) => i.text).join('\n'), messageId: items[items.length - 1].messageId }, { runtime: d.getRuntime && d.getRuntime() }).catch(() => {});
        }
        try {
          require('./activityStore').record({ type: 'private_route', action: `Conversation ${out.mode}`, channel, tenant: tenantId, target: identity ? identity.label : 'contact', status: 'ok', detail: `${out.category || '-'}${out.replied ? ' · réponse envoyée' : ''}${out.alerted ? ' · propriétaire prévenu' : ''}` });
        } catch (e) { /* non bloquant */ }
        return out;
      }, { debounceMs }).catch((err) => console.error(`conversationRouter (tenant "${tenantId}", ${channel}) :`, err.message));
    return { handled: true };
  }

  // --- Campagnes d'entrée (Facebook Ads) : message initial EXACT pour un nouveau contact reconnu ------------------
  async function adEntry({ tenantId, channel, msg, text, from, messageId, identity }) {
    if (String(channel).toUpperCase() !== 'WHATSAPP' || !from || d.autoResponder.isGroupChat(channel, from)) return { handled: false, reason: 'NOT_APPLICABLE' };
    return adCampaigns.handleEntry({ tenantId, channel, from, messageId, text, msg, identity }, { send: (reply) => sendVia(tenantId, channel, from, reply) });
  }

  // --- Canal propriétaire ------------------------------------------------------------------------------------
  async function ownerSessionId(tenantId) {
    const list = await d.aiStudioStore.listSessions(tenantId);
    const found = list.find((s) => s.title === ownerChannel.SESSION_TITLE);
    return found ? found.id : null;
  }

  const ownerHistory = {
    load: async (tenantId) => {
      const id = await ownerSessionId(tenantId);
      if (!id) return [];
      const s = await d.aiStudioStore.getSession(tenantId, id);
      return (s && s.messages ? s.messages : []).slice(-16);
    },
    append: async (tenantId, userText, answer) => {
      let id = await ownerSessionId(tenantId);
      let title = null;
      if (!id) { id = (await d.aiStudioStore.createSession(tenantId)).id; title = ownerChannel.SESSION_TITLE; }
      const now = new Date().toISOString();
      await d.aiStudioStore.appendMessages(tenantId, id, [
        { role: 'user', text: userText, createdAt: now, via: 'whatsapp_owner' },
        { role: 'assistant', text: answer, createdAt: now, via: 'whatsapp_owner' },
      ], title);
    },
  };

  const ownerDeps = {
    getSettings: (t) => d.autoResponder.getSettings(t),
    history: ownerHistory,
    transcribe: d.transcribeVoice || null,
    // Même cerveau que l'onglet « Chat Intelligent » : chatOrchestrator (outils, mémoire, campagnes, rapports…).
    chat: async ({ text, tenantId, history }) => {
      const last = [...history].reverse().find((m) => m.role === 'assistant') || null;
      const sid = await ownerSessionId(tenantId);
      return d.chatOrchestrator.handle({ text, history, tenantId, sessionId: sid || 'owner-whatsapp', lastAssistantMessage: last }, d.chatDeps(tenantId));
    },
    // Aucune intention/outil applicable : conversation générale, comme le fait l'onglet du tableau de bord.
    chatFallback: async (text, history) => (await d.llmFallbackEngine.generateAIResponse(text, history)).text,
    paymentDeps: (tenantId, session) => {
      const cd = d.chatDeps(tenantId);
      return { deliverToClient: cd.deliverToClient, executeOptions: cd.executeOptions };
    },
  };

  async function handleOwnerMessage({ tenantId, session, msg, configuredOwner }) {
    return ownerChannel.handleOwnerMessage({ tenantId, session, msg, configuredOwner }, ownerDeps);
  }

  // --- Démarrage : livreurs d'alertes + abonnement au canal propriétaire ----------------------------------------
  function start() {
    alertCenter.setDeliverers([
      ownerChannel.whatsappDeliverer({ peek: (t) => d.whatsappManager.peek(t), getSettings: (t) => d.autoResponder.getSettings(t) }),
      ownerChannel.studioChatDeliverer((t, text, log) => d.platformOrchestrator.notifyTenantChat(t, text, log)),
    ]);
    if (typeof d.whatsappManager.setOwnerMessageHandler === 'function') {
      d.whatsappManager.setOwnerMessageHandler(({ tenantId, session, msg }) => handleOwnerMessage({ tenantId, session, msg }));
    }
  }

  return { resolveIdentity, route, adEntry, handleOwnerMessage, start, ownerDeps, isConfiguredOwner: ownerChannel.isConfiguredOwner };
}

module.exports = { create };
