'use strict';

// Adaptateurs naturels pour les moteurs Facebook et Studio déjà utilisés par
// les routes Render. Ces outils ne créent aucun second client ni moteur.
function required(value, code) {
  if (!value) throw Object.assign(new Error(code), { code });
  return value;
}

function facebook(ctx) { return required(ctx.facebook, 'FACEBOOK_ENGINE_UNAVAILABLE'); }
function studio(ctx) {
  required(ctx.chatUploads, 'CHAT_UPLOADS_UNAVAILABLE');
  return required(ctx.ebookGenerator, 'EBOOK_ENGINE_UNAVAILABLE');
}

const contactCrm = require('../contactCrm');
const contactIdentity = require('../contactIdentity');
const XLSX = require('xlsx');

function csvCell(value) {
  const text = String(value == null ? '' : value);
  return `"${text.replace(/"/g, '""')}"`;
}

function parseRecipientsJson(value) {
  if (!value) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== 'string' || !x.trim())) throw new Error('INVALID_RECIPIENTS');
  return [...new Set(parsed.map((x) => x.trim()))];
}

function scheduledChannelAllowed(channel, ctx) {
  if (channel === 'facebook_page' || ctx.allowedModules === null) return true;
  return Array.isArray(ctx.allowedModules) && ctx.allowedModules.includes(channel);
}

async function readOwnedFile(ctx, fileId) {
  const file = await ctx.chatUploads.readFile(ctx.tenant, fileId);
  if (!file || !file.buffer) throw Object.assign(new Error('Fichier introuvable pour ce compte.'), { code: 'RESOURCE_NOT_OWNED' });
  return file;
}

