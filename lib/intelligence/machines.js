// MACHINES — registre des machines cibles de la couche intelligence (Machine view)
// -------------------------------------------------------------------------------
// Une "machine" est un exécutant concret vers lequel le registre des 12 actions
// route certaines actions. Aujourd'hui : WHATSAPP_LOCAL, le PC de l'utilisateur
// qui fait tourner le moteur de campagne WhatsApp local (local-client, moteur
// whatsapp-web.js + moteur de campagnes SQLite).
//
// Transport : HTTP. L'orchestrateur (VPS/couche intelligence) envoie un job au
// PC via POST /api/machine/job, authentifié par la clé machine (secret partagé
// en en-tête X-Machine-Key) — voir local-client/lib/machine.js côté PC.
//
// CONFIGURATION (côté orchestrateur, .env) :
//   WHATSAPP_LOCAL_BASE_URL   base du serveur local-client (défaut http://localhost:4100)
//   WHATSAPP_LOCAL_MACHINE_KEY clé partagée (obligatoire pour ENABLER la machine ;
//                               sans elle, la machine n'est pas enregistrée et le
//                               comportement existant est totalement conservé —
//                               garantie zéro-régression).
//
// RÈGLE D'OR : aucun throw depuis ce module — un transport injoignable renvoie
// { ok:false, error:'MACHINE_UNREACHABLE' } propre, jamais une exception qui
// ferait échouer le moteur d'automatisation.
'use strict';

const DEFAULT_BASE = 'http://localhost:4100';

function readEnv(envRef, name) {
  try {
    if (!envRef) return null;
    if (typeof envRef === 'function') return envRef(name);
    if (typeof envRef.get === 'function') return envRef.get(name);
    if (envRef instanceof Map) return envRef.get(name);
    return envRef[name] || null;
  } catch (e) { return null; }
}

// Carte machine (Machine view) : identité + capacités + configuration.
function machineCard(id, label, capabilities, opts) {
  return {
    id,
    label,
    type: 'http',
    capabilities: capabilities || [],
    enabled: true,
    configured: !!(opts && opts.key),
    baseUrl: (opts && opts.baseUrl) || null,
  };
}

// Registre des machines connues/activées. `deps.env` suit la même convention
// que action-executor (objet / get(k) / Map / fonction).
function createMachineRegistry(deps) {
  const d = deps || {};
  const env = d.env || null;
  const machines = new Map();
  const registryMod = {
    register(def) {
      if (!def || !def.id) return;
      machines.set(String(def.id).toUpperCase(), def);
    },
    has(id) { return machines.has(String(id || '').toUpperCase()); },
    get(id) { return machines.get(String(id || '').toUpperCase()) || null; },
    list() { return Array.from(machines.values()).map((m) => machineCard(m.id, m.label, m.capabilities, m.opts)); },
  };

  // Ce PC est atteignable au lancement du serveur local-client, PAS quand
  // l'orchestrateur démarre sans la clé : une machine sans clé n'est pas
  // enregistrée, donc les WHATSAPP actions continuent exactement comme avant.
  const key = readEnv(env, 'WHATSAPP_LOCAL_MACHINE_KEY');
  if (key) {
    registryMod.register({
      id: 'WHATSAPP_LOCAL',
      label: 'CYRUS sur PC — WhatsApp local (whatsapp-web.js + moteur de campagnes)',
      capabilities: ['EXTRACT_MEMBERS', 'SEND_CAMPAIGN', 'FOLLOW_UP', 'PAUSE_CAMPAIGN', 'RESUME_CAMPAIGN'],
      opts: {
        baseUrl: readEnv(env, 'WHATSAPP_LOCAL_BASE_URL') || DEFAULT_BASE,
        key,
      },
    });
  }

  registryMod.ready = !!key;
  return registryMod;
}

// --- Transport HTTP (jamais de throw) -----------------------------------------
async function httpJob(machine, action, payload, deps) {
  const http = (deps && deps.http) || (typeof fetch === 'function' ? fetch : null);
  if (!http) return { ok: false, error: 'NO_HTTP_TRANSPORT' };
  const url = (machine.baseUrl || DEFAULT_BASE).replace(/\/+$/, '') + '/api/machine/job';
  let res = null;
  try {
    res = await http(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Machine-Key': machine.key || '',
      },
      body: JSON.stringify({ action, payload: payload || {} }),
    });
  } catch (e) {
    return { ok: false, error: 'MACHINE_UNREACHABLE:' + String((e && e.message) || e) };
  }
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) {
    return { ok: false, status: res.status, error: (data && data.error) || ('HTTP ' + res.status) };
  }
  // Le PC renvoie déjà le contrat { ok, result | error } — on le passe tel quel.
  return { ok: !!(data && data.ok !== false), result: (data && data.result) || null, error: (data && data.error) || null };
}

module.exports = { createMachineRegistry, httpJob, machineCard, DEFAULT_BASE };