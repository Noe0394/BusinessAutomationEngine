// File par conversation : exécution en série (un seul traitement à la fois par
// clé) + regroupement (debounce) des messages rapprochés en une seule réponse.

class ConversationQueue {
  constructor() { this.entries = new Map(); }

  // submit(key, item, processor, { debounceMs, maxWaitMs }) -> résultat du lot
  // (pour le dernier message du lot) ou { skipped: 'AGGREGATED' } (autres).
  submit(key, item, processor, opts) {
    const o = opts || {};
    const debounceMs = Math.max(0, o.debounceMs == null ? 0 : o.debounceMs);
    const maxWaitMs = Math.max(debounceMs, o.maxWaitMs == null ? 6000 : o.maxWaitMs);
    let e = this.entries.get(key);
    if (!e) { e = { buffer: [], timer: null, firstAt: 0, running: false, processor }; this.entries.set(key, e); }
    e.processor = processor;
    return new Promise((resolve) => {
      if (!e.buffer.length) e.firstAt = Date.now();
      e.buffer.push({ item, resolve });
      if (e.timer) clearTimeout(e.timer);
      const wait = Math.min(debounceMs, Math.max(0, e.firstAt + maxWaitMs - Date.now()));
      e.timer = setTimeout(() => this._flush(key), wait);
    });
  }

  async _flush(key) {
    const e = this.entries.get(key);
    if (!e) return;
    e.timer = null;
    if (e.running) return; // relancé à la fin du traitement en cours
    if (!e.buffer.length) { this.entries.delete(key); return; }
    e.running = true;
    const batch = e.buffer.splice(0, e.buffer.length);
    let result;
    try { result = await e.processor(batch.map((b) => b.item)); } catch (err) { result = { skipped: 'ERROR', error: err.message }; }
    batch.forEach((b, i) => b.resolve(i === batch.length - 1 ? result : { skipped: 'AGGREGATED' }));
    e.running = false;
    if (e.buffer.length) { e.timer = setTimeout(() => this._flush(key), 0); } else { this.entries.delete(key); }
  }

  size() { return this.entries.size; }
}

module.exports = { ConversationQueue, shared: new ConversationQueue() };
