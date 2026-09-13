// GOAL CHAT — fenêtre de dialogue objectif -> plan (dual-env : Node + navigateur)
// -------------------------------------------------------------------------------
// Véritable conversation (ZERO fake chatbot) : le module ne réinvente AUCUN
// moteur. Il orchestre les moteurs réels déjà présents :
//   - task-parser        : détection objectif/ventes/prospection/contenu,
//                          nombres/unités/devises, canaux, plan de tâches.
//   - human-context-engine : analyse du message (sentiment, intentions,
//                          objections, stratégie) quand le plan est prêt.
// L'exécution est INJECTÉE (opts.run) :
//   - côte VPS  : automation-engine + action-executor (runtime réel) ;
//   - côté local: navigation vers les écrans réels existants (campagnes,
//                 relance, génération, etc.) — zéro mock.
//
// Principe conversationnel déterministe :
//   1. objectif exprimé  -> détection ; si une info REQUISE manque (nombre de
//      ventes/prospects/contenus, canaux), une question ciblée est posée.
//   2. réponse            -> extraction (nombre, unité, canal) + fusion.
//   3. complet            -> plan construit, analyse Human Context, boutons
//                           d'action réels retournés.
// Sessions sans objectif -> petit dialogue (salut / aide) puis recentrage.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CyrusGoalChat = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ------------------------------------------------------------------ labels
  const GOAL_LABEL = {
    SALES: 'ventes',
    PROSPECTING: 'prospection',
    CONTENT: 'création de contenu',
    FOLLOWUP: 'suivi / relance',
    ANALYSIS: 'analyse / rapport',
    ACCOUNTS: 'comptes & accès',
    DEFAULT: 'analyse de la situation',
  };
  const GOAL_ICON = { SALES: '💰', PROSPECTING: '🎯', CONTENT: '🎬', FOLLOWUP: '📞', ANALYSIS: '📊', ACCOUNTS: '🔑', DEFAULT: '🧠' };
  const CHANNEL_ICON = { WHATSAPP: '🚀', TELEGRAM: '✈️', TIKTOK: '🎵', YOUTUBE: '▶️' };
  const ACTION_LABEL = {
    EXTRACT_MEMBERS: 'Extraire les contacts',
    SEND_CAMPAIGN: 'Lancer la campagne',
    FOLLOW_UP: 'Planifier la relance',
    ANALYZE_RESPONSES: 'Analyser les réponses',
    ANALYZE_HUMAN_CONTEXT: 'Analyser le contexte humain',
    REPLY_COMMENT: 'Répondre aux commentaires',
    GENERATE_VIDEO: 'Générer la vidéo',
    PAUSE_CAMPAIGN: 'Pause campagne',
    RESUME_CAMPAIGN: 'Reprendre campagne',
    GENERATE_REPORT: 'Générer le rapport',
    CREATE_USER_ACCOUNT: 'Créer le compte utilisateur',
    GENERATE_ACCESS_KEY: 'Générer la clé d accès',
  };

  const REQUIRED = {
    SALES: ['target', 'channels'],
    PROSPECTING: ['target', 'channels'],
    CONTENT: ['target', 'channels'],
    FOLLOWUP: ['channels'],
    ANALYSIS: [],
    ACCOUNTS: [],
    DEFAULT: [],
  };

  const TARGET_UNITS = {
    SALES: ['packs', 'produits', 'ventes', 'clients', 'formations', 'inscriptions', 'abonnements'],
    PROSPECTING: ['prospects', 'contacts', 'groupes', 'membres', 'leads'],
    CONTENT: ['contenus', 'videos', 'shorts', 'posts', 'reels'],
  };

  // ------------------------------------------------------------------ helpers
  function nf(text) {
    return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }
  function pick(arr) { return arr && arr.length ? arr : []; }
  function nowIso() { return new Date().toISOString(); }

  // Extraction cible : « 50 produits », « 20 prospects », « 3 contenus », ou
  // une réponse quasi-numérique (« 50 », « deux-cents » ignoré -> null).
  function detectTarget(text, goalType) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    const units = TARGET_UNITS[goalType] || [];
    const unitRe = units.length ? '(?:' + units.join('|') + ')' : '[a-zà-ÿéè]+';
    let m = s.match(new RegExp('(\\d[\\d\\s.,]*)\\s+(' + unitRe + ')', 'i'));
    if (m) {
      const n = parseFloat(m[1].replace(/[\s.,]/g, '.'));
      if (isFinite(n) && n > 0) return { target: Math.round(n), unit: m[2].replace(/s$/, '') };
    }
    // réponse seule : « 50 » ou « 50 produits » sans verbe
    m = s.match(/^(\d[0-9\s.,]*)\s*(?:(packs?|produits?|ventes?|prospects?|contacts?|contenus?|videos?|shorts?|posts?|reels?|formations?|inscriptions?|abonnements?))?\s*$/i);
    if (m) {
      const n = parseFloat(m[1].replace(/[\s.,]/g, '.'));
      if (isFinite(n) && n > 0) return { target: Math.round(n), unit: (m[2] || '').replace(/s$/, '') || null };
    }
    return { target: null, unit: null };
  }

  function detectMoney(text) {
    const s = String(text || '');
    const ccy = /fcf[aà]|xof|€|eur|usd|\$|francs?/i.test(s);
    const m = s.match(/(\d[\d\s.,]*(?:\.\d+)?)\s*(?:fcf[aà]|xof|€|eur|usd|\$|francs?)/i);
    if (m) {
      const n = parseFloat(m[1].replace(/[\s.,]/g, '.'));
      if (isFinite(n)) return { revenue: Math.round(n), currency: /€|eur/i.test(s) ? 'EUR' : /\$|usd/i.test(s) ? 'USD' : 'FCFA' };
    }
    if (ccy) {
      const all = s.match(/(\d[\d\s.,]+)/g);
      if (all) {
        const vals = all.map((x) => parseFloat(x.replace(/[\s.,]/g, '.'))).filter(isFinite);
        const big = Math.max.apply(null, vals);
        if (isFinite(big)) return { revenue: big, currency: /€|eur/i.test(s) ? 'EUR' : /\$|usd/i.test(s) ? 'USD' : 'FCFA' };
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ session
  function createSession(opts) {
    const o = opts || {};
    return {
      sessionId: o.sessionId || ('gc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      phase: 'greet', // greet -> clarify -> ready -> running
      ctx: {
        goalType: null,       // SALES | PROSPECTING | CONTENT | FOLLOWUP | ANALYSIS | ACCOUNTS | DEFAULT
        target: null,
        unit: null,
        revenue: null,
        currency: null,
        product: null,
        channels: [],         // canaux finalement retenus
        rawObjective: '',     // objectif d'origine (reformulé pour le parser)
        lockedClarify: false, // évite de re-poser la même question sans réponse
      },
      pending: null,          // { key:'target'|'channels', retries }
      thread: [],             // [{role, text, at}]
      doc: null,              // plan task-parser (quand ready)
      tasks: null,
      execution: null,        // { runId, executed, at }
      parsingFailed: false,
      lastQuestionAt: 0,
    };
  }

  // ------------------------------------------------------------------ engine
  function emptyParser() {
    return {
      detectGoals: function () { return []; },
      detectChannels: function () { return []; },
      parseObjective: function () { return { plan: [], goals: [], summary: '', channels: [] }; },
      planToTasks: function () { return []; },
      suggestReach: function () { return null; },
    };
  }

  // Fusionne les infos extraites d'un message utilisateur dans le contexte.
  function merge(state, info) {
    const c = state.ctx;
    if (info.goalType != null && !c.goalType) c.goalType = info.goalType;
    if (info.target != null && c.target == null) { c.target = info.target; c.unit = info.unit || c.unit; }
    if (info.revenue != null && c.revenue == null) { c.revenue = info.revenue; c.currency = info.currency || c.currency; }
    if (info.product) c.product = info.product;
    const addChans = pick(info.channels).filter((ch) => !c.channels.includes(ch));
    if (addChans.length) c.channels = c.channels.concat(addChans);
    if (c.rawObjective && info.text) c.rawObjective = c.rawObjective + ' — ' + info.text;
    else if (info.text) c.rawObjective = info.text;
  }

  // Extrait toutes les infos utiles d'un message.
  function extract(text, goalTypeFloor) {
    const t = String(text || '').trim();
    const n = nf(t);
    const goalState = {
      goalType: null,
      target: null, unit: null,
      revenue: null, currency: null,
      product: null,
      channels: [],
      smalltalk: false,
    };
    // canaux explicites
    if (/(telegram|tg\b)/.test(n)) goalState.channels.push('TELEGRAM');
    if (/(whatsapp|wa\b)/.test(n)) goalState.channels.push('WHATSAPP');
    if (/(tiktok|tik ?tok)/.test(n)) goalState.channels.push('TIKTOK');
    if (/(youtube|yt\b)/.test(n)) goalState.channels.push('YOUTUBE');
    if (/(tous les canaux|partout|multi ?canal|les deux|deux canaux)/.test(n) && !goalState.channels.length) {
      goalState.channels = ['WHATSAPP', 'TELEGRAM'];
    }

    // objectif explicite
    let type = null;
    if (/(vend|vente|ecouler|commercialiser|mois de ca|generer \d|encaisser|augmenter mes ventes|plus de ventes)/.test(n)) type = 'SALES';
    else if (/(prospect|groupes?|membres?|extract|scrapper|scrap|lead|nouveaux clients)/.test(n)) type = 'PROSPECTING';
    else if (/(publier|poster|creer du contenu|contenu|shorts|video|reels|tik ?tok|youtube)/.test(n)) type = 'CONTENT';
    else if (/(relanc|follow ?up|suivi|rappeler|rappel)/.test(n)) type = 'FOLLOWUP';
    else if (/(analys|rapport|bilan|stat\b|report|recap|resume\b)/.test(n)) type = 'ANALYSIS';
    else if (/(compte|inscription|cle[sx] d ?acces|acces pour|creation de compte)/.test(n) && /(client|eleve|etudiant|acheteur|beneficiaire)/.test(n)) type = 'ACCOUNTS';

    // les réponses courtes « oui / ok / vas-y / dm » à une question -> ne pas
    // convertir un objectif ; on laisse la fusion travailler.
    if (/^(oui|ok|vas-y|vas y|d'accord|allons-y|c'est parti|ca marche|d accord|ok[ !]*)$/i.test(t)) {
      goalState.smalltalk = true;
      return goalState;
    }
    if (type) {
      if (goalTypeFloor && goalTypeFloor === type) {
        // réponse de clarification CIBLE pour ce type (ex. « 50 produits »)
        const dt = detectTarget(t, type);
        if (dt.target != null) { goalState.target = dt.target; goalState.unit = dt.unit; }
        const mon = detectMoney(t);
        if (mon) { goalState.revenue = mon.revenue; goalState.currency = mon.currency; }
        goalState.channels = goalState.channels.length ? goalState.channels : null; // ne pas forcer
      }
      goalState.goalType = type;
      const dt2 = detectTarget(t, type);
      if (dt2.target != null && goalState.target == null) { goalState.target = dt2.target; goalState.unit = dt2.unit; }
      const mon2 = detectMoney(t);
      if (mon2 && goalState.revenue == null) { goalState.revenue = mon2.revenue; goalState.currency = mon2.currency; }
    } else {
      // message sans objectif explicite : cible nue ou nombre seul ?
      const dt3 = detectTarget(t, goalTypeFloor || 'SALES');
      if (dt3.target != null && (goalTypeFloor || /^\d/.test(t))) { goalState.target = dt3.target; goalState.unit = dt3.unit; }
      const mon3 = detectMoney(t);
      if (mon3) { goalState.revenue = mon3.revenue; goalState.currency = mon3.currency; }
    }
    if (!type && !goalState.channels.length && !/^(salut|bonjour|hello|bonsoir|hey|coucou|help|aide|comment ca marche|que fais-tu|qui es-tu)/i.test(n)) {
      goalState.goalType = 'DEFAULT';
    }
    return goalState;
  }

  function missingKey(state) {
    const need = REQUIRED[state.ctx.goalType] || REQUIRED.DEFAULT;
    if (need.includes('target') && state.ctx.target == null) return 'target';
    if (need.includes('channels') && !(state.ctx.channels && state.ctx.channels.length)) return 'channels';
    return null;
  }

  function questionFor(state, key) {
    const t = state.ctx.goalType;
    const u = (TARGET_UNITS[t] || ['unités'])[0];
    if (key === 'target') {
      if (t === 'SALES') return { text: `Combien d'unités veux-tu vendre (ex. « 50 ${u} » ou un montant « 100 000 FCFA ») ?`, quick: ['10', '50', '100'] };
      if (t === 'PROSPECTING') return { text: `Combien de ${u} veux-tu toucher aujourd'hui ?`, quick: ['20', '50', '100'] };
      if (t === 'CONTENT') return { text: `Combien de ${u} veux-tu produire/publier ?`, quick: ['1', '3', '5'] };
    }
    if (key === 'channels') return { text: 'Sur quels canaux ?', quick: ['WhatsApp', 'Telegram', 'Les deux'] };
    return null;
  }

  function push(state, role, text) {
    const msg = { role, text: String(text || ''), at: nowIso() };
    state.thread.push(msg);
    return msg;
  }

  function welcomeMessage() {
    return {
      text: '👋 Je suis le système intelligent de CYRUS. Dis-moi ton objectif en langage naturel — par exemple :',
      quick: ['Vendre 50 produits aujourd\'hui', 'Trouver 20 prospects', 'Publier 3 contenus', 'Faire un suivi automatique'],
      purpose: 'Accroche le dialogue réel : détection objective, questions ciblées, plan d actions concret.',
    };
  }

  // ------------------------------------------------------------------ step
  function step(state, opts) {
    const o = opts || {};
    const parser = o.parser && typeof o.parser.detectGoals === 'function' ? o.parser : emptyParser();
    const hc = o.humanContext || null;
    const nowOriginal = o.now != null ? o.now : Date.now();
    const message = String(o.message || '').trim();
    state.updatedAt = nowIso();

    if (!message) {
      push(state, 'assistant', 'Je n\'ai rien compris — précise ton objectif (ex. « Je veux vendre 20 packs cette semaine »).');
      return { kind: 'question', reply: threadTail(state) };
    }

    push(state, 'user', message);

    // 1) extraction + fusion
    const info = extract(message, state.ctx.goalType);
    merge(state, info);

    // 2) si aucun objectif jamais posé -> dialogue de cadrage / petit dialogue
    if (!state.ctx.goalType) {
      if (/(salut|bonjour|hello|bonsoir|hey|coucou)/i.test(nf(message)) || info.smalltalk) {
        const hcOut = (hc && typeof hc.analyzeMessage === 'function') ? safeAnalyze(hc, message) : null;
        const w = welcomeMessage();
        push(state, 'assistant', hcOut ? w.text + '\n\n(À propos de ton message : ' + hcOut.sentiment + ') — ' + w.quick[0] + ' ?' : w.text);
        state.phase = 'greet';
        return { kind: 'question', reply: threadTail(state), analysis: hcOut || null };
      }
      push(state, 'assistant', '🤖 Je n\'ai pas identifié d\'objectif. Reformule, ou utilise un exemple : « Je veux vendre 50 produits aujourd\'hui ».');
      state.phase = 'greet';
      return { kind: 'question', reply: threadTail(state) };
    }

    // 3) objectif identifié : pose les questions REQUISES manquantes (une à la fois)
    state.phase = 'clarify';
    const missing = missingKey(state);
    if (missing) {
      const q = questionFor(state, missing);
      if (q) {
        state.pending = { key: missing, retries: (state.pending && state.pending.key === missing ? state.pending.retries + 1 : 1) };
        if (state.pending.retries > 3) {
          // ne jamais boucler sur une question : on passe au plan avec les défauts
          state.pending = null;
        } else {
          push(state, 'assistant', '🟢 ' + q.text + '  ' + (q.quick ? ('Réponses rapides : ' + q.quick.join(' / ') + '.') : ''));
          return { kind: 'question', reply: threadTail(state), quick: q.quick || null, ctx: snapshotCtx(state) };
        }
      }
    }

    // 4) complet -> plan réel via task-parser + Human Context
    state.pending = null;
    const builtT = buildAt = nowOriginal;
    return finalizePlan(state, parser, hc, { now: builtT });
  }

  function finalizePlan(state, parser, hc, o) {
    // Reformule un objectif complet pour le parser (il attend des verbes).
    const c = state.ctx;
    const obj = buildObjectiveString(c);
    let doc = null;
    let parseError = null;
    try {
      doc = parser.parseObjective({
        text: obj,
        user: { engine: 'ZERO_VPS', tenantId: 'default' },
      });
    } catch (e) { parseError = String((e && e.message) || e); }
    if (!doc || !doc.plan || !doc.plan.length) {
      push(state, 'assistant', '⚠️ Je n\'ai pas pu transformer cet objectif en plan — donne-moi plus de précision (ex. « vendre 20 packs, 100 000 FCFA, WhatsApp »).');
      state.parsingFailed = !!parseError;
      return { kind: 'error', text: parseError || 'plan vide', reply: threadTail(state) };
    }
    const tasks = parser.planToTasks(doc, { engine: 'ZERO_VPS', tenantId: 'default', runId: 'gc-' + Date.now().toString(36) });
    state.doc = doc;
    state.tasks = tasks;
    state.ctx.channels = pick(doc.channels).length ? pick(doc.channels) : (c.channels.length ? c.channels : ['WHATSAPP']);
    state.phase = 'ready';

    // Analyse Human Context de l'objectif (réel, pas décoratif)
    let analysis = null;
    if (hc && typeof hc.analyzeMessage === 'function') analysis = safeAnalyze(hc, obj);
    const strategy = (hc && analysis && typeof hc.selectStrategy === 'function') ? safeStrategy(hc, analysis) : null;

    const steps = pick(doc.plan);
    const lines = steps.map((d, i) => {
      const delay = d.scheduledOffsetMs ? 'dans ' + delayLabel(d.scheduledOffsetMs) : 'immédiat';
      return (i + 1) + '. ' + (CHANNEL_ICON[d.channel] || '•') + ' ' + (ACTION_LABEL[d.action] || d.action) + ' — ' + d.channel + ' · ' + delay;
    });
    const impacted = pick(state.ctx.channels).map((ch) => (CHANNEL_ICON[ch] || '') + ' ' + ch).join(', ') || 'canaux détectés';
    const textLead = '🎯 Objectif analysé : **' + (GOAL_ICON[c.goalType] || '') + ' ' + (GOAL_LABEL[c.goalType] || c.goalType) + '**' +
      (c.target != null ? ' · cible ' + c.target + (c.unit ? ' ' + c.unit : '') : '') +
      (c.revenue != null ? ' · revenu visé ' + c.revenue + (c.currency || '') : '') +
      '\n📋 Plan généré (' + steps.length + ' étapes) :\n' + '• ' + lines.join('\n• ') +
      (strategy ? '\n🧭 Stratégie : ' + strategy.id + ' — ' + strategy.angle : '') +
      '\n\nPrêt à exécuter ? Choisis une action ci-dessous.';

    push(state, 'assistant', textLead);

    return {
      kind: 'plan',
      reply: threadTail(state),
      ctx: snapshotCtx(state),
      plan: steps.map((d) => ({ action: d.action, channel: d.channel, immediate: !!d.immediate, delayMs: d.scheduledOffsetMs || 0, label: ACTION_LABEL[d.action] || d.action })),
      tasks: tasks.length,
      analysis: analysis || null,
      strategy: strategy ? { id: strategy.id, angle: strategy.angle, followUpDelayMs: strategy.followUpDelayMs } : null,
      actions: [
        { id: 'run-plan', label: '🚀 Oui, lancer maintenant', kind: 'primary' },
        { id: 'navigate-campaigns', label: '📢 Ouvrir les campagnes', kind: 'secondary' },
        { id: 'restart', label: '🔄 Nouvel objectif', kind: 'ghost' },
      ],
      execution: state.execution || null,
    };
  }

  function buildObjectiveString(c) {
    let s = c.rawObjective || '';
    const parts = [];
    if (!parts.length && c.goalType === 'SALES') {
      let v = 'vendre';
      if (c.target != null) v += ' ' + c.target + (c.unit ? ' ' + c.unit : (c.goalType === 'SALES' ? ' produits' : ''));
      if (c.revenue != null) v += ' et générer ' + c.revenue + ' ' + (c.currency || 'FCFA');
      parts.push(v);
    } else if (!parts.length && c.goalType === 'PROSPECTING') {
      let v = 'prospecter';
      if (c.target != null) v += ' ' + c.target + (c.unit ? ' ' + c.unit : ' contacts');
      parts.push(v);
    } else if (!parts.length && c.goalType === 'CONTENT') {
      let v = 'publier';
      if (c.target != null) v += ' ' + c.target + (c.unit ? ' ' + c.unit : ' contenus');
      parts.push(v);
    } else if (!parts.length && c.goalType === 'FOLLOWUP') parts.push('relancer les prospects et faire un suivi');
    else if (!parts.length && c.goalType === 'ANALYSIS') parts.push('analyser les réponses et générer un rapport');
    else if (!parts.length && c.goalType === 'ACCOUNTS') parts.push('créer les comptes et générer les clés d accès des clients');

    const texts = [];
    map(String(s || '').split('—').map(function (chunk) { return chunk.trim(); }).filter(Boolean), function (ch) { texts.push(ch); });
    map(parts, function (p) { if (!texts.some(function (t) { return t === p; })) texts.push(p); });
    const chan = pick(c.channels || []).filter(function (x) { return x !== 'TIKTOK' && x !== 'YOUTUBE'; }).join(' et ');
    if (chan) texts.push('via ' + chan);
    return texts.join(' — ');
  }

  function map(arr, fn) { for (let i = 0; i < arr.length; i += 1) fn(arr[i], i); }

  function safeAnalyze(hc, text) {
    try { return hc.analyzeMessage(text) || null; } catch (e) { return null; }
  }
  function safeStrategy(hc, analysis) {
    try { return hc.selectStrategy(analysis) || null; } catch (e) { return null; }
  }
  function snapshotCtx(state) {
    const c = state.ctx;
    return { goalType: c.goalType, target: c.target, unit: c.unit, revenue: c.revenue, currency: c.currency, product: c.product, channels: pick(c.channels) };
  }
  function threadTail(state) {
    return state.thread[state.thread.length - 1];
  }

  function delayLabel(d) {
    if (!d) return 'immédiat';
    const m = Math.round(d / 60000);
    if (m < 1) return '~1 min';
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' h';
    return Math.floor(h / 24) + ' j';
  }

  // ------------------------------------------------------------------ run
  // Exécute les tâches immédiates du plan via le runner injecté (VPS réel,
  // local navigation). Mutate state.execution. Retourne le résultat.
  async function runPlan(state, o) {
    const oo = o || {};
    const exec = oo.execute || null;
    if (!exec) return { ok: false, error: 'AUCUN_EXECUTEUR' };
    if (!state.tasks || !state.tasks.length) return { ok: false, error: 'PLAN_VIDE' };
    state.phase = 'running';
    try {
      const out = await exec(state.tasks, state);
      state.execution = { runId: (out && out.runId) || null, executed: (out && out.executed) || 0, results: (out && out.results) || [], error: (out && out.error) || null, at: nowIso() };
      return { ok: !(out && out.error), execution: state.execution };
    } catch (e) {
      state.execution = { error: String((e && e.message) || e), at: nowIso() };
      return { ok: false, execution: state.execution };
    }
  }

  function serialize(state, o) {
    const opt = o || {};
    const c = state.ctx;
    return {
      ok: true,
      mode: opt.mode || 'auto',
      sessionId: state.sessionId,
      phase: state.phase,
      ctx: snapshotCtx(state),
      doc: state.doc ? { summary: state.doc.summary, channels: pick(state.doc.channels), estimatedReach: state.doc.estimatedReach || 0 } : null,
      tasks: state.tasks ? state.tasks.length : 0,
      execution: state.execution || null,
      thread: state.thread,
      mode: opt.mode || null,
    };
  }

  return {
    createSession: createSession,
    stepInsert: step,
    step: step,
    runPlan: runPlan,
    serialize: serialize,
    extract: extract,
    detectTarget: detectTarget,
    detectMoney: detectMoney,
    buildObjectiveString: buildObjectiveString,
    WELCOME: welcomeMessage(),
  };
});