const fs = require('fs');
const path = require('path');
const storageAdapter = require('../storageAdapter');
const secretVault = require('../secretVault');

const platformConnector = require('./platformConnector');
const systemIoConnector = require('./systemIoConnector');
const accountingConnector = require('./accountingConnector');

// GESTIONNAIRE DE CONNECTEURS — ai-engine/connectors/connectorManager.js
// ---------------------------------------------------------------------------
// Cœur EXTENSIBLE et PILOTÉ PAR LES PERMISSIONS du moteur intelligent. CYRUS
// n'est PAS limité à une plateforme (la formation n'est qu'un exemple) : les
// capacités de l'agent VARIENT d'un vendeur à l'autre selon (1) les
// connecteurs qu'il a ACTIVÉS et (2) les permissions (scopes) accordées à
// chacun. Ce module :
//   - connaît les DÉFINITIONS de connecteurs disponibles (platform_gateway,
//     systemio, accounting) — chacune déclare ses outils + une fonction
//     execute() ;
//   - charge la CONFIG PAR TENANT (quels connecteurs actifs, avec quels
//     réglages/scopes) — défaut committé dans active_connectors.json,
//     surchargeable par tenant via storageAdapter (namespace `connectors`) ;
//   - n'expose au LLM (getToolsForTenant) QUE les outils des connecteurs
//     actifs ET dont le scope est réellement accordé ;
//   - exécute un outil (executeTool) en injectant les secrets depuis .env
//     (jamais depuis la config committée ni depuis une conversation client).
//
// GARDE-FOU DE SÉCURITÉ ABSOLU (§ cahier des charges) : aucun outil de
// suppression définitive n'est jamais déclaré ni exécuté. Toute tentative
// (nom d'outil contenant un verbe destructif, ou champ delete/purge dans les
// arguments) est refusée structurellement ici, quelle que soit la définition
// d'un connecteur — filet en plus de l'absence volontaire de tels outils.

const DEFINITIONS = {
  [platformConnector.type]: platformConnector,
  [systemIoConnector.type]: systemIoConnector,
  [accountingConnector.type]: accountingConnector,
};

const CONFIG_NAMESPACE = 'connectors';
let defaultConfigCache = null;

function loadDefaultConfig() {
  if (defaultConfigCache) return defaultConfigCache;
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'active_connectors.json'), 'utf8');
    defaultConfigCache = JSON.parse(raw);
  } catch (err) {
    defaultConfigCache = { connectors: {} };
  }
  return defaultConfigCache;
}

// Config effective d'un tenant : défaut committé, fusionné (surchargé) par
// l'éventuelle config propre au tenant (activations/désactivations/scopes
// décidés par le vendeur). Fusion peu profonde par type de connecteur —
// suffisant : un tenant redéfinit l'objet de config d'un connecteur en entier.
async function getTenantConfig(tenantId) {
  const base = loadDefaultConfig();
  const override = await storageAdapter.get(CONFIG_NAMESPACE, tenantId || 'default', null);
  const merged = { connectors: Object.assign({}, base.connectors || {}) };
  if (override && override.connectors) {
    for (const type of Object.keys(override.connectors)) {
      merged.connectors[type] = Object.assign({}, merged.connectors[type] || {}, override.connectors[type]);
    }
  }
  return merged;
}

const DESTRUCTIVE_RE = /(delete|supprim|purge|drop|effac|remove_?permanent|wipe|destroy|erase)/i;
function isDestructiveTool(name) {
  return DESTRUCTIVE_RE.test(String(name || ''));
}

// Un outil est autorisé pour ce tenant si : son connecteur est activé, l'outil
// n'est pas destructif, et — si le connecteur déclare une liste `scopes` (les
// permissions accordées à la clé/au compte) — le scope requis par l'outil y
// figure. Pas de `scopes` déclaré => tous les outils non destructifs du
// connecteur sont autorisés (connecteur sans notion de permission fine).
function toolAllowed(connectorCfg, tool) {
  if (isDestructiveTool(tool.name)) return false;
  const scopes = connectorCfg && Array.isArray(connectorCfg.scopes) ? connectorCfg.scopes : null;
  if (!scopes) return true;
  if (!tool.permission) return true;
  return scopes.includes(tool.permission);
}

