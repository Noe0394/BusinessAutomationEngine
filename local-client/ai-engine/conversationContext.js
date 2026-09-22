// CONTEXTE D'UNE DISCUSSION — ai-engine/conversationContext.js
// ---------------------------------------------------------------------------
// Lit la MÉMOIRE DES 7 JOURS (messageHistory) d'UNE discussion (privée ou groupe) et répond, sans appel IA ni réseau (100 % déterministe, quelques ms) :
//   • de quoi parle-t-on ? (thèmes dominants, pondérés par la récence)
//   • quel Service métier est concerné ? (affinité 0..1 avec le nom, les produits, la description ; ou groupe explicitement lié)
//   • a-t-on déjà parlé business ? à quel point ? (température froide / tiède / chaude, dernier échange business)
//   • ai-je déjà présenté mes services récemment ? (pour ne pas me répéter)
//   • en groupe : qui parle, est-ce un échange entre deux membres, combien ai-je déjà répondu ces 10 dernières minutes ?
// Le résultat est un simple objet lisible (voir `analyze`), utilisé par engagement.js pour DÉCIDER et par le prompt pour répondre juste.
const messageHistory = require('./messageHistory');

const DAY = 24 * 3600 * 1000;
const STOP = new Set(('alors ainsi apres avec avoir bien bonjour bonsoir cela celui ceux chaque comme comment dans depuis donc dont elle elles encore entre etre faire fait faut hello leur leurs mais merci meme moins notre nous plus pour pourquoi quand quel quelle quels quelles quoi sans sera serait sont sous suis tout toute tous tres votre vous vais veux voir voila ici cette cela chez oui non peut peux puis aussi autre autres deja jour jours salut svp stp ok okay merci beaucoup bonne journee soir matin').split(/\s+/));
const BUSINESS_RE = /\b(prix|tarifs?|co[uû]t\w*|combien|acheter|achat|commande\w*|command\w+|inscri\w+|payer|paiement|livraison|disponible|stock|promo\w*|offres?|produits?|services?|formations?|cours|devis|r[ée]serv\w+|rendez[- ]vous|abonnement|catalogue|remise|r[ée]duction|garantie|facture)\b/i;

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const tokens = (s) => norm(s).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length >= 4 && !STOP.has(t) && !/^\d+$/.test(t));

const memo = new Map(); // clé → { at, value } : évite de relire 7 jours d'historique deux fois pour le même message
const MEMO_MS = 4000;

function serviceKeywords(s) {
  const c = s.commercial || {};
  const bag = new Set([...tokens(s.name), ...tokens(s.type === 'autre' ? '' : s.type)]);
  for (const p of (s.products || [])) for (const t of tokens(p && (p.name || p))) bag.add(t);
  for (const t of tokens(`${c.description || ''} ${c.advantages || ''} ${c.target || ''}`).slice(0, 40)) bag.add(t);
  return bag;
}

// Affinité d'un Service avec les termes de la discussion : part des mots-clés du service retrouvés + bonus si son nom est cité.
function affinityOf(service, termWeights, nameMentioned) {
  const kw = serviceKeywords(service); if (!kw.size) return { score: nameMentioned ? 0.6 : 0, hits: [] };
  const hits = []; let w = 0;
  for (const [t, weight] of termWeights) if (kw.has(t)) { hits.push(t); w += Math.min(weight, 3); }
  const base = Math.min(1, w / Math.max(4, Math.min(kw.size, 8)));
  return { score: Math.min(1, base + (nameMentioned ? 0.4 : 0)), hits: hits.slice(0, 6) };
}

