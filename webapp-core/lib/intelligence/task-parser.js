// TASK PARSER — Chat-to-Action (dual-env : Node + navigateur)
// -------------------------------------------------------------------------------
// Transforme un objectif exprimé en langage naturel en un plan de tâches
// multi-canaux exécutable par l'Automation Engine.
//
//   "Aujourd'hui, je veux vendre 10 packs de formation et générer 100 000 FCFA"
//     -> goal SALES (target 10, revenue 100000 FCFA) -> plan de 6+ tâches.
//
// Les tâches produites respectent la structure de automation-engine.js
// (engine, channel, type, status, priority, scheduledAt, payload, attempts,
// nextRun) ; l'exécution elle-même est déléguée à action-executor.js.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TaskParser = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ACTIONS = [
    'EXTRACT_MEMBERS', 'SEND_CAMPAIGN', 'FOLLOW_UP', 'ANALYZE_HUMAN_CONTEXT',
    'ANALYZE_RESPONSES', 'REPLY_COMMENT', 'GENERATE_VIDEO', 'PAUSE_CAMPAIGN',
    'RESUME_CAMPAIGN', 'GENERATE_REPORT', 'CREATE_USER_ACCOUNT', 'GENERATE_ACCESS_KEY',
  ];

  const DEFAULT_CHANNELS = ['WHATSAPP', 'TELEGRAM'];

  // ---------------------------------------------------------------------------
  // Extraction rigoureuse des nombres français ("10 packs", "100 000 FCFA")
  // ---------------------------------------------------------------------------
  const NUMBER_RE = /(\d[\d\s. ]*(?:,\d+)?)/g;

  function extractAmounts(text) {
    const out = [];
    let m;
    while ((m = NUMBER_RE.exec(text))) {
      if (m[0] === ' ') continue;
      const cleaned = m[0].replace(/[\s ]/g, '').replace(',', '.');
      out.push(parseFloat(cleaned));
    }
    return out;
  }

  const CURRENCY_RE = /(?:f\s*[csa]\s*f|fcf[aà]|xof|francs?|€|euros?|usd|\$|dollars?)/i;

  function detectCurrency(text) {
    if (/fcf[aà]|xof|f\s*c\s*f/i.test(text)) return 'FCFA';
    if (/€|euros?/i.test(text)) return 'EUR';
    if (/\$|usd|dollars?/i.test(text)) return 'USD';
    return null;
  }

  // ---------------------------------------------------------------------------
  // Objectifs (type + paramètres)
  // ---------------------------------------------------------------------------
  function detectGoals(text, amounts) {
    const n = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const goals = [];
    const adds = {};

    // VENTES : "vendre 10 packs / générer 100000 FCFA"
    if (/(vend|vente|ecouler|commercialiser|mois de ca|generer \d|faire \d|recuperer \d|encaisser)/.test(n)) {
      const goal = { type: 'SALES', target: null, unit: null, product: null, revenue: null, currency: null };
      const mTarget = n.match(/(\d(?:[.,]?\d)*)\s+(packs?|produits?|formations?|clients?|ventes?|inscriptions?|abonnements?)/);
      if (mTarget) {
        goal.target = parseInt(mTarget[1].replace(/[\s.]/g, ''), 10);
        goal.unit = mTarget[2].replace(/s$/, '');
        goal.product = /formation|pack|produit|abonnement/.test(mTarget[2]) ? mTarget[2] : goal.product;
      }
      // Revenue: le montant "le plus grand" accompagné de devise.
      const ccy = detectCurrency(text);
      let candidate = null;
      for (const a of amounts) if (a >= 1000) candidate = a;
      // "100000 FCFA" -> le nombre juste avant la devise
      const ccyIdx = text.search(CURRENCY_RE);
      if (ccyIdx !== -1) {
        const before = text.slice(Math.max(0, ccyIdx - 32), ccyIdx);
        const lastNum = before.match(/[\d\s. ]*(?:\d)(?=[\s ]*$)/);
        // fallback : montant détecté
      }
      if (candidate != null && ccy) { goal.revenue = candidate; goal.currency = ccy; }
      goals.push(goal);
    }

    // PROSPECTION : "prospecter N contacts / groupes"
    if (/(prospect|groupe|groupes|membres|extract|scrapper|scrap)/.test(n)) {
      const goal = { type: 'PROSPECTING', target: null, unit: null, source: null };
      const mGroups = n.match(/(\d(?:[.,]?\d)*)\s+(groupes?|cantons|canals?)/);
      if (mGroups) { goal.target = parseInt(mGroups[1].replace(/[\s.]/g, ''), 10); goal.unit = mGroups[2]; }
      else if (/(groupe|canal)/.test(n)) goal.target = null; // tous les groupes trouvés
      goals.push(goal);
    }

    // CONTENU / PUBLICATION
    if (/(publier|poster|creer du contenu|contenu|shorts|video|reels|tik ?tok|youtube)/.test(n)) {
      const goal = { type: 'CONTENT', target: null, unit: null, topic: null };
      const mN = n.match(/(\d(?:[.,]?\d)*)\s+(videos?|shorts?|posts?|reels?)/);
      if (mN) { goal.target = parseInt(mN[1].replace(/[\s.]/g, ''), 10); goal.unit = mN[2]; }
      goals.push(goal);
    }

    // SUIVI / relance
    if (/(relanc|follow ?up|suivi|rappeler|rappel)/.test(n)) {
      const goal = { type: 'FOLLOWUP', target: null, unit: null };
      goals.push(goal);
    }

    // ANALYSE / rapport à date
    if (/(analys|rapport|bilan|stat|report|recap|resume\b)/.test(n)) {
      const goal = { type: 'ANALYSIS', target: null };
      goals.push(goal);
    }

    // Comptes & accès (parcours client post-achat)
    if (/(compte|creation de compte|inscription|clé|cles d'acces|acces)/.test(n) && /(client|eleve|etudiant|acheteur|beneficiaire)/.test(n)) {
      const goal = { type: 'ACCOUNTS', target: null };
      goals.push(goal);
    }

    if (!goals.length) goals.push({ type: 'DEFAULT', target: null });
    return goals;
  }

  function detectChannels(text) {
    const n = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const channels = [];
    if (/(telegram|tg\b)/.test(n)) channels.push('TELEGRAM');
    if (/(whatsapp|wa\b)/.test(n)) channels.push('WHATSAPP');
    if (/(tiktok|tik ??tok)/.test(n)) channels.push('TIKTOK');
    if (/(youtube|yt\b)/.test(n)) channels.push('YOUTUBE');
    if (/(tous les canaux|partout|multi ?canal|tout)/.test(n)) return DEFAULT_CHANNELS.slice();
    return channels.length ? channels : DEFAULT_CHANNELS.slice();
  }

  // ---------------------------------------------------------------------------
  // Plan de tâches construit à partir des objectifs
  // ---------------------------------------------------------------------------
  // Un descripteur = { action, channel, engine, priority, scheduledOffsetMs,
  //   immediate, payload, meta } transformé en tâche par planToTasks().
  function buildPlan(textOrOpts, opts) {
    const text = typeof textOrOpts === 'string' ? textOrOpts : (textOrOpts && textOrOpts.text) || '';
    const base = { engine: 'ZERO_VPS', tenantId: 'default' };
    const user = Object.assign(
      {},
      base,
      (typeof textOrOpts === 'object' && textOrOpts.user && typeof textOrOpts.user === 'object') ? textOrOpts.user : {},
      opts || {},
      (typeof textOrOpts === 'object' && !textOrOpts.user) ? textOrOpts : {},
    );
    const amounts = extractAmounts(text);
    const goals = detectGoals(text, amounts);
    const channels = user.channels && user.channels.length ? user.channels : detectChannels(text);
    const plan = [];

    for (const goal of goals) {
      switch (goal.type) {
        case 'SALES': {
          const reach = suggestReach(goal);
          plan.push(desc('EXTRACT_MEMBERS', channels[0], { source: goal.source || null, suggestedReach: reach, tenantId: user.tenantId, engine: user.engine }, user, { priority: 10, immediate: true }));
          plan.push(desc('SEND_CAMPAIGN', channels[0], { text: null, recipientsSource: 'extract', goalSales: goal, tenantId: user.tenantId, engine: user.engine }, user, { priority: 20, scheduledOffsetMs: 2 * 60 * 1000 }));
          plan.push(desc('FOLLOW_UP', channels[0], { stage: 'nurture', target: goal, tenantId: user.tenantId, engine: user.engine }, user, { priority: 30, scheduledOffsetMs: 4 * 60 * 60 * 1000 }));
          plan.push(desc('ANALYZE_RESPONSES', channels[0], { windowMs: 6 * 60 * 60 * 1000, tenantId: user.tenantId, engine: user.engine }, user, { priority: 40, scheduledOffsetMs: 6 * 60 * 60 * 1000 }));
          plan.push(desc('ANALYZE_HUMAN_CONTEXT', channels[0], { repliesFilter: 'new', tenantId: user.tenantId, engine: user.engine }, user, { priority: 50, scheduledOffsetMs: 6 * 60 * 60 * 1000 + 5 * 60 * 1000 }));
          // Canal secondaire si bonus pot
          if (channels.length > 1) {
            plan.push(desc('SEND_CAMPAIGN', channels[1], { text: null, recipientsSource: 'extract', goalSales: goal, tenantId: user.tenantId, engine: user.engine }, user, { priority: 22, scheduledOffsetMs: 15 * 60 * 1000 }));
            plan.push(desc('REPLY_COMMENT', channels[1], { goal: 'SALES', tenantId: user.tenantId, engine: user.engine }, user, { priority: 35, scheduledOffsetMs: 3 * 60 * 60 * 1000 }));
          }
          plan.push(desc('GENERATE_REPORT', channels[0], { scope: 'day', goal, tenantId: user.tenantId, engine: user.engine }, user, { priority: 90, scheduledOffsetMs: 22 * 60 * 60 * 1000 }));
          break;
        }
        case 'PROSPECTING': {
          plan.push(desc('EXTRACT_MEMBERS', channels[0], { source: goal.source || 'groups', target: goal.target, tenantId: user.tenantId, engine: user.engine }, user, { priority: 10, immediate: true }));
          if (goal.target) {
            plan.push(desc('SEND_CAMPAIGN', channels[0], { recipientsSource: 'extract', tenantId: user.tenantId, engine: user.engine }, user, { priority: 20, scheduledOffsetMs: 3 * 60 * 1000 }));
          }
          break;
        }
        case 'CONTENT': {
          plan.push(desc('GENERATE_VIDEO', channels[0], { topic: goal.topic || null, count: goal.target || 1, tenantId: user.tenantId, engine: user.engine }, user, { priority: 30, immediate: true }));
          if (channels.includes('TIKTOK') || channels.includes('YOUTUBE')) {
            plan.push(desc('SEND_CAMPAIGN', channels[0], { contentType: 'video', tenantId: user.tenantId, engine: user.engine }, user, { priority: 40, scheduledOffsetMs: 20 * 60 * 1000 }));
          }
          break;
        }
        case 'FOLLOWUP': {
          plan.push(desc('FOLLOW_UP', channels[0], { stage: 'cold_list', tenantId: user.tenantId, engine: user.engine }, user, { priority: 30, scheduledOffsetMs: 1 * 60 * 60 * 1000 }));
          plan.push(desc('ANALYZE_HUMAN_CONTEXT', channels[0], { tenantId: user.tenantId, engine: user.engine }, user, { priority: 40, scheduledOffsetMs: 2 * 60 * 60 * 1000 }));
          break;
        }
        case 'ANALYSIS': {
          plan.push(desc('ANALYZE_RESPONSES', channels[0], { windowMs: 24 * 60 * 60 * 1000, tenantId: user.tenantId, engine: user.engine }, user, { priority: 40, scheduledOffsetMs: 10 * 60 * 60 * 1000 }));
          plan.push(desc('GENERATE_REPORT', channels[0], { scope: 'day', tenantId: user.tenantId, engine: user.engine }, user, { priority: 90, scheduledOffsetMs: 21 * 60 * 60 * 1000 }));
          break;
        }
        case 'ACCOUNTS': {
          plan.push(desc('CREATE_USER_ACCOUNT', channels[0], { tenantId: user.tenantId, engine: user.engine }, user, { priority: 60, immediate: true }));
          plan.push(desc('GENERATE_ACCESS_KEY', channels[0], { tenantId: user.tenantId, engine: user.engine }, user, { priority: 61, scheduledOffsetMs: 2 * 60 * 1000 }));
          break;
        }
        default: {
          plan.push(desc('ANALYZE_HUMAN_CONTEXT', channels[0], { tenantId: user.tenantId, engine: user.engine }, user, { priority: 50, immediate: true }));
          plan.push(desc('GENERATE_REPORT', channels[0], { scope: 'misc', tenantId: user.tenantId, engine: user.engine }, user, { priority: 90, scheduledOffsetMs: 12 * 60 * 60 * 1000 }));
        }
      }
    }

    const sum = plan.reduce((s, d) => s + (d.scheduledOffsetMs || 0), 0);
    return {
      success: true,
      objective: text,
      summary: summarize(text, goals),
      goals,
      channels,
      plan,
      estimatedReach: goals.reduce((a, g) => a + (suggestReach(g) || 0), 0),
      scheduling: { immediate: plan.filter((d) => d.immediate), delayed: plan.filter((d) => !d.immediate), horizonMs: sum },
    };
  }

  function desc(action, channel, payload, user, overrides) {
    return {
      action,
      channel,
      engine: overrides.engine || user.engine,
      priority: overrides.priority || 5,
      immediate: !!overrides.immediate,
      scheduledOffsetMs: overrides.scheduledOffsetMs || null,
      payload,
    };
  }

  function suggestReach(goal) {
    // Règle métier : ~8% de conversion sur un canal non chauffé ; on vise
    // target / 0.08 prospects pour atteindre les ventes.
    if (!goal || goal.target == null) return null;
    return Math.round(goal.target / 0.08);
  }

  function summarize(text, goals) {
    const labels = { SALES: 'ventes', PROSPECTING: 'prospection', CONTENT: 'contenu', FOLLOWUP: 'suivi/relance', ANALYSIS: 'analyse/rapport', ACCOUNTS: 'comptes & accès', DEFAULT: 'analyse' };
    return goals.map((g) => {
      const s = [];
      if (g.target != null) s.push(g.target + (g.unit ? ' ' + g.unit : ''));
      if (g.revenue) s.push(g.revenue + (g.currency || ''));
      return 'objectif : ' + labels[g.type] + (s.length ? ' (' + s.join(', ') + ')' : '');
    }).join(' / ');
  }

  // Conversion plan -> tâches Automation Engine (structure exacte spec).
  function planToTasks(doc, base, opts) {
    const b = Object.assign({ tenantId: 'default', engine: 'ZERO_VPS', nowMs: Date.now() }, base, opts || {});
    const channels = Array.isArray(doc.channels) && doc.channels.length ? doc.channels : ['WHATSAPP'];
    return doc.plan.map((d, i) => ({
      id: 't_' + (b.runId ? b.runId + '_' : '') + (i + 1),
      runId: b.runId || null,
      tenantId: d.payload && d.payload.tenantId || b.tenantId,
      engine: d.engine,
      channel: d.channel,
      type: d.action,
      status: 'queued',
      priority: d.priority,
      required: d.immediate,
      scheduledAt: d.immediate ? b.nowMs : b.nowMs + (d.scheduledOffsetMs || 0),
      payload: d.payload || {},
      attempts: 0,
      maxRetries: 2,
      nextRun: d.immediate ? b.nowMs : b.nowMs + (d.scheduledOffsetMs || 0),
      createdAt: new Date(b.nowMs).toISOString(),
    }));
  }

  return { parseObjective: buildPlan, planToTasks, detectGoals, detectChannels, extractAmounts, detectCurrency, ACTIONS, DEFAULT_CHANNELS, suggestReach };
});