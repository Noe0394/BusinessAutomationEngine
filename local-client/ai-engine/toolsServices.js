// Outils du ToolRegistry pour GÉRER les Services métiers de bout en bout — créer (toolRegistry.configureBusinessService), MODIFIER, METTRE EN PAUSE / RÉACTIVER,
// SUPPRIMER et RESTAURER (« faire et défaire »). Chaque outil d'écriture VÉRIFIE l'effet réel en relisant l'état après l'action : sans vérification, l'action
// n'est jamais déclarée faite. Une suppression garde une copie en corbeille (30 jours) : elle est annulable (restoreBusinessService).
// Fusionné dans TOOLS par toolsExtra.js.
const businessServices = require('./businessServices');
const storageAdapter = require('./storageAdapter');

const NS_TRASH = 'service_trash';
const TRASH_DAYS = 30;
const sanitize = (id) => String(id || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'default';
const fail = (code, message) => ({ ok: false, error: { code, message: message || code, retryable: false } });
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const toks = (s) => norm(s).split(' ').filter((t) => t.length >= 3);

const loadTrash = (tenant) => storageAdapter.get(NS_TRASH, sanitize(tenant), { tenant: sanitize(tenant), items: [] });
const saveTrash = (tenant, doc) => storageAdapter.set(NS_TRASH, sanitize(tenant), doc);

// Retrouve UN service à partir d'une référence libre (identifiant, nom exact, nom contenu, ou mots communs). Jamais de choix au hasard : ambigu → erreur claire.
function pick(list, ref) {
  const q = norm(ref); if (!q) return { error: 'REF_REQUIRED' };
  const byId = list.filter((s) => s.id === String(ref).trim()); if (byId.length === 1) return { service: byId[0] };
  const exact = list.filter((s) => norm(s.name) === q); if (exact.length === 1) return { service: exact[0] };
  const contains = list.filter((s) => norm(s.name).includes(q) || (norm(s.name).length >= 4 && q.includes(norm(s.name))));
  if (contains.length === 1) return { service: contains[0] };
  const qt = new Set(toks(ref));
  const scored = list.map((s) => ({ s, hit: toks(s.name).filter((t) => qt.has(t)).length, n: toks(s.name).length })).filter((x) => x.hit > 0).sort((a, z) => z.hit - a.hit);
  if (scored.length && (scored.length === 1 || scored[0].hit > scored[1].hit) && scored[0].hit >= Math.min(2, scored[0].n)) return { service: scored[0].s };
  const cands = (contains.length ? contains : scored.map((x) => x.s)).slice(0, 5);
  if (cands.length > 1) return { error: 'AMBIGUOUS', candidates: cands.map((s) => s.name) };
  return { error: 'NOT_FOUND' };
}
async function resolve(tenant, ref) {
  const list = await businessServices.list(tenant);
  const r = pick(list, ref);
  if (r.error === 'AMBIGUOUS') return { err: fail('AMBIGUOUS', `Plusieurs services correspondent : ${r.candidates.join(', ')}. Précisez le nom complet.`) };
  if (r.error) return { err: fail('SERVICE_NOT_FOUND', list.length ? `Je ne trouve pas de service « ${ref} ». Vos services : ${list.map((s) => s.name).join(', ')}.` : `Je ne trouve pas de service « ${ref} » : vous n'avez aucun service métier.`) };
  return { service: r.service, list };
}
const exists = async (tenant, id) => (await businessServices.list(tenant)).some((s) => s.id === id);

const TOOLS = {
  deleteBusinessService: {
    description: 'SUPPRIME un Service métier (par nom ou identifiant). Une copie est gardée 30 jours : la suppression est annulable avec restoreBusinessService. La clé API éventuelle du service est révoquée.',
    permission: null, risk: 'LOW_WRITE',
    inputSchema: { service: { type: 'string', required: true, description: 'Nom (ou identifiant) du service à supprimer.' } },
    async execute(a, ctx) {
      const r = await resolve(ctx.tenant, a.service); if (r.err) return r.err;
      const s = r.service; const doc = await loadTrash(ctx.tenant);
      const snap = JSON.parse(JSON.stringify(s)); if (snap.connection) { snap.connection.apiKeyRef = null; } // le secret est révoqué à la suppression : reconnecter après restauration
      doc.items = doc.items.filter((x) => Date.now() - x.deletedAt < TRASH_DAYS * 86400000).concat([{ id: s.id, name: s.name, deletedAt: Date.now(), hadApiKey: !!(s.connection && s.connection.apiKeyRef), service: snap }]).slice(-50);
      await saveTrash(ctx.tenant, doc);
      const out = await businessServices.remove(ctx.tenant, s.id);
      if (!out.ok) { doc.items = doc.items.filter((x) => x.id !== s.id); await saveTrash(ctx.tenant, doc); return fail('DELETE_FAILED', 'La suppression a échoué.'); }
      return { ok: true, result: { serviceId: s.id, name: s.name, restorable: true, hadApiKey: !!(s.connection && s.connection.apiKeyRef) } };
    },
    async verify(res, a, ctx) { return { verified: !(await exists(ctx.tenant, res.serviceId)) }; },
  },
  restoreBusinessService: {
    description: 'RESTAURE un Service métier supprimé il y a moins de 30 jours (par nom ; sans nom : le dernier supprimé). Annule une suppression.',
    permission: null, risk: 'LOW_WRITE',
    inputSchema: { service: { type: 'string', description: 'Nom du service supprimé (facultatif : le plus récent).' } },
    async execute(a, ctx) {
      const doc = await loadTrash(ctx.tenant); const items = doc.items.filter((x) => Date.now() - x.deletedAt < TRASH_DAYS * 86400000);
      if (!items.length) return fail('NOTHING_TO_RESTORE', 'Aucun service supprimé récemment à restaurer.');
      let it = null;
      if (a.service) { const r = pick(items.map((x) => Object.assign({ id: x.id, name: x.name }, {})), a.service); if (r.error === 'AMBIGUOUS') return fail('AMBIGUOUS', `Plusieurs services supprimés correspondent : ${r.candidates.join(', ')}.`); if (r.error) return fail('NOT_IN_TRASH', `Aucun service supprimé ne correspond à « ${a.service} ». Supprimés : ${items.map((x) => x.name).join(', ')}.`); it = items.find((x) => x.id === r.service.id); }
      else it = items.slice().sort((x, z) => z.deletedAt - x.deletedAt)[0];
      if (await exists(ctx.tenant, it.id)) return fail('ALREADY_EXISTS', 'Ce service existe déjà.');
      const created = await businessServices.create(ctx.tenant, Object.assign({}, it.service, { id: it.id }));
      doc.items = doc.items.filter((x) => x.id !== it.id); await saveTrash(ctx.tenant, doc);
      return { ok: true, result: { serviceId: created.id, name: created.name, needsApiReconnect: !!it.hadApiKey } };
    },
    async verify(res, a, ctx) { return { verified: await exists(ctx.tenant, res.serviceId) }; },
  },
  listDeletedBusinessServices: {
    description: 'Liste les Services métiers supprimés récemment (restaurables pendant 30 jours).', permission: null, risk: 'READ', inputSchema: {},
    async execute(a, ctx) { const d = await loadTrash(ctx.tenant); const items = d.items.filter((x) => Date.now() - x.deletedAt < TRASH_DAYS * 86400000); return { ok: true, result: { count: items.length, deleted: items.map((x) => ({ name: x.name, deletedAt: x.deletedAt })) } }; },
  },
  setBusinessServiceStatus: {
    description: 'Change l\'état d\'un Service métier : active (proposé aux clients), paused (en pause : plus présenté, données conservées), disabled (désactivé). Par nom ou identifiant.',
    permission: null, risk: 'LOW_WRITE',
    inputSchema: { service: { type: 'string', required: true }, status: { type: 'string', required: true, description: 'active | paused | disabled' } },
    async execute(a, ctx) {
      const st = String(a.status || '').toLowerCase(); if (!['active', 'paused', 'disabled'].includes(st)) return fail('INVALID_STATUS', 'status doit valoir active, paused ou disabled.');
      const r = await resolve(ctx.tenant, a.service); if (r.err) return r.err;
      const u = await businessServices.update(ctx.tenant, r.service.id, { lifecycle: st });
      if (!u) return fail('UPDATE_FAILED');
      return { ok: true, result: { serviceId: r.service.id, name: r.service.name, status: st } };
    },
    async verify(res, a, ctx) { const s = (await businessServices.list(ctx.tenant)).find((x) => x.id === res.serviceId); return { verified: !!s && (s.lifecycle || 'active') === res.status }; },
  },
  updateBusinessService: {
    description: 'MODIFIE un Service métier existant (sans le recréer) : memo (remplace toute la mémoire libre par ce texte — relis d\'abord la mémoire actuelle si tu ne fais que corriger un détail, pour ne rien perdre), memoAppend (ajoute une note à la mémoire libre SANS toucher au reste — préférable pour un simple ajout du type "ajoute une promo…"/"change mon numéro Wave…"), name (renommer), price, currency, description, advantages, paymentTerms, supportRules, target, addProducts / removeProducts (« Nom|Prix » séparés par « ; »), rules, objectives. Chaque champ fourni REMPLACE l\'ancien ; les champs omis restent inchangés — rien n\'est jamais effacé sans le dire explicitement. Par nom ou identifiant.',
    permission: null, risk: 'LOW_WRITE',
    inputSchema: { service: { type: 'string', required: true }, memo: { type: 'string', description: 'Remplace toute la mémoire libre de l\'activité par ce texte.' }, memoAppend: { type: 'string', description: 'Ajoute une note à la mémoire libre existante, sans rien effacer.' }, name: { type: 'string' }, price: { type: 'number' }, currency: { type: 'string' }, description: { type: 'string' }, advantages: { type: 'string' }, paymentTerms: { type: 'string' }, supportRules: { type: 'string' }, target: { type: 'string' }, addProducts: { type: 'string' }, removeProducts: { type: 'string', description: 'Noms des produits à retirer, séparés par « ; ».' }, rules: { type: 'string' }, objectives: { type: 'string' } },
    async execute(a, ctx) {
      const r = await resolve(ctx.tenant, a.service); if (r.err) return r.err;
      const s = r.service; const split = (v) => String(v || '').split(/[\n;]+/).map((x) => x.trim()).filter(Boolean);
      const patch = {}; const changed = [];
      if (a.name) { patch.name = String(a.name).slice(0, 120); changed.push('name'); }
      const commercial = Object.assign({}, s.commercial);
      for (const k of ['price', 'currency', 'description', 'advantages', 'paymentTerms', 'supportRules', 'target']) if (a[k] !== undefined && a[k] !== null && a[k] !== '') { commercial[k] = k === 'price' ? Number(a[k]) : String(a[k]); changed.push(k); }
      if (a.memo !== undefined && a.memo !== null) { commercial.memo = String(a.memo).slice(0, 8000); changed.push('memo'); }
      else if (a.memoAppend) { commercial.memo = String(commercial.memo || '').trim().concat(commercial.memo ? '\n' : '', String(a.memoAppend)).slice(0, 8000); changed.push('memo'); }
      if (changed.some((k) => k !== 'name')) patch.commercial = commercial;
      let products = (s.products || []).slice();
      if (a.addProducts) { for (const line of split(a.addProducts)) { const [n, p] = line.split('|').map((x) => x.trim()); const item = { name: n || line, price: p ? Number(p) : null }; const i = products.findIndex((x) => norm(x.name) === norm(item.name)); if (i >= 0) products[i] = item; else products.push(item); } changed.push('addProducts'); }
      if (a.removeProducts) { const rm = split(a.removeProducts).map(norm); products = products.filter((x) => !rm.includes(norm(x.name))); changed.push('removeProducts'); }
      if (changed.includes('addProducts') || changed.includes('removeProducts')) patch.products = products;
      if (a.rules) { patch.rules = split(a.rules); changed.push('rules'); }
      if (a.objectives) { patch.objectives = split(a.objectives); changed.push('objectives'); }
      if (!changed.length) return fail('NOTHING_TO_CHANGE', 'Dites-moi ce qu\'il faut modifier (nom, prix, description, produits, règles…).');
      const u = await businessServices.update(ctx.tenant, s.id, patch); if (!u) return fail('UPDATE_FAILED');
      return { ok: true, result: { serviceId: s.id, name: u.name, changed, expect: { name: patch.name || null, price: commercial.price != null ? commercial.price : null, products: patch.products ? patch.products.map((x) => x.name) : null } } };
    },
    async verify(res, a, ctx) {
      const s = (await businessServices.list(ctx.tenant)).find((x) => x.id === res.serviceId); if (!s) return { verified: false };
      let ok = true;
      if (res.expect.name) ok = ok && s.name === res.expect.name;
      if (res.changed.includes('price')) ok = ok && Number(s.commercial && s.commercial.price) === Number(res.expect.price);
      if (res.expect.products) ok = ok && JSON.stringify((s.products || []).map((x) => x.name)) === JSON.stringify(res.expect.products);
      return { verified: ok };
    },
  },
};

module.exports = { TOOLS, pick, resolve, norm };