const TOOLS = {
  getFacebookConnectionStatus: {
    feature: 'facebook_marketing', capabilities: ['status', 'read'],
    description: 'Vérifie réellement la connexion Facebook et renvoie le nom de la Page si elle est disponible. Ne révèle aucun jeton.',
    risk: 'READ', inputSchema: {},
    async execute(_args, ctx) {
      const result = await facebook(ctx).checkConnection();
      return { ok: true, result: { connected: !!result.connected, pageName: result.pageName || null } };
    },
  },

  listFacebookManagedGroups: {
    feature: 'facebook_marketing', capabilities: ['read', 'list'],
    description: 'Liste les groupes Facebook déjà enregistrés dans la configuration existante.',
    risk: 'READ', inputSchema: {},
    async execute(_args, ctx) {
      const groups = facebook(ctx).getManagedGroups();
      return { ok: true, result: { count: groups.length, groups: groups.map(({ id, name }) => ({ id, name })) } };
    },
  },

  addFacebookManagedGroup: {
    feature: 'facebook_marketing', capabilities: ['configure', 'write'],
    description: 'Enregistre un groupe Facebook à partir de son identifiant et nom fournis, dans la configuration existante des groupes gérés.',
    risk: 'WRITE', inputSchema: {
      groupId: { type: 'string', required: true, description: 'Identifiant réel du groupe fourni par l’utilisateur.' },
      name: { type: 'string', required: false, description: 'Nom réel du groupe.' },
    },
    async execute(args, ctx) {
      const groups = facebook(ctx).addManagedGroup(args.groupId, args.name);
      const group = groups.find((g) => String(g.id) === String(args.groupId));
      return { ok: true, result: { id: group.id, name: group.name } };
    },
    async verify(result, _args, ctx) { return { verified: !!facebook(ctx).getManagedGroups().find((g) => g.id === result.id), id: result && result.id }; },
  },

  removeFacebookManagedGroup: {
    feature: 'facebook_marketing', capabilities: ['configure', 'delete'],
    description: 'Retire un groupe de la liste Facebook gérée par CYRUS; ne quitte pas le groupe et ne supprime rien sur Facebook.',
    risk: 'WRITE', inputSchema: { groupId: { type: 'string', required: true, description: 'Identifiant exact retourné par listFacebookManagedGroups.' } },
    async execute(args, ctx) {
      const before = facebook(ctx).getManagedGroups();
      if (!before.some((g) => String(g.id) === String(args.groupId))) return { ok: false, error: { code: 'GROUP_NOT_MANAGED' } };
      facebook(ctx).removeManagedGroup(args.groupId);
      return { ok: true, result: { id: String(args.groupId), removed: true } };
    },
    async verify(result, _args, ctx) { return { verified: !facebook(ctx).getManagedGroups().some((g) => String(g.id) === result.id), id: result && result.id }; },
  },

  listFacebookPagePosts: {
    feature: 'facebook_marketing', capabilities: ['read', 'list'],
    description: 'Récupère les publications réellement présentes sur la Page Facebook connectée.',
    risk: 'READ', inputSchema: { limit: { type: 'number', required: false, description: 'Limite entre 1 et 50.' } },
    async execute(args, ctx) {
      const limit = Math.max(1, Math.min(50, Math.floor(Number(args.limit) || 20)));
      const posts = await facebook(ctx).getPagePosts({ limit });
      return { ok: true, result: { count: posts.length, posts } };
    },
  },

  listFacebookConversations: {
    feature: 'facebook_marketing', capabilities: ['read', 'list'],
    description: 'Liste les conversations Messenger réellement accessibles à la Page connectée.',
    risk: 'READ', inputSchema: {},
    async execute(_args, ctx) {
      const conversations = await facebook(ctx).getConversations();
      return { ok: true, result: { count: conversations.length, conversations } };
    },
  },

  listFacebookPostComments: {
    feature: 'facebook_marketing', capabilities: ['read', 'list'],
    description: 'Récupère les commentaires réels d’une publication de la Page Facebook.',
    risk: 'READ', inputSchema: {
      postId: { type: 'string', required: true, description: 'Identifiant réel d’une publication Facebook.' },
      limit: { type: 'number', required: false, description: 'Limite entre 1 et 100.' },
    },
    async execute(args, ctx) {
      const limit = Math.max(1, Math.min(100, Math.floor(Number(args.limit) || 50)));
      const comments = await facebook(ctx).getPostComments(args.postId, { limit });
      return { ok: true, result: { postId: args.postId, count: comments.length, comments } };
    },
  },

  publishFacebookPagePost: {
    feature: 'facebook_marketing', capabilities: ['publish', 'write'],
    description: 'Publie réellement un texte/lien ou un média importé sur la Page Facebook connectée. Le résultat doit contenir l’identifiant renvoyé par Meta.',
    risk: 'WRITE', inputSchema: {
      message: { type: 'string', required: true, description: 'Texte/caption à publier.' },
      link: { type: 'string', required: false, description: 'Lien public à joindre.' },
      fileId: { type: 'string', required: false, description: 'Identifiant d’un fichier image ou vidéo déjà importé dans cette conversation.' },
    },
    async prepare(args) { return { ok: !!String(args.message || '').trim(), preview: { destination: 'Page Facebook connectée', message: String(args.message || '').slice(0, 500), link: args.link || null, fileId: args.fileId || null }, warnings: [] }; },
    async execute(args, ctx) {
      let media = null;
      if (args.fileId) {
        media = await readOwnedFile(ctx, args.fileId);
        if (!/^(image|video)\//i.test(media.meta.type || '')) return { ok: false, error: { code: 'UNSUPPORTED_MEDIA_TYPE' } };
      }
      const result = await facebook(ctx).publishPost({
        message: String(args.message || '').trim(), link: args.link || undefined,
        mediaBuffer: media && media.buffer, mediaMimetype: media && media.meta.type,
        mediaFilename: media && media.meta.name,
      });
      return { ok: true, result: { status: 'submitted', postId: result && result.id || null } };
    },
    async verify(result) { return { verified: !!(result && result.postId), postId: result && result.postId }; },
  },

  publishFacebookManagedGroupPost: {
    feature: 'facebook_marketing', capabilities: ['publish', 'write'],
    description: 'Publie réellement sur un groupe Facebook déjà présent dans la liste des groupes gérés. Utilise l’identifiant existant et les permissions Meta du compte.',
    risk: 'WRITE', inputSchema: {
      groupId: { type: 'string', required: true, description: 'Identifiant d’un groupe retourné par listFacebookManagedGroups.' },
      message: { type: 'string', required: true, description: 'Texte à publier.' },
    },
    async prepare(args, ctx) {
      const group = facebook(ctx).getManagedGroups().find((g) => String(g.id) === String(args.groupId));
      return { ok: !!group, preview: { group: group && group.name || null, groupId: args.groupId, message: String(args.message || '').slice(0, 500) }, warnings: group ? [] : ['GROUPE_NON_ENREGISTRE'] };
    },
    async execute(args, ctx) {
      const fb = facebook(ctx);
      const group = fb.getManagedGroups().find((g) => String(g.id) === String(args.groupId));
      if (!group) return { ok: false, error: { code: 'GROUP_NOT_MANAGED' } };
      const result = await fb.publishToGroup(group.id, { message: String(args.message || '').trim() });
      return { ok: true, result: { status: 'submitted', groupId: group.id, groupName: group.name, postId: result && result.id || null } };
    },
    async verify(result) { return { verified: !!(result && result.postId), postId: result && result.postId }; },
  },

  sendFacebookMessengerMessage: {
    feature: 'facebook_marketing', capabilities: ['send', 'write'], permission: 'messages:send',
    description: 'Envoie un message Messenger réel à un PSID déjà présent dans une conversation de la Page. Meta applique ses fenêtres et règles de messagerie.',
    risk: 'WRITE', inputSchema: {
      recipientId: { type: 'string', required: true, description: 'PSID réel obtenu depuis listFacebookConversations.' },
      message: { type: 'string', required: true, description: 'Message à envoyer.' },
    },
    async prepare(args, ctx) {
      const conversations = await facebook(ctx).getConversations();
      const found = conversations.find((c) => String(c.recipientId) === String(args.recipientId));
      return { ok: !!found, preview: { recipient: found && found.name || null, recipientId: args.recipientId, message: String(args.message || '').slice(0, 500) }, warnings: found ? [] : ['DESTINATAIRE_SANS_CONVERSATION'] };
    },
    async execute(args, ctx) {
      const fb = facebook(ctx);
      const conversations = await fb.getConversations();
      if (!conversations.some((c) => String(c.recipientId) === String(args.recipientId))) return { ok: false, error: { code: 'RECIPIENT_NOT_FOUND' } };
      const result = await fb.sendMessage(args.recipientId, String(args.message || '').trim());
      return { ok: true, result: { recipientId: result && result.recipient_id || args.recipientId, messageId: result && result.message_id || null } };
    },
    async verify(result) { return { verified: !!(result && result.messageId), messageId: result && result.messageId }; },
  },

  replyFacebookComment: {
    feature: 'facebook_marketing', capabilities: ['reply', 'write'],
    description: 'Répond réellement à un commentaire Facebook identifié.',
    risk: 'WRITE', inputSchema: {
      commentId: { type: 'string', required: true, description: 'Identifiant réel du commentaire.' },
      message: { type: 'string', required: true, description: 'Réponse publique à publier.' },
    },
    async execute(args, ctx) {
      const result = await facebook(ctx).replyToComment(args.commentId, String(args.message || '').trim());
      return { ok: true, result: { commentId: result && result.id || null, parentCommentId: args.commentId } };
    },
    async verify(result) { return { verified: !!(result && result.commentId), commentId: result && result.commentId }; },
  },

  moderateFacebookComment: {
    feature: 'facebook_marketing', capabilities: ['moderate', 'write'],
    description: 'Masque ou réaffiche un commentaire Facebook existant (suppression réversible).',
    risk: 'WRITE', inputSchema: {
      commentId: { type: 'string', required: true, description: 'Identifiant réel du commentaire.' },
      hide: { type: 'boolean', required: true, description: 'true pour masquer, false pour réafficher.' },
    },
    async execute(args, ctx) {
      const result = await facebook(ctx).moderateComment(args.commentId, { hide: args.hide === true || args.hide === 'true' });
      return { ok: true, result: { commentId: args.commentId, hidden: args.hide === true || args.hide === 'true', success: !!(result && result.success) } };
    },
    async verify(result) { return { verified: !!(result && result.success), commentId: result && result.commentId }; },
  },

  sendFacebookPrivateReply: {
    feature: 'facebook_marketing', capabilities: ['send', 'write'],
    description: 'Envoie une vraie réponse privée à l’auteur d’un commentaire Facebook, selon les règles et fenêtres d’autorisation Meta.',
    risk: 'WRITE', inputSchema: {
      commentId: { type: 'string', required: true, description: 'Identifiant réel d’un commentaire.' },
      message: { type: 'string', required: true, description: 'Message privé à envoyer.' },
    },
    async execute(args, ctx) {
      const result = await facebook(ctx).sendPrivateReply(args.commentId, String(args.message || '').trim());
      return { ok: true, result: { commentId: args.commentId, messageId: result && result.message_id || result && result.id || null } };
    },
    async verify(result) { return { verified: !!(result && result.messageId), messageId: result && result.messageId }; },
  },

  deleteFacebookComment: {
    feature: 'facebook_marketing', capabilities: ['delete', 'write'],
    description: 'Supprime définitivement un commentaire Facebook existant; utilise cette action seulement si elle est explicitement demandée.',
    risk: 'SENSITIVE', inputSchema: { commentId: { type: 'string', required: true, description: 'Identifiant réel du commentaire à supprimer.' } },
    async execute(args, ctx) {
      const result = await facebook(ctx).deleteComment(args.commentId);
      return { ok: true, result: { commentId: args.commentId, success: !!(result && result.success) } };
    },
    async verify(result) { return { verified: !!(result && result.success), commentId: result && result.commentId }; },
  },

  listFacebookKeywordRules: {
    feature: 'facebook_marketing', capabilities: ['read', 'list'],
    description: 'Liste les règles réellement configurées de mots-clés → réponse automatique Facebook, sans exposer les chemins locaux de médias.',
    risk: 'READ', inputSchema: {},
    async execute(_args, ctx) {
      const rules = required(ctx.keywordRules, 'FACEBOOK_RULES_UNAVAILABLE').list();
      return { ok: true, result: { count: rules.length, rules: rules.map((r) => ({ id: r.id, keyword: r.keyword, replyMessage: r.replyMessage, hasMedia: !!r.mediaUrl, createdAt: r.createdAt })) } };
    },
  },

  createFacebookKeywordRule: {
    feature: 'facebook_marketing', capabilities: ['configure', 'write'],
    description: 'Ajoute une règle au moteur existant qui répond automatiquement aux commentaires ou messages Messenger contenant le mot-clé fourni.',
    risk: 'WRITE', inputSchema: {
      keyword: { type: 'string', required: true, description: 'Mot ou expression à détecter.' },
      replyMessage: { type: 'string', required: true, description: 'Réponse automatique réelle à envoyer.' },
    },
    async execute(args, ctx) {
      const rule = required(ctx.keywordRules, 'FACEBOOK_RULES_UNAVAILABLE').create({ keyword: args.keyword, replyMessage: args.replyMessage });
      return { ok: true, result: { id: rule.id, keyword: rule.keyword, replyMessage: rule.replyMessage } };
    },
    async verify(result, _args, ctx) { return { verified: required(ctx.keywordRules, 'FACEBOOK_RULES_UNAVAILABLE').list().some((r) => r.id === result.id), id: result && result.id }; },
  },

  deleteFacebookKeywordRule: {
    feature: 'facebook_marketing', capabilities: ['configure', 'delete'],
    description: 'Supprime une règle de mot-clé Facebook existante par son identifiant.',
    risk: 'WRITE', inputSchema: { id: { type: 'string', required: true, description: 'Identifiant retourné par listFacebookKeywordRules.' } },
    async execute(args, ctx) {
      const rules = required(ctx.keywordRules, 'FACEBOOK_RULES_UNAVAILABLE');
      if (!rules.list().some((r) => r.id === args.id)) return { ok: false, error: { code: 'RULE_NOT_FOUND' } };
      rules.remove(args.id);
      return { ok: true, result: { id: args.id, removed: true } };
    },
    async verify(result, _args, ctx) { return { verified: !required(ctx.keywordRules, 'FACEBOOK_RULES_UNAVAILABLE').list().some((r) => r.id === result.id), id: result && result.id }; },
  },

  listFacebookProspects: {
    feature: 'facebook_marketing', capabilities: ['read', 'list'],
    description: 'Liste les prospects réellement capturés depuis les commentaires et conversations Messenger de la Page, avec filtres facultatifs.',
    risk: 'READ', inputSchema: { keyword: { type: 'string' }, source: { type: 'string' } },
    async execute(args, ctx) {
      const prospects = required(ctx.contactsStore, 'FACEBOOK_PROSPECTS_UNAVAILABLE').list({ keyword: args.keyword || undefined, source: args.source || undefined });
      return { ok: true, result: { count: prospects.length, prospects } };
    },
  },

  exportFacebookProspects: {
    feature: 'facebook_marketing', capabilities: ['export', 'read'],
    description: 'Exporte les prospects Facebook réels en CSV dans les fichiers du compte courant.',
    risk: 'LOW_WRITE', inputSchema: { keyword: { type: 'string' }, source: { type: 'string' } },
    async execute(args, ctx) {
      const prospects = required(ctx.contactsStore, 'FACEBOOK_PROSPECTS_UNAVAILABLE').list({ keyword: args.keyword || undefined, source: args.source || undefined });
      const cols = ['name', 'psid', 'source', 'keyword', 'lastText', 'postId', 'autoReplied', 'createdAt', 'updatedAt'];
      const lines = [cols.join(',')];
      for (const p of prospects) lines.push([p.name, p.psid, p.source, p.keyword, p.lastText, p.postId, p.autoReplied ? 'true' : 'false', p.createdAt, p.updatedAt].map(csvCell).join(','));
      const file = await ctx.chatUploads.save(ctx.tenant, { originalname: `facebook_prospects_${new Date().toISOString().slice(0, 10)}.csv`, mimetype: 'text/csv', buffer: Buffer.from(`\uFEFF${lines.join('\r\n')}`, 'utf8') });
      return { ok: true, result: { fileId: file.id, name: file.name, size: file.size, count: prospects.length } };
    },
    async verify(result, _args, ctx) { return { verified: !!(result && await ctx.chatUploads.get(ctx.tenant, result.fileId)) }; },
  },

  importFacebookContactsFromFile: {
    feature: 'facebook_marketing', capabilities: ['import', 'read', 'write'],
    description: 'Lit un fichier CSV/Excel importé, identifie les PSID/noms puis compare les PSID aux conversations Messenger réelles. Seuls les contacts identifiés sont enregistrés dans le CRM du compte.',
    risk: 'LOW_WRITE', confirmWhenTainted: () => true,
    inputSchema: { fileId: { type: 'string', required: true, description: 'Identifiant d’un fichier CSV/Excel importé dans cette conversation.' } },
    async execute(args, ctx) {
      const file = await readOwnedFile(ctx, args.fileId);
      if (!/\.(csv|xls|xlsx)$/i.test(file.meta.name) || file.buffer.length > 10 * 1024 * 1024) return { ok: false, error: { code: 'UNSUPPORTED_CONTACT_FILE' } };
      let rows;
      try {
        const workbook = XLSX.read(file.buffer, { type: 'buffer' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(sheet).slice(0, 5000);
      } catch (_err) { return { ok: false, error: { code: 'CONTACT_FILE_PARSE_FAILED' } }; }
      const contacts = rows.map((row) => ({
        psid: String(row.psid || row.PSID || row.recipientId || row.id || '').trim() || null,
        name: String(row.prenom || row.Prenom || row.nom || row.Nom || row.name || row.Name || '').trim(),
      })).filter((c) => c.psid || c.name);
      if (!contacts.length) return { ok: true, result: { total: 0, matched: 0, savedToCrm: 0, contacts: [] } };
      const fb = facebook(ctx);
      const resolvedRaw = fb.isConfigured() ? await fb.resolveRecipientsFromConversations(contacts) : contacts.map((c) => ({ ...c, recipientId: null, matched: false }));
      const seenPsids = new Set();
      const resolved = resolvedRaw.map((c) => {
        const psid = c.matched && c.recipientId ? String(c.recipientId).trim() : null;
        if (psid && seenPsids.has(psid)) return { ...c, psid, duplicate: true };
        if (psid) seenPsids.add(psid);
        return { ...c, psid, duplicate: false };
      });
      const identified = resolved.filter((c) => c.matched && c.psid && !c.duplicate).map((c) => ({
        channel: 'FACEBOOK', from: c.psid, name: c.name || null, source: 'facebook_import',
        identity: contactIdentity.resolveIdentity({ channel: 'FACEBOOK', jid: c.psid, knownName: c.name || null }),
        eventId: `facebook_import:${require('crypto').createHash('sha256').update(c.psid).digest('hex')}`,
      }));
      const crmReport = identified.length ? await contactCrm.recordBatch(ctx.tenant, identified, { source: 'facebook_import', batchId: require('crypto').randomUUID() }) : null;
      return { ok: true, result: { total: resolved.length, matched: resolved.filter((c) => c.matched && !c.duplicate).length, duplicates: resolved.filter((c) => c.duplicate).length, savedToCrm: identified.length, crmReport, contacts: resolved.map((c) => ({ name: c.name, psid: c.psid, recipientId: c.recipientId || null, matched: !!c.matched, duplicate: !!c.duplicate })) } };
    },
    async verify(result, _args, ctx) {
      if (!result || !Number.isInteger(result.total) || !Number.isInteger(result.matched) || result.matched > result.total) return { verified: false, code: 'INVALID_IMPORT_REPORT' };
      const saved = (result.contacts || []).filter((c) => c.matched && !c.duplicate && c.psid);
      if (saved.length !== result.savedToCrm) return { verified: false, code: 'CRM_IMPORT_COUNT_MISMATCH' };
      const persisted = await Promise.all(saved.map((c) => contactCrm.getContact(ctx.tenant, 'FACEBOOK', c.psid)));
      const persistedCount = persisted.filter(Boolean).length;
      return { verified: persistedCount === result.savedToCrm, matched: result.matched, savedToCrm: persistedCount };
    },
  },

  getStudioMediaStatus: {
    feature: 'media_content', capabilities: ['read', 'status'], requiredModule: 'studio_video',
    description: 'Donne l’état réel des moteurs de génération et des connexions YouTube, Instagram et TikTok, sans révéler leurs secrets.',
    risk: 'READ', inputSchema: {},
    async execute(_args, ctx) {
      const images = required(ctx.imageAiEngine, 'IMAGE_ENGINE_UNAVAILABLE').isConfigured();
      const video = required(ctx.videoAiEngine, 'VIDEO_ENGINE_UNAVAILABLE').isConfigured();
      const publisher = required(ctx.mediaPublisher, 'MEDIA_PUBLISHER_UNAVAILABLE');
      return { ok: true, result: {
        image: images, video,
        youtube: !!publisher.isYoutubeConfigured(), instagram: !!publisher.isInstagramConfigured(), tiktok: !!publisher.isTikTokConfigured(),
      } };
    },
  },

  listAiStudioSessions: {
    feature: 'media_content', capabilities: ['read', 'list'], requiredModule: 'studio_video',
    description: 'Liste les sessions du Studio IA appartenant au compte courant, sans exposer les messages complets.',
    risk: 'READ', inputSchema: {},
    async execute(_args, ctx) {
      const sessions = await required(ctx.aiStudioStore, 'AI_STUDIO_STORE_UNAVAILABLE').listSessions(ctx.tenant);
      return { ok: true, result: { count: sessions.length, sessions } };
    },
  },

  createAiStudioSession: {
    feature: 'media_content', capabilities: ['create', 'write'], requiredModule: 'studio_video',
    description: 'Crée une session réelle du Studio IA pour le compte courant.',
    risk: 'LOW_WRITE', inputSchema: {},
    async execute(_args, ctx) {
      const session = await required(ctx.aiStudioStore, 'AI_STUDIO_STORE_UNAVAILABLE').createSession(ctx.tenant);
      return { ok: true, result: { id: session.id, title: session.title, createdAt: session.createdAt } };
    },
    async verify(result, _args, ctx) { return { verified: !!(result && await ctx.aiStudioStore.getSession(ctx.tenant, result.id)) }; },
  },

  generateEbookPdf: {
    feature: 'media_content', capabilities: ['generate', 'write'], requiredModule: 'studio_video',
    description: 'Compose un vrai PDF à partir du titre et des chapitres fournis, puis l’enregistre dans les fichiers du compte. Le contenu fourni par l’utilisateur n’est pas inventé.',
    risk: 'LOW_WRITE', inputSchema: {
      title: { type: 'string', required: true, description: 'Titre du livre.' },
      chaptersJson: { type: 'string', required: true, description: 'Tableau JSON de chapitres, par exemple [{"title":"Chapitre 1","content":"Texte fourni"}].' },
      subtitle: { type: 'string', required: false, description: 'Sous-titre optionnel.' },
      author: { type: 'string', required: false, description: 'Auteur optionnel.' },
    },
    async execute(args, ctx) {
      const chapters = JSON.parse(args.chaptersJson);
      if (!Array.isArray(chapters) || !chapters.length || chapters.length > 30
          || chapters.some((c) => !c || typeof c.title !== 'string' || typeof c.content !== 'string')) {
        return { ok: false, error: { code: 'INVALID_CHAPTERS' } };
      }
      const pdf = await studio(ctx).generateEbookPdf({ title: String(args.title).slice(0, 200), subtitle: args.subtitle || '', author: args.author || '', chapters });
      const file = await ctx.chatUploads.save(ctx.tenant, { originalname: `${String(args.title).slice(0, 100)}.pdf`, mimetype: 'application/pdf', buffer: pdf });
      return { ok: true, result: { fileId: file.id, name: file.name, size: file.size, type: file.type } };
    },
    async verify(result, _args, ctx) { return { verified: !!(result && await ctx.chatUploads.get(ctx.tenant, result.fileId)) }; },
  },

  exportContacts: {
    feature: 'contacts_crm', capabilities: ['export', 'read'],
    description: 'Exporte les contacts CRM réels du compte courant dans un fichier CSV téléchargeable. Les critères de filtre restent facultatifs.',
    risk: 'LOW_WRITE', inputSchema: {
      tag: { type: 'string', required: false, description: 'Filtrer par étiquette CRM.' },
      channel: { type: 'string', required: false, description: 'WHATSAPP ou TELEGRAM.' },
    },
    async execute(args, ctx) {
      const channel = args.channel ? String(args.channel).toUpperCase() : undefined;
      const items = await contactCrm.list(ctx.tenant, { tag: args.tag, channel });
      const columns = ['name', 'phone', 'channel', 'tags', 'stage', 'optOut', 'firstSeen', 'lastSeen'];
      const lines = [columns.join(',')];
      for (const item of items) {
        const row = [item.name || '', item.phone || item.from || '', item.channel || '', (item.tags || []).join('|'), item.stage || '', item.optOut ? 'true' : 'false', item.firstSeen || '', item.lastSeen || ''];
        lines.push(row.map(csvCell).join(','));
      }
      const file = await ctx.chatUploads.save(ctx.tenant, {
        originalname: `contacts_${new Date().toISOString().slice(0, 10)}.csv`,
        mimetype: 'text/csv', buffer: Buffer.from(`\uFEFF${lines.join('\r\n')}`, 'utf8'),
      });
      return { ok: true, result: { fileId: file.id, name: file.name, size: file.size, count: items.length, type: file.type } };
    },
    async verify(result, _args, ctx) { return { verified: !!(result && await ctx.chatUploads.get(ctx.tenant, result.fileId)) }; },
  },

  listScheduledMessages: {
    feature: 'campaigns_followups', capabilities: ['read', 'list', 'status'],
    description: 'Liste les messages programmés appartenant au compte courant. Les programmations des autres comptes et les anciennes entrées sans propriétaire ne sont jamais exposées.',
    risk: 'READ', inputSchema: { channel: { type: 'string', required: false, description: 'whatsapp, telegram ou facebook_page.' } },
    async execute(args, ctx) {
      const store = required(ctx.scheduledMessages, 'SCHEDULED_MESSAGES_UNAVAILABLE');
      const channel = args.channel ? String(args.channel).toLowerCase() : undefined;
      const items = store.list({ tenantId: ctx.tenant, channel }).filter((item) => scheduledChannelAllowed(item.channel, ctx));
      return { ok: true, result: { count: items.length, messages: items.map((item) => ({
        id: item.id, channel: item.channel, recipientType: item.recipientType || null,
        recipientCount: Array.isArray(item.recipients) ? item.recipients.length : 0,
        message: item.message || '', scheduledAt: item.scheduledAt, status: item.status,
        attempts: item.attempts || 0, createdAt: item.createdAt,
      })) } };
    },
  },

  scheduleMessage: {
    feature: 'campaigns_followups', capabilities: ['schedule', 'write'],
    description: 'Ajoute une vraie programmation au moteur partagé existant pour WhatsApp, Telegram ou la Page Facebook. Les identifiants de destinataires doivent être fournis explicitement; l’exécution suivra la session du compte propriétaire.',
    risk: 'WRITE', inputSchema: {
      channel: { type: 'string', required: true, description: 'whatsapp, telegram ou facebook_page.' },
      scheduledAt: { type: 'string', required: true, description: 'Date future en format ISO.' },
      message: { type: 'string', required: true, description: 'Texte à programmer.' },
      recipientsJson: { type: 'string', required: false, description: 'Tableau JSON d’identifiants de contacts/groupes; requis sauf pour une publication Facebook Page seule.' },
      recipientType: { type: 'string', required: false, description: 'contacts ou groups.' },
    },
    async prepare(args) {
      let recipients = [];
      try { recipients = parseRecipientsJson(args.recipientsJson); } catch (_err) { /* signalé dans le preview */ }
      return { ok: true, preview: { channel: String(args.channel || '').toLowerCase(), scheduledAt: args.scheduledAt, message: String(args.message || '').slice(0, 500), recipientCount: recipients.length }, warnings: [] };
    },
    async execute(args, ctx) {
      const channel = String(args.channel || '').toLowerCase();
      if (!['whatsapp', 'telegram', 'facebook_page'].includes(channel)) return { ok: false, error: { code: 'INVALID_CHANNEL' } };
      if (!scheduledChannelAllowed(channel, ctx)) return { ok: false, error: { code: 'MODULE_NOT_ALLOWED', module: channel } };
      const scheduledAt = new Date(args.scheduledAt);
      if (!Number.isFinite(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) return { ok: false, error: { code: 'SCHEDULE_DATE_MUST_BE_FUTURE' } };
      let recipients;
      try { recipients = parseRecipientsJson(args.recipientsJson); }
      catch (_err) { return { ok: false, error: { code: 'INVALID_RECIPIENTS' } }; }
      if (channel !== 'facebook_page' && !recipients.length) return { ok: false, error: { code: 'RECIPIENTS_REQUIRED' } };
      if (channel === 'facebook_page') {
        const groups = facebook(ctx).getManagedGroups();
        if (recipients.some((id) => !groups.some((g) => String(g.id) === id))) return { ok: false, error: { code: 'GROUP_NOT_MANAGED' } };
      }
      const entry = required(ctx.scheduledMessages, 'SCHEDULED_MESSAGES_UNAVAILABLE').create({
        tenantId: ctx.tenant, channel, recipientType: args.recipientType || 'contacts',
        recipients, message: String(args.message || '').trim(), scheduledAt: scheduledAt.toISOString(),
      });
      return { ok: true, result: { id: entry.id, channel: entry.channel, scheduledAt: entry.scheduledAt, status: entry.status, recipientCount: recipients.length } };
    },
    async verify(result, _args, ctx) {
      const entry = result && required(ctx.scheduledMessages, 'SCHEDULED_MESSAGES_UNAVAILABLE').get(result.id, { tenantId: ctx.tenant });
      return { verified: !!(entry && entry.status === 'pending'), id: entry && entry.id || null };
    },
  },

  cancelScheduledMessage: {
    feature: 'campaigns_followups', capabilities: ['cancel', 'write'],
    description: 'Annule une programmation en attente appartenant au compte courant; une programmation déjà en cours ou envoyée ne peut pas être annulée.',
    risk: 'WRITE', inputSchema: { id: { type: 'string', required: true, description: 'Identifiant retourné par listScheduledMessages.' } },
    async execute(args, ctx) {
      const store = required(ctx.scheduledMessages, 'SCHEDULED_MESSAGES_UNAVAILABLE');
      const entry = store.get(args.id, { tenantId: ctx.tenant });
      if (!entry) return { ok: false, error: { code: 'SCHEDULE_NOT_FOUND' } };
      if (!scheduledChannelAllowed(entry.channel, ctx)) return { ok: false, error: { code: 'MODULE_NOT_ALLOWED', module: entry.channel } };
      try {
        const cancelled = store.cancel(args.id, { tenantId: ctx.tenant });
        return { ok: true, result: { id: cancelled.id, status: cancelled.status } };
      } catch (err) {
        return { ok: false, error: { code: err.message === 'ONLY_PENDING_CAN_BE_CANCELLED' ? err.message : 'CANCEL_FAILED' } };
      }
    },
    async verify(result, _args, ctx) {
      const entry = result && required(ctx.scheduledMessages, 'SCHEDULED_MESSAGES_UNAVAILABLE').get(result.id, { tenantId: ctx.tenant });
      return { verified: !!(entry && entry.status === 'cancelled'), id: entry && entry.id || null };
    },
  },
};

module.exports = { TOOLS };
