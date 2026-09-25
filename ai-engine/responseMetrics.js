// Mesures locales de la chaîne conversationnelle (horloge monotone pour les
// durées, UTC pour les horodatages). Les traces ne contiennent aucun texte client.
const { performance } = require('node:perf_hooks');

function start({ tenant, channel, target, source } = {}) {
  const wallStart = Date.now();
  const monoStart = performance.now();
  const stages = {};
  let previous = monoStart;
  let finished = false;

  function mark(name, data) {
    if (finished || !name) return;
    const now = performance.now();
    stages[String(name).slice(0, 32)] = {
      at: new Date().toISOString(),
      elapsedMs: Math.max(0, Math.round(now - monoStart)),
      sincePreviousMs: Math.max(0, Math.round(now - previous)),
      ...(data && typeof data === 'object' ? data : {}),
    };
    previous = now;
  }

  mark('received', { source: String(source || 'conversation').slice(0, 24) });
  return {
    mark,
    async finish(result) {
      if (finished) return null;
      mark('completed', { status: String(result && result.status || 'DONE').slice(0, 24) });
      finished = true;
      const totalMs = Math.max(0, Math.round(performance.now() - monoStart));
      const timings = { receivedAt: new Date(wallStart).toISOString(), completedAt: new Date().toISOString(), totalMs, stages };
      try {
        await require('./activityStore').record({
          type: 'response_timing', action: 'Latence de réponse', status: result && result.status === 'ERROR' ? 'error' : 'ok',
          tenant, channel, target, detail: `${source || 'conversation'} · total ${totalMs} ms`, timings,
        });
      } catch (e) { /* le monitoring ne bloque jamais une réponse */ }
      return timings;
    },
  };
}

module.exports = { start };
