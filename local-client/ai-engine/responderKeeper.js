// Gardien du répondeur permanent : pour chaque compte « toujours actif », s'assure à intervalle régulier que les sessions
// WhatsApp et Telegram existent, sont démarrées et se reconnectent si elles tombent (jamais plus d'une tentative toutes
// les KICK_MIN_INTERVAL_MS par compte et par canal, pour ne pas marteler les serveurs des plateformes).
// Ne contourne aucune protection : il relance la connexion normale du gestionnaire de sessions.
// Cadence resserrée le 2026-09-23 (exigence explicite : répondeur réactif en permanence) — la vérification elle-même est
// locale (isPaired()/isConnected(), aucun appel réseau tant que la session est déjà connectée), donc un sondage plus
// fréquent ne charge pas les plateformes ; seul KICK_MIN_INTERVAL_MS protège contre le martèlement en cas de coupure réelle.
const alwaysOn = require('./alwaysOn');

const KICK_MIN_INTERVAL_MS = 90 * 1000;
const state = new Map(); // `${tenant}:${channel}` -> { lastKickAt, lastState, lastError, kicks }
let timer = null;

function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }

function inspect(manager, channel, tenant, now, opts) {
  const key = `${tenant}:${channel}`;
  const st = state.get(key) || { lastKickAt: 0, lastState: null, lastError: null, kicks: 0 };
  let entry;
  try { entry = manager.getOrCreate(tenant); } catch (e) { st.lastError = String(e.message || e); st.lastState = 'UNAVAILABLE'; state.set(key, st); return st; }
  const s = entry.session;
  const paired = safe(() => s.isPaired(), null);
  const connected = safe(() => s.isConnected(), false);
  let current = connected ? 'CONNECTED' : (paired === false ? 'NOT_PAIRED' : 'DISCONNECTED');
  if (!connected && paired !== false && now - st.lastKickAt >= KICK_MIN_INTERVAL_MS) {
    // Session appairée mais coupée : redémarrage par le gestionnaire (restauration des identifiants + connexion).
    entry.initStarted = false;
    try { manager.ensureConnected(entry); st.lastKickAt = now; st.kicks += 1; current = 'RECONNECTING'; st.lastError = null; }
    catch (e) { st.lastError = String(e.message || e); }
  }
  if (!entry.initStarted && paired !== false) { try { manager.ensureConnected(entry); } catch (e) { st.lastError = String(e.message || e); } }
  if (opts && opts.onChange && st.lastState !== current) opts.onChange({ tenant, channel, from: st.lastState, to: current });
  st.lastState = current; st.paired = paired;
  state.set(key, st);
  return st;
}

function tick(managers, opts) {
  const now = Date.now();
  for (const tenant of alwaysOn.list()) {
    if (managers.whatsapp) inspect(managers.whatsapp, 'WHATSAPP', tenant, now, opts);
    if (managers.telegram) inspect(managers.telegram, 'TELEGRAM', tenant, now, opts);
  }
}

function start(managers, opts) {
  if (timer) return timer;
  const o = opts || {};
  const run = () => { try { tick(managers, o); } catch (e) { console.error('responderKeeper :', e.message); } };
  run();
  timer = setInterval(run, o.intervalMs || 15 * 1000);
  if (timer.unref) timer.unref();
  return timer;
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

function status(tenant) {
  const out = {};
  for (const ch of ['WHATSAPP', 'TELEGRAM']) {
    const st = state.get(`${alwaysOn.sanitize(tenant)}:${ch}`);
    out[ch.toLowerCase()] = st ? { state: st.lastState, paired: st.paired, kicks: st.kicks, lastKickAt: st.lastKickAt || null, lastError: st.lastError } : { state: 'NOT_CHECKED' };
  }
  return out;
}

module.exports = { start, stop, tick, status, KICK_MIN_INTERVAL_MS, _state: state };