// Outils réellement disponibles pour ce tenant (déclarations prêtes à donner
// au LLM). Chaque entrée porte le type de connecteur d'origine pour le routage
// à l'exécution.
async function getToolsForTenant(tenantId) {
  const cfg = await getTenantConfig(tenantId);
  const tools = [];
  for (const type of Object.keys(cfg.connectors || {})) {
    const connectorCfg = cfg.connectors[type];
    if (!connectorCfg || connectorCfg.enabled !== true) continue;
    const def = DEFINITIONS[type];
    if (!def) continue;
    for (const tool of def.tools || []) {
      if (!toolAllowed(connectorCfg, tool)) continue;
      tools.push({
        connectorType: type,
        connectorLabel: def.label,
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters || {},
        permission: tool.permission || null,
      });
    }
  }
  return tools;
}

// Résolution de secret : la config d'un connecteur ne stocke JAMAIS une valeur
// de clé, seulement le NOM de la variable d'environnement qui la porte. On lit
// donc process.env par ce nom (injectable pour les tests via `env`).
function makeGetSecret(env) {
  const source = env || process.env;
  return (name) => (name && source[name]) || null;
}

// Exécute un outil pour un tenant, après avoir re-vérifié qu'il lui est bien
// autorisé (défense en profondeur : ne jamais faire confiance à un nom d'outil
// venu du LLM sans re-contrôler les permissions du tenant). Injecte config +
// secrets + transport HTTP + store de persistance au connecteur.
async function executeTool(tenantId, toolName, args, opts) {
  const options = opts || {};
  if (isDestructiveTool(toolName)) {
    return { ok: false, error: 'DESTRUCTIVE_TOOL_FORBIDDEN' };
  }
  const cfg = await getTenantConfig(tenantId);

  let owner = null;
  let ownerCfg = null;
  for (const type of Object.keys(cfg.connectors || {})) {
    const connectorCfg = cfg.connectors[type];
    if (!connectorCfg || connectorCfg.enabled !== true) continue;
    const def = DEFINITIONS[type];
    if (!def) continue;
    const tool = (def.tools || []).find((t) => t.name === toolName);
    if (tool && toolAllowed(connectorCfg, tool)) { owner = def; ownerCfg = connectorCfg; break; }
  }
  if (!owner) return { ok: false, error: 'TOOL_NOT_AVAILABLE_OR_NOT_PERMITTED:' + toolName };

  // Résolution de la clé : coffre chiffré PAR TENANT (apiKeyRef) en priorité —
  // les services configurés via l'onglet Services Métiers stockent leur clé
  // dans le coffre ; repli sur la variable d'environnement (apiKeyEnv) pour la
  // config par défaut (ex. clé RIEA du propriétaire dans .env). La clé résolue
  // est injectée dans ctx.apiKey (jamais loggée).
  let resolvedApiKey = null;
  if (ownerCfg && ownerCfg.apiKeyRef) {
    resolvedApiKey = await secretVault.getSecret(tenantId || 'default', ownerCfg.apiKeyRef).catch(() => null);
  }
  if (!resolvedApiKey && ownerCfg && ownerCfg.apiKeyEnv) {
    const envSource = options.env || process.env;
    resolvedApiKey = envSource[ownerCfg.apiKeyEnv] || null;
  }

  const ctx = {
    config: ownerCfg,
    tenantId: tenantId || 'default',
    apiKey: resolvedApiKey,
    getSecret: makeGetSecret(options.env),
    http: options.http || (typeof fetch === 'function' ? fetch : null),
    store: options.store || storageAdapter,
  };
  try {
    return await owner.execute(toolName, args || {}, ctx);
  } catch (err) {
    return { ok: false, error: 'CONNECTOR_EXECUTION_ERROR', detail: String((err && err.message) || err) };
  }
}

// Liste lisible des connecteurs actifs d'un tenant (pour affichage/diagnostic).
async function listActiveConnectors(tenantId) {
  const cfg = await getTenantConfig(tenantId);
  const out = [];
  for (const type of Object.keys(cfg.connectors || {})) {
    const c = cfg.connectors[type];
    if (!c || c.enabled !== true) continue;
    const def = DEFINITIONS[type];
    if (!def) continue;
    out.push({ type, label: def.label, scopes: Array.isArray(c.scopes) ? c.scopes : null });
  }
  return out;
}

module.exports = {
  getToolsForTenant,
  executeTool,
  listActiveConnectors,
  getTenantConfig,
  isDestructiveTool,
  DEFINITIONS,
  CONFIG_NAMESPACE,
};
