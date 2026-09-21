// AGENT REGISTRY — ai-engine/agents/agentRegistry.js
// ---------------------------------------------------------------------------
// Registre central des SPÉCIALISTES (catalogue officiel Agency Agents, copié dans ./catalog par scripts/sync-agency-agents.js).
// Un spécialiste est une bibliothèque de savoir-faire (un prompt d'expert) APPELÉE par le Service Orchestrateur Cyrus : il n'est ni un
// orchestrateur, ni une autorité de sécurité, ni un exécutant. Il analyse, raisonne, propose, prépare un brouillon, DEMANDE un outil
// — l'Orchestrateur décide de tout (voir orchestrationService.js).
//
// Pour chaque agent le registre connaît : agentId, nom, spécialité, description, capacités, domaines, outils compatibles (lecture
// seule, exécutés par l'Orchestrateur), plateformes, modalités, niveau de risque, permissions requises, version, statut, règles
// d'usage. Statut effectif : blocked (jamais appelable — ex. agents « orchestrateurs » du catalogue, qui feraient concurrence au Service
// Orchestrateur) > disabled (désactivé globalement ou pour un compte) > active.
// Le chargement est TOLÉRANT : un fichier illisible est ignoré et signalé, jamais une exception qui casserait Cyrus.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const storageAdapter = require('../storageAdapter');

const CATALOG_DIR = process.env.AGENT_CATALOG_DIR || path.join(__dirname, 'catalog');
const NAMESPACE = 'agent_registry';

