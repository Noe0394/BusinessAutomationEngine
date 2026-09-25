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
const groupCampaigns = require('./groupCampaigns');

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
      channel: 'WHATSAPP', jid: hints.jid, altJids: hints.altJids, contactName: hints.savedName || null, pushName: hints.pushName, knownName,
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
    // Un apprenant qui pose une question de cours n'est PAS une conversation privée « quotidienne » : moteur d'accompagnement (autoResponder).
    try { const lp = await require('./learnerSupport').prepare({ tenantId, tenant: tenantId, channel, from, text, state, isGroup: false, settings }); if (lp && lp.active) return { handled: false, reason: 'LEARNING' }; } catch (e) { /* facultatif */ }
    if (state.groupOrigin) return { handled: false, reason: 'GROUP_LEAD' }; // prospect issu d'un groupe : conversation commerciale
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
        // Conversation privée d'un contact : chaque lot est un ÉCHANGE IA client (limite 10/heure, voir clientAiQuota).
        const out = await require('./clientLimitGuard').guardExchange(
          { tenantId, channel, from, identity, exchangeId: items[items.length - 1].messageId, isGroup: false },
          () => conversationRouter.processBatch({ tenantId, channel, from, identity, items, hasAttachment }, {
            send: (reply) => sendVia(tenantId, channel, from, reply), settings, llm: d.llm, llmReasoning: d.llmReasoning,
          }),
        );
        if (out && out.skipped === 'AI_LIMIT') return out;
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

  // --- Campagnes de groupes : membre intéressé / preuve de paiement (expéditeur RÉEL, jamais l'id du groupe) -------------
  async function groupSenderIdentity({ tenantId, session, msg }) {
    const hints = session && typeof session.getIdentityHints === 'function' ? session.getIdentityHints(msg) : null;
    const senderJid = (hints && hints.senderJid) || (msg && msg.key && msg.key.participant) || null;
    if (!senderJid) return { senderJid: null, identity: null };
    const identity = await contactIdentity.resolveContact(tenantId, {
      channel: 'WHATSAPP', jid: senderJid, altJids: (hints && hints.altJids) || [], contactName: hints && hints.savedName || null,
      pushName: (hints && hints.pushName) || (msg && msg.pushName) || null, knownName: (hints && hints.knownName) || null,
    });
    return { senderJid, identity };
  }
  const sendTo = (tenantId) => (to, text) => sendVia(tenantId, 'WHATSAPP', to, text);
  const registerProof = (args) => require('./manualPaymentValidator').registerProof(args);

  async function groupEntry({ tenantId, session, msg, text, from, messageId, hasAttachment }) {
    // Groupe hors campagne : aucun traitement (ni identité, ni annuaire) — les autres groupes ne sont pas concernés.
    if (!(await groupCampaigns.hasCampaignForGroup(tenantId, from))) return { handled: false, reason: 'NOT_A_CAMPAIGN_GROUP' };
    const { senderJid, identity } = await groupSenderIdentity({ tenantId, session, msg });
    if (!senderJid || !identity) return { handled: false, reason: 'SENDER_UNKNOWN' };
    const proof = await groupCampaigns.handleLeadProof({ tenantId, identity, text, hasAttachment, messageId, jidForReply: senderJid }, { send: sendTo(tenantId), registerProof });
    if (proof.handled) return proof;
    return groupCampaigns.handleGroupMessage({ tenantId, groupJid: from, senderJid, identity, text, messageId }, { send: sendTo(tenantId) });
  }

  async function leadDm({ tenantId, jid, identity, text, hasAttachment, messageId }) {
    if (!identity || !identity.contactId) return { handled: false, reason: 'NO_IDENTITY' };
    const lead = await groupCampaigns.ensureConversationOrigin(tenantId, jid, identity);
    if (!lead) return { handled: false, reason: 'NOT_A_LEAD' };
    return groupCampaigns.handleLeadProof({ tenantId, identity, text, hasAttachment, messageId, jidForReply: jid }, { send: sendTo(tenantId), registerProof });
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
      const storedUserText = /^\s*(?:\/telegram-(?:code|password)\b|(?:code|otp)\s*telegram\b)/i.test(String(userText || ''))
        ? '[identifiant Telegram masqué]'
        : userText;
      await d.aiStudioStore.appendMessages(tenantId, id, [
        { role: 'user', text: storedUserText, createdAt: now, via: 'whatsapp_owner' },
        { role: 'assistant', text: answer, createdAt: now, via: 'whatsapp_owner' },
      ], title);
    },
  };

  const ownerDeps = {
    getSettings: (t) => d.autoResponder.getSettings(t),
    history: ownerHistory,
    // Les notes vocales et fichiers passent par le pipeline médias COMMUN (ai-engine/mediaPipeline.js), pas par un transcripteur
    // propre au canal.
    transcribe: null,
    // Même cerveau que l'onglet « Chat Intelligent » : chatOrchestrator (outils, mémoire, campagnes, rapports…). Le principal
    // (OWNER, émis par ownerChannel après vérification du self-chat) et la « teinte » du tour (contenu externe) sont transmis tels quels.
    chat: async ({ text, tenantId, history, principal, tainted }) => {
      const last = [...history].reverse().find((m) => m.role === 'assistant') || null;
      // Clé stable : les missions persistantes et confirmations restent
      // retrouvables après la création du premier historique propriétaire.
      return d.chatOrchestrator.handle({ text, history, tenantId, sessionId: 'owner-self-chat', lastAssistantMessage: last, principal, tainted: !!tainted }, d.chatDeps(tenantId));
    },
    // Aucune intention/outil applicable : conversation générale, comme le fait l'onglet du tableau de bord.
    // Conversation courante : persona + activité réelle du compte + mémoire récente, UN seul appel (niveau standard de la cascade, doublon parallèle si un modèle est lent).
    chatFallback: async (text, history, tenantId) => {
      let biz = ''; try { biz = await require('./businessServices').getEngineContextText(tenantId); } catch (e) { biz = ''; }
      const recent = (history || []).slice(-6).map((m) => `${m.role === 'assistant' ? 'Moi' : 'Vous'} : ${String(m.text || '').slice(0, 300)}`).join('\n');
      const prompt = [
        require('./personaManager').personaSystemPrompt('default'),
        biz ? `Activité RÉELLE du vendeur (source de vérité, n'invente rien au-delà) :\n${biz}` : '',
        recent ? `Échanges récents :\n${recent}` : '',
        'Réponds directement, de façon naturelle et brève. Si la demande exige de LIRE ou de MODIFIER des données réelles du compte (contacts, messages, campagnes, groupes…), n\'invente AUCUN chiffre ni résultat : dis ce que tu vas vérifier et invite à formuler un ordre précis.',
        `Message du vendeur : "${text}"`,
      ].filter(Boolean).join('\n\n');
      return (await d.llmFallbackEngine.generateAIResponse(prompt, [], null, undefined, null, { purpose: 'owner_chat', tenant: tenantId, tier: 'standard', maxTokens: 500 })).text;
    },
    paymentDeps: (tenantId, session) => {
      const cd = d.chatDeps(tenantId);
      return { deliverToClient: cd.deliverToClient, executeOptions: cd.executeOptions };
    },
  };

  async function handleOwnerMessage({ tenantId, session, msg, configuredOwner, channel }) {
    return ownerChannel.handleOwnerMessage({ tenantId, session, msg, configuredOwner, channel: channel || 'WHATSAPP' }, ownerDeps);
  }

  // --- Démarrage : livreurs d'alertes + abonnement au canal propriétaire ----------------------------------------
  function start() {
    alertCenter.setDeliverers([
      ownerChannel.whatsappDeliverer({ peek: (t) => d.whatsappManager.peek(t), getSettings: (t) => d.autoResponder.getSettings(t) }),
      ownerChannel.studioChatDeliverer((t, text, log) => d.platformOrchestrator.notifyTenantChat(t, text, log)),
    ]);
    if (typeof d.whatsappManager.setOwnerMessageHandler === 'function') {
      d.whatsappManager.setOwnerMessageHandler(({ tenantId, session, msg }) => handleOwnerMessage({ tenantId, session, msg, channel: 'WHATSAPP' }));
    }
    // Parité Telegram : « Messages sauvegardés » du compte connecté = self-chat propriétaire, MÊME moteur.
    if (d.telegramManager && typeof d.telegramManager.setOwnerMessageHandler === 'function') {
      d.telegramManager.setOwnerMessageHandler(({ tenantId, session, msg }) => handleOwnerMessage({ tenantId, session, msg, channel: 'TELEGRAM' }));
    }
  }

  return { resolveIdentity, route, adEntry, groupEntry, leadDm, handleOwnerMessage, start, ownerDeps, isConfiguredOwner: ownerChannel.isConfiguredOwner };
}

module.exports = { create };