// input : { tenant, channel, from, isGroup, text, windowDays, now }
async function analyze(input) {
  const { tenant, channel, from, isGroup } = input; const now = input.now || Date.now(); const windowDays = Math.max(1, Math.min(7, input.windowDays || 7));
  const key = `${tenant}|${channel}|${from}|${now - (now % MEMO_MS)}`;
  const hit = memo.get(key); if (hit && now - hit.at < MEMO_MS) return withText(hit.value, input.text);
  let msgs = [];
  try { msgs = isGroup ? await messageHistory.getGroupMessages(tenant, channel, from, 300) : await messageHistory.getConversationMessages(tenant, channel, from, 300); } catch (e) { msgs = []; }
  const since = now - windowDays * DAY;
  msgs = msgs.filter((m) => (m.tsMs || 0) >= since);

  // Services actifs du compte (chargés d'abord : leurs mots-clés servent aussi à reconnaître un message « business » sans mot-clé de vente).
  let services = [];
  try { services = (await require('./businessServices').list(tenant)).filter((s) => (s.lifecycle || 'active') === 'active'); } catch (e) { services = []; }
  const kwUnion = new Set(); for (const s of services) for (const t of serviceKeywords(s)) kwUnion.add(t);
  const isBusinessText = (txt) => BUSINESS_RE.test(txt || '') || tokens(txt).some((t) => kwUnion.has(t));
  // Thèmes : poids = 1 (plus vieux) → 2 (dernières 24 h) ; les messages entrants comptent pleinement, les nôtres à moitié.
  const weights = new Map(); let businessIn = 0; let lastBusinessTs = 0; let business24h = 0; let lastPresentedTs = 0; let botReplies10 = 0;
  const senders = new Map(); const lastSenders = [];
  for (const m of msgs) {
    const recent = now - (m.tsMs || 0) < DAY; const out = m.direction === 'out'; const w = (recent ? 2 : 1) * (out ? 0.5 : 1);
    for (const t of tokens(m.text)) weights.set(t, (weights.get(t) || 0) + w);
    if (!out && isBusinessText(m.text)) { businessIn += 1; lastBusinessTs = Math.max(lastBusinessTs, m.tsMs || 0); if (recent) business24h += 1; }
    if (out && (m.tsMs || 0) >= now - 10 * 60 * 1000) botReplies10 += 1;
    if (!out) { const id = m.senderId || m.senderName || m.party || '?'; const e = senders.get(id) || { id, name: m.senderName || m.name || null, count: 0 }; e.count += 1; if (!e.name) e.name = m.senderName || m.name || null; senders.set(id, e); lastSenders.push(id); }
  }
  const themes = [...weights.entries()].filter(([, v]) => v >= 2).sort((a, z) => z[1] - a[1]).slice(0, 6).map(([term, score]) => ({ term, score: Math.round(score * 10) / 10 }));

  // Services du compte : affinité avec la discussion.
  const allText = norm(msgs.map((m) => m.text).join(' '));
  let best = null; let linked = null;
  for (const s of services) {
    const isLinked = (s.groups || []).some((g) => String(g.id) === String(from));
    const nameMentioned = !!s.name && s.name.length >= 3 && allText.includes(norm(s.name));
    const a = affinityOf(s, weights, nameMentioned);
    const score = isLinked ? 1 : a.score;
    if (isLinked) linked = s;
    if (!best || score > best.affinity) best = { id: s.id, name: s.name, affinity: Math.round(score * 100) / 100, linked: isLinked, hits: a.hits };
    // Présentation récente de CE service par nous (nom cité dans un de nos messages des 24 dernières heures).
    for (const m of msgs) if (m.direction === 'out' && now - (m.tsMs || 0) < DAY && s.name && norm(m.text).includes(norm(s.name))) lastPresentedTs = Math.max(lastPresentedTs, m.tsMs || 0);
  }

  // Groupe : échange à deux ? (les 4 derniers messages entrants ne viennent que de 2 personnes qui alternent)
  const tail = lastSenders.slice(-4); const distinct = new Set(tail);
  const duo = !!isGroup && tail.length >= 4 && distinct.size === 2 && tail.every((x, i) => i === 0 || x !== tail[i - 1]);

  const temperature = business24h >= 3 ? 'hot' : (businessIn >= 1 ? 'warm' : 'cold');
  const value = {
    scope: isGroup ? 'group' : 'private', windowDays, messages: msgs.length,
    firstTs: msgs.length ? msgs[0].tsMs : null, lastTs: msgs.length ? msgs[msgs.length - 1].tsMs : null,
    themes, service: best && (best.affinity > 0 || best.linked) ? best : null, groupLinked: !!linked,
    business: { messages: businessIn, last24h: business24h, lastTs: lastBusinessTs || null, temperature, presentedRecently: lastPresentedTs > 0, lastPresentedTs: lastPresentedTs || null },
    group: isGroup ? { participants: [...senders.values()].sort((a, z) => z.count - a.count).slice(0, 6), duo, botRepliesLast10Min: botReplies10 } : null,
    serviceTerms: [...kwUnion].slice(0, 300),
    // Sans historique ni thème reconnu : le service le plus récent reste disponible pour répondre à « que vendez-vous ? » ; la liste complète sert à tous les présenter.
    fallbackService: services.length ? (() => { const s = services.slice().sort((a, z) => String(z.createdAt).localeCompare(String(a.createdAt)))[0]; return { id: s.id, name: s.name, affinity: 0, fallback: true }; })() : null,
    serviceNames: services.map((s) => s.name).slice(0, 8),
    recent: msgs.slice(-10).map((m) => `${m.direction === 'out' ? 'Moi' : (m.senderName || m.name || 'Contact')}: ${String(m.text || '').replace(/\s+/g, ' ').slice(0, 160)}`),
  };
  memo.set(key, { at: now, value }); if (memo.size > 200) memo.delete(memo.keys().next().value);
  return withText(value, input.text);
}

// Le message courant (pas encore dans l'historique) : nom de service cité, mots business, thème du moment.
function withText(base, text) {
  const t = String(text || '');
  const out = Object.assign({}, base);
  const terms = tokens(t).slice(0, 12);
  out.current = { businessWords: BUSINESS_RE.test(t), terms, serviceHit: terms.some((x) => (base.serviceTerms || []).includes(x)) };
  const svc = base.service;
  if (svc && out.current.terms.length) {
    const overlap = out.current.terms.filter((x) => (base.themes || []).some((th) => th.term === x) || (svc.hits || []).includes(x));
    out.current.onTheme = overlap.length > 0;
  } else out.current.onTheme = false;
  return out;
}

// Résumé lisible (une phrase) — pour le prompt ET pour l'explication donnée au propriétaire.
function summarize(ctx) {
  if (!ctx || !ctx.messages) return 'Aucun échange dans les derniers jours : première prise de contact.';
  const th = ctx.themes.slice(0, 3).map((t) => t.term).join(', ');
  const days = ctx.lastTs && ctx.firstTs ? Math.max(1, Math.round((ctx.lastTs - ctx.firstTs) / DAY)) : 1;
  const bits = [`${ctx.messages} message(s) sur ${days} jour(s)`, th ? `thèmes : ${th}` : 'thèmes : aucun dominant'];
  if (ctx.service) bits.push(`service concerné : « ${ctx.service.name} » (affinité ${Math.round(ctx.service.affinity * 100)} %${ctx.service.linked ? ', groupe lié' : ''})`);
  bits.push(ctx.business.temperature === 'hot' ? 'discussion business active' : (ctx.business.temperature === 'warm' ? 'business déjà évoqué' : 'aucune discussion business'));
  if (ctx.business.presentedRecently) bits.push('mes services ont déjà été présentés récemment');
  return bits.join(' ; ') + '.';
}

module.exports = { analyze, summarize, tokens, BUSINESS_RE, _memo: memo };