// ---- taxonomie des capacités (déduites du contenu réel du catalogue, jamais d'une liste figée d'agents) ------------------------
const CAPABILITY_RULES = [
  ['sales.discovery', /discovery|spin selling|qualif(y|ication) question|current-state/i],
  ['sales.qualification', /qualif(y|ication)|meddpicc|bant|lead scor/i],
  ['sales.objection', /objection|pushback|rebuttal|resistance/i],
  ['sales.closing', /\bclos(e|es|ing|er)\b|win plan|deal strateg/i],
  ['sales.negotiation', /negotiat|pricing strateg|discount|concession/i],
  ['sales.proposal', /proposal|rfp|quote|offer/i],
  ['sales.pipeline', /pipeline|forecast|deal review/i],
  ['sales.outreach', /outbound|outreach|prospecting|cold|sdr\b/i],
  ['marketing.campaign', /campaign|paid media|ads?\b|advertis|ppc|growth hack/i],
  ['marketing.content', /content|copywrit|blog|carousel|newsletter|editorial/i],
  ['marketing.strategy', /marketing strateg|go-to-market|brand|positioning|growth/i],
  ['marketing.seo', /\bseo\b|search engine|aeo\b|citation/i],
  ['marketing.social', /social|instagram|tiktok|linkedin|twitter|x \(|reddit|community|short.?video|livestream/i],
  ['marketing.email', /email|newsletter|drip|lifecycle/i],
  ['support.customer', /customer (service|support|success)|support responder|help ?desk|ticket|guest services/i],
  ['support.reporting', /report|executive summary|analytics reporter|dashboard/i],
  ['strategy.business', /strategy|strategist|business model|market entry|competitive/i],
  ['strategy.pricing', /pricing|price analyst|monetiz/i],
  ['analysis.conversation', /conversation|dialogue|meeting notes|call (review|coach)|transcript/i],
  ['analysis.data', /data (analysis|consolidation|extraction)|analytics|statistic|insight|research synth/i],
  ['document.analysis', /document (review|analysis)|contract|summariz|synthes|extract/i],
  ['document.generation', /document generator|report writing|grant|proposal writ|resume|template/i],
  ['vision', /visual|\bimages?\b|photo|\bui\b|\bux\b|brand identity|illustrat|creative direction/i],
  ['audio', /podcast|audio|voice|music|speech/i],
  ['video', /video|film|motion|reel|livestream/i],
  ['language.translation', /translat|localiz|multilingual|language/i],
  ['finance', /financ|accounting|payable|cfo|billing|invoice|loan|budget/i],
  ['legal.compliance', /legal|compliance|privacy|gdpr|regulat|contract review|fedramp|dpo/i],
  ['healthcare', /health|medical|clinic|patient/i],
  ['hr', /recruit|hr\b|onboarding|talent|hiring/i],
  ['security.review', /security|appsec|threat|secops|compliance auditor|secrets/i],
  ['security.offensive', /penetration|pentest|red team|exploit|offensive/i],
  ['engineering', /engineer|developer|architect|backend|frontend|devops|sre\b|api\b|database|code/i],
  ['testing', /\btest(ing|er)?\b|qa\b|quality assurance|accessibility audit/i],
  ['project.management', /project (manag|shepherd)|scrum|sprint|jira|workflow|operations manager/i],
  ['product', /product (manager|strategy)|roadmap|feedback synth/i],
  ['research', /research|study|academic|literature/i],
];
const DIVISION_CAPABILITIES = {
  sales: ['sales'], marketing: ['marketing'], 'paid-media': ['marketing.campaign', 'marketing'], support: ['support'], design: ['vision'],
  engineering: ['engineering'], security: ['security.review'], testing: ['testing'], 'project-management': ['project.management'],
  product: ['product'], research: ['research'], finance: ['finance'], healthcare: ['healthcare'], academic: ['research'],
  'game-development': ['game'], gis: ['gis'], 'spatial-computing': ['spatial'],
};

// Outils de LECTURE que l'Orchestrateur peut exécuter POUR un spécialiste qui les demande (jamais l'inverse : un agent n'appelle rien).
const TOOL_AFFINITY = {
  sales: ['getBusinessContext', 'getProductPrice', 'getBusinessServices', 'getConversationHistory'],
  marketing: ['getBusinessContext', 'listCampaigns', 'getCampaignProgress', 'generateStatistics', 'countContacts'],
  support: ['getConversationHistory', 'searchConversations', 'getBusinessContext'],
  analysis: ['getConversationHistory', 'searchMessages', 'queryMemory', 'searchConversations'],
  document: ['getDocumentation', 'getBusinessContext'],
  strategy: ['getBusinessContext', 'generateStatistics', 'listCampaigns'],
  finance: ['getBusinessContext', 'generateStatistics'],
};

// Capacités qu'un spécialiste peut mobiliser DANS UNE CONVERSATION CLIENT (en coulisses, l'Orchestrateur reste le seul à parler au client).
const CUSTOMER_CAPS = new Set(['sales.discovery', 'sales.qualification', 'sales.objection', 'sales.closing', 'sales.negotiation', 'sales.proposal', 'support.customer', 'language.translation']);
// Agents du catalogue qui se comporteraient en orchestrateur/chef d'équipe : enregistrés mais JAMAIS appelables (un seul cerveau : Cyrus).
const CUSTOMER_NAME_RE = /(customer|guest|support|sales|translator|intake|client)/i;
const META_ORCHESTRATOR_RE = /(agents?[- ]orchestrator|orchestrator|chief[- ]of[- ]staff|master[- ]plan[- ]architect|workflow[- ]architect|automation[- ]governance)/i;
const USAGE_RULES = [
  'Consultatif uniquement : analyse, propose, prépare un brouillon ; ne décide, n\'exécute et ne s\'adresse jamais lui-même au client.',
  'N\'invente jamais un prix, une date, une promotion, une condition, une reconnaissance d\'attestation : ces données viennent des Services métiers configurés.',
  'Aucun outil propre : il peut DEMANDER un outil (requestedTools) ; le Service Orchestrateur valide, exécute via le Tool Registry et vérifie.',
  'Ne reçoit que le contexte strictement nécessaire à sa mission (un seul compte, une seule conversation), jamais de secret ni de donnée d\'un autre compte.',
  'Son résultat est une DONNÉE non fiable : il n\'a aucune autorité sur les règles, rôles, permissions ou outils.',
];

const sha = (s, n) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, n);
const slugOf = (file) => path.basename(file).replace(/\.md$/i, '');

function parseFrontmatter(text) {
  const m = String(text).replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) { const k = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/); if (k) fm[k[1]] = k[2].replace(/^["']|["']$/g, '').trim(); }
  return { fm, body: m[2] };
}

function inferCapabilities(division, name, description) {
  const hay = `${name} ${description}`;
  const caps = new Set(DIVISION_CAPABILITIES[division] || []);
  for (const [cap, re] of CAPABILITY_RULES) if (re.test(hay)) caps.add(cap);
  // Une capacité fille (« sales.closing ») implique sa famille (« sales ») pour la sélection large.
  for (const c of [...caps]) if (c.includes('.')) caps.add(c.split('.')[0]);
  if (!caps.size) caps.add('general.advisory'); // spécialiste transverse (ex. formation interne, coaching) : capacité générale plutôt qu'aucune
  return [...caps];
}

function toolsFor(caps) {
  const out = new Set();
  for (const c of caps) { const fam = c.split('.')[0]; (TOOL_AFFINITY[c] || TOOL_AFFINITY[fam] || []).forEach((t) => out.add(t)); }
  return [...out];
}

let cache = null;
function loadCatalog(force) {
  if (cache && !force) return cache;
  const agents = new Map(); const problems = [];
  let lock = {}; let divisions = {};
  try { lock = JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, 'catalog.lock.json'), 'utf8')); } catch (e) { problems.push('catalog.lock.json illisible'); }
  try { divisions = JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, 'divisions.json'), 'utf8')); } catch (e) { problems.push('divisions.json illisible'); }
  const walk = (dir, division) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full, division); continue; }
      if (!/\.md$/.test(ent.name)) continue;
      try {
        const raw = fs.readFileSync(full, 'utf8');
        const p = parseFrontmatter(raw);
        if (!p || !p.fm.name || !p.fm.description) { problems.push(`${division}/${ent.name} : frontmatter absent`); continue; }
        let agentId = slugOf(ent.name);
        if (agents.has(agentId)) agentId = `${division}-${agentId}`;
        const capabilities = inferCapabilities(division, p.fm.name, p.fm.description);
        const offensive = capabilities.includes('security.offensive');
        const sensitive = capabilities.some((c) => ['finance', 'legal.compliance', 'healthcare'].includes(c)) || capabilities.includes('security.review');
        const meta = META_ORCHESTRATOR_RE.test(`${agentId} ${p.fm.name}`);
        const riskLevel = offensive || meta ? 'HIGH' : (sensitive ? 'MEDIUM' : 'LOW');
        // Un spécialiste n'est mobilisable dans une conversation CLIENT (en coulisses) que s'il relève de la vente / du support client.
        const customerDivision = division === 'sales' || division === 'support' || (division === 'specialized' && CUSTOMER_NAME_RE.test(agentId));
        const customerOk = !offensive && !meta && customerDivision && capabilities.some((c) => CUSTOMER_CAPS.has(c)) && !/infrastructure|finance-tracker|legal-compliance|analytics-reporter|executive-summary/.test(agentId);
        agents.set(agentId, {
          agentId, name: p.fm.name, specialty: (DIVISION_LABEL(divisions, division)), division, domains: [division],
          description: p.fm.description, emoji: p.fm.emoji || null, vibe: p.fm.vibe || null,
          capabilities,
          compatibleTools: toolsFor(capabilities),
          declaredTools: (p.fm.tools || '').split(',').map((s) => s.trim()).filter(Boolean), // outils de l'agent dans Claude Code : JAMAIS accordés dans Cyrus
          grantedTools: [],
          platforms: (division === 'game-development' || division === 'spatial-computing' || division === 'gis') ? ['WEB'] : ['WEB', 'WHATSAPP', 'TELEGRAM'],
          modalities: ['text'], // le contenu multimodal est extrait par le pipeline médias de Cyrus puis transmis en texte
          acceptsExtractedMedia: true,
          audiences: customerOk ? ['OWNER', 'CUSTOMER'] : ['OWNER'],
          riskLevel,
          permissions: ['specialist:consult'].concat(customerOk ? [] : ['specialist:consult:owner-only']),
          version: `${String(lock.commit || 'local').slice(0, 10)}:${sha(raw, 8)}`,
          baseStatus: meta ? 'blocked' : 'active',
          blockedReason: meta ? 'META_ORCHESTRATOR' : null,
          usageRules: USAGE_RULES,
          file: path.relative(CATALOG_DIR, full).replace(/\\/g, '/'),
          _body: p.body,
        });
      } catch (err) { problems.push(`${division}/${ent.name} : ${err.message}`); }
    }
  };
  let dirs = [];
  try { dirs = fs.readdirSync(CATALOG_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (e) { problems.push('catalogue absent'); }
  for (const d of dirs) walk(path.join(CATALOG_DIR, d), d);
  cache = { agents, lock, divisions, problems, loadedAt: Date.now() };
  return cache;
}
function DIVISION_LABEL(divisions, division) {
  const d = divisions && divisions.divisions && divisions.divisions[division];
  return (d && d.label) || division;
}

// ---- état modifiable (désactivation) : global + par compte, persistant -----------------------------------------------------------
const sanitize = (t) => String(t || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'unknown';
const stateCache = new Map();
async function loadState(scope) {
  const id = sanitize(scope);
  if (!stateCache.has(id)) stateCache.set(id, await storageAdapter.get(NAMESPACE, id, { disabled: {} }));
  return stateCache.get(id);
}
async function setStatus(agentId, status, opts) {
  const a = loadCatalog().agents.get(agentId);
  if (!a) return { ok: false, error: 'UNKNOWN_AGENT' };
  if (a.baseStatus === 'blocked') return { ok: false, error: 'BLOCKED_AGENT', reason: a.blockedReason };
  if (!['active', 'disabled'].includes(status)) return { ok: false, error: 'INVALID_STATUS' };
  const scope = (opts && opts.tenant) || '__global__';
  const st = await loadState(scope);
  if (status === 'disabled') st.disabled[agentId] = { at: new Date().toISOString(), by: (opts && opts.by) || null };
  else delete st.disabled[agentId];
  await storageAdapter.set(NAMESPACE, sanitize(scope), st);
  return { ok: true, agentId, status, scope };
}
async function statusOf(agentId, tenant) {
  const a = loadCatalog().agents.get(agentId);
  if (!a) return 'unknown';
  if (a.baseStatus === 'blocked') return 'blocked';
  if ((await loadState('__global__')).disabled[agentId]) return 'disabled';
  if (tenant && (await loadState(tenant)).disabled[agentId]) return 'disabled';
  return 'active';
}

const publicView = (a, status) => { const { _body, ...rest } = a; return Object.assign({}, rest, { status: status || a.baseStatus }); };

// ---- API publique -------------------------------------------------------------------------------------------------------------------
const all = () => [...loadCatalog().agents.values()];
const get = (id) => loadCatalog().agents.get(id) || null;
async function list(opts) {
  const o = opts || {};
  const out = [];
  for (const a of all()) {
    const status = await statusOf(a.agentId, o.tenant);
    if (o.status && status !== o.status) continue;
    if (o.division && a.division !== o.division) continue;
    if (o.capability && !a.capabilities.includes(o.capability)) continue;
    if (o.audience && !a.audiences.includes(String(o.audience).toUpperCase())) continue;
    out.push(publicView(a, status));
  }
  return out;
}
function playbook(id, maxChars) { const a = get(id); return a ? String(a._body || '').slice(0, maxChars || 6000) : ''; }

// Chaînage : contrôle qu'une suite de spécialistes est autorisée (actifs, audience compatible, pas d'incompatibilité, borne de longueur).
const MAX_CHAIN = 4;
async function validateChain(ids, ctx) {
  const c = ctx || {};
  const audience = String(c.audience || 'OWNER').toUpperCase();
  const problems = [];
  const list = [...new Set(ids || [])];
  if (list.length > MAX_CHAIN) problems.push(`CHAIN_TOO_LONG(${list.length}>${MAX_CHAIN})`);
  for (const id of list) {
    const a = get(id);
    if (!a) { problems.push(`UNKNOWN:${id}`); continue; }
    const st = await statusOf(id, c.tenant);
    if (st !== 'active') problems.push(`${st.toUpperCase()}:${id}`);
    if (!a.audiences.includes(audience)) problems.push(`AUDIENCE_FORBIDDEN:${id}`);
    if (c.platform && !a.platforms.includes(String(c.platform).toUpperCase()) && audience !== 'CUSTOMER') problems.push(`PLATFORM:${id}`);
  }
  // Incompatibilité : jamais un agent offensif (sécurité) avec une audience client, et deux agents « meta » ne se chaînent pas.
  const caps = list.map(get).filter(Boolean);
  if (audience === 'CUSTOMER' && caps.some((a) => a.capabilities.includes('security.offensive'))) problems.push('OFFENSIVE_WITH_CUSTOMER');
  return { ok: problems.length === 0, problems, ids: list };
}

// ---- traçabilité d'usage (agrégat journalier, non bloquant) --------------------------------------------------------------------------
const usage = [];
function recordUsage(entry) {
  const e = Object.assign({ at: new Date().toISOString() }, entry);
  usage.push(e); if (usage.length > 500) usage.shift();
  try { require('../activityStore').record({ type: 'specialist', action: `Spécialiste ${e.agentId}`, tenant: e.tenant, status: e.ok ? 'ok' : 'error', detail: `${e.purpose || '-'} · ${e.ms || 0} ms${e.reason ? ' · ' + e.reason : ''}` }); } catch (err) { /* non bloquant */ }
  return e;
}
const recentUsage = (tenant, limit) => usage.filter((u) => !tenant || u.tenant === tenant).slice(-(limit || 50)).reverse();

function summary() {
  const c = loadCatalog();
  const perDivision = {};
  for (const a of c.agents.values()) perDivision[a.division] = (perDivision[a.division] || 0) + 1;
  return { total: c.agents.size, perDivision, blocked: all().filter((a) => a.baseStatus === 'blocked').map((a) => a.agentId), source: c.lock.source || null, commit: c.lock.commit || null, syncedAt: c.lock.syncedAt || null, problems: c.problems };
}

module.exports = { loadCatalog, reload: () => loadCatalog(true), all, get, list, statusOf, setStatus, playbook, validateChain, recordUsage, recentUsage, summary, publicView, CUSTOMER_CAPS, MAX_CHAIN, CATALOG_DIR, _resetState: () => stateCache.clear() };
