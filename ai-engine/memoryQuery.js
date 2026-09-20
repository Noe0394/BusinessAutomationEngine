// Questions du Chat Intelligent sur la mémoire 7×24 h : période exacte, contact, sujet ; réponse FACTUELLE (dates, heures,
// noms, extraits) avec l'étendue réelle de la mémoire. Aucun chiffre ni citation n'est inventé : tout vient des messages
// enregistrés ; l'IA n'est utilisée que pour résumer un extrait fourni, avec repli déterministe.
const messageHistory = require('./messageHistory');
const contactIdentity = require('./contactIdentity');
const { norm } = require('./jarvis/intentClassifier');

const DAY = 24 * 3600 * 1000;
const tzOffsetMs = () => (parseFloat(process.env.RECURRING_TZ_OFFSET_HOURS) || 0) * 3600 * 1000;

// Minuit local (selon RECURRING_TZ_OFFSET_HOURS) du jour `daysAgo`.
function localMidnight(now, daysAgo) {
  const local = now + tzOffsetMs();
  const start = local - (((local % DAY) + DAY) % DAY);
  return start - daysAgo * DAY - tzOffsetMs();
}

function fmt(ts) {
  const d = new Date(ts + tzOffsetMs());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} à ${p(d.getUTCHours())}h${p(d.getUTCMinutes())}`;
}

function parsePeriod(text, now) {
  const n = norm(text);
  const t = now == null ? Date.now() : now;
  let m;
  if (/(?:^| )avant hier(?: |$)/.test(n)) return { from: localMidnight(t, 2), to: localMidnight(t, 1) - 1, label: 'avant-hier' };
  if (/(?:^| )hier(?: |$)/.test(n)) return { from: localMidnight(t, 1), to: localMidnight(t, 0) - 1, label: 'hier' };
  if (/(?:^| )aujourd hui(?: |$)|(?:^| )ce matin(?: |$)|(?:^| )ce jour(?: |$)/.test(n)) return { from: localMidnight(t, 0), to: t, label: 'aujourd\'hui' };
  if ((m = n.match(/il y a (\d{1,2}) jours?/))) { const k = Number(m[1]); return { from: localMidnight(t, k), to: localMidnight(t, k - 1) - 1, label: `il y a ${k} jours` }; }
  if ((m = n.match(/(\d{1,2}) derniers? jours?/))) { const k = Math.min(7, Number(m[1])); return { from: t - k * DAY, to: t, label: `les ${k} derniers jours` }; }
  if (/cette semaine|sept derniers jours|semaine derniere|7 jours/.test(n)) return { from: t - 7 * DAY, to: t, label: 'les 7 derniers jours' };
  return { from: t - 7 * DAY, to: t, label: 'les 7 derniers jours', implicit: true };
}

function parseTarget(text) {
  const q = String(text || '').match(/[«"“]([^»"”]{2,60})[»"”]/);
  if (q) return { name: q[1].trim() };
  const phone = String(text || '').match(/\+?\d[\d\s().-]{6,}\d/);
  if (phone) return { phone: phone[0].replace(/\D/g, '') };
  const who = String(text || '').match(/(?:qu['’]|que\s+|est-ce que\s+)([A-ZÉÈÀÂÎÔÛ][\wÀ-ÿ'’-]{1,}(?:\s+[A-ZÉÈÀÂÎÔÛ][\wÀ-ÿ'’-]{1,})?)\s+(?:m['’]a|m['’]ont|a|ont)\s/);
  if (who) return { name: who[1].trim() };
  const nm = String(text || '').match(/(?:avec|de|du|d['’]|chez|pour|à|a)\s+([A-ZÉÈÀÂÎÔÛ][\wÀ-ÿ'’-]{1,}(?:\s+[A-ZÉÈÀÂÎÔÛ][\wÀ-ÿ'’-]{1,})?)/);
  if (nm && !/^(Hier|Aujourd|Avant|Cette|Telegram|WhatsApp|Cyrus)/.test(nm[1])) return { name: nm[1].trim() };
  return {};
}

const TOPIC_SYNONYMS = [
  [/prix|tarif|co[uû]t|combien/, ['prix', 'tarif', 'cout', 'coute', 'combien', 'fcfa']],
  [/inscri/, ['inscri', 'inscription', 'm inscrire', 'participer']],
  [/paiement|payer|payé/, ['paiement', 'payer', 'paye', 'orange money', 'mobile money', 'wave', 'virement']],
  [/formation/, ['formation', 'cours', 'module']],
];
function parseTopic(text) {
  const n = norm(text);
  const m = n.match(/(?:parle|parlent|parle de|concernant|au sujet de|a propos de|demande|demande le|mentionn\w*)\s+(?:de |du |des |d |la |le |les |l )?([a-z0-9' ]{3,40}?)(?: hier| aujourd| cette| avant|$| \?|\?)/);
  const raw = m ? m[1].trim() : '';
  if (!raw) return null;
  for (const [re, words] of TOPIC_SYNONYMS) if (re.test(raw)) return { label: raw, words };
  return { label: raw, words: [raw] };
}

function detectKind(text) {
  const n = norm(text);
  if (/combien de/.test(n)) return 'COUNT';
  if (/(^| )qui (m a|a|m ont|ont|est ce qui)/.test(n) && /parle|ecrit|demande|contacte|repondu/.test(n)) return 'WHO';
  if (/resum/.test(n)) return 'SUMMARY';
  if (/qu est ce (que|qu)|que m a|ce que .* (a|ont) (dit|ecrit)|m a dit|m a ecrit/.test(n)) return 'SAID';
  if (/(^| )(\d+) (dernieres?|derniers?) (discussions?|conversations?|messages?)/.test(n) || /liste/.test(n)) return 'LIST';
  return 'LAST';
}

const isMemoryQuestion = (text) => {
  const n = norm(text);
  return /(retrouve|cherche|recherche|montre|affiche|donne|liste|resume|rappelle)[^?!.]{0,60}(discussion|conversation|message|echange)/.test(n)
    || /(^| )(derniere|dernier|dernieres|derniers) (discussion|conversation|echange)/.test(n)
    || /qu est ce (que|qu)[^?!.]{0,60}(m a|m ont|a|ont) (dit|ecrit|demande|repondu|envoye)/.test(n)
    || /(^| )qui (m a|a|m ont|ont) (parle|ecrit|demande|contacte|repondu)/.test(n)
    || /combien de [^?!.]{0,50}(ont|a) (demande|ecrit|parle|repondu|contacte)/.test(n)
    || /(discussion|conversation)s? (avec|de|d)[^?!.]{0,40}(hier|aujourd|avant hier|cette semaine)/.test(n);
};

// Nom lisible d'un contact : jamais un JID/LID brut ni un ancien « numéro » qui serait en réalité un LID
// (voir ai-engine/contactIdentity.js). Le numéro n'est affiché que s'il vient d'un vrai JID téléphonique.
function nameOf(m) {
  const uname = m.channel === 'TELEGRAM' && m.number && !/^\d+$/.test(String(m.number)) ? m.number : null;
  return contactIdentity.resolveIdentity({ channel: m.channel, jid: m.chatId || m.party, pushName: m.name || m.senderName, username: uname }).label;
}
function excerpt(t, n) { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; }

async function collect(tenant, channels, period) {
  const all = [];
  for (const ch of channels) for (const m of await messageHistory.getSince(tenant, ch)) all.push(Object.assign({ channel: ch }, m));
  const inWindow = all.filter((m) => m.tsMs >= period.from && m.tsMs <= period.to);
  return { all, inWindow };
}

function coverageLine(all) {
  if (!all.length) return 'Mémoire disponible : aucun message enregistré sur les 7 derniers jours.';
  const oldest = Math.min(...all.map((m) => m.tsMs));
  const newest = Math.max(...all.map((m) => m.tsMs));
  const convs = new Set(all.map((m) => `${m.channel}:${m.chatId || m.party}`)).size;
  return `Mémoire disponible : ${all.length} messages, ${convs} discussions, du ${fmt(oldest)} au ${fmt(newest)}.`;
}

function coverageWarning(all, period) {
  if (!all.length) return '';
  const oldest = Math.min(...all.map((m) => m.tsMs));
  return period.from < oldest - 3600 * 1000 ? `Attention : rien n'est enregistré avant le ${fmt(oldest)} (historique antérieur non importé ou non fourni par la plateforme).` : '';
}

function groupByChat(msgs) {
  const map = new Map();
  for (const m of msgs) {
    const key = `${m.channel}:${m.chatId || m.party}`;
    const g = map.get(key) || { key, channel: m.channel, chatId: m.chatId || m.party, name: null, isGroup: !!m.isGroup, groupName: m.groupName || null, messages: [] };
    if (m.direction === 'in' && (m.name || m.senderName) && !g.name) g.name = m.name || m.senderName;
    g.messages.push(m);
    map.set(key, g);
  }
  return Array.from(map.values()).map((g) => Object.assign(g, { label: g.isGroup ? `groupe « ${g.groupName || g.chatId} »` : (g.name || contactIdentity.resolveIdentity({ channel: g.channel, jid: g.chatId }).label), last: g.messages[g.messages.length - 1] }))
    .sort((a, b) => b.last.tsMs - a.last.tsMs);
}

function transcript(msgs, limit) {
  return msgs.slice(-limit).map((m) => `[${fmt(m.tsMs)}] ${m.direction === 'out' ? 'Moi' : nameOf(m)} : ${excerpt(m.text || (m.hasMedia ? '[média]' : ''), 220)}`).join('\n');
}

async function summarize(llm, ctxText, question) {
  if (!llm) return null;
  const prompt = [
    'Tu résumes UNIQUEMENT à partir de l\'échange fourni ci-dessous (dates et heures incluses). N\'ajoute aucun fait absent de l\'extrait.',
    'Sois précis : qui a dit quoi, quand, ce qui a été demandé/promis, et l\'état actuel. 3 à 6 phrases, français naturel.',
    `Question : ${question}`, `Échange :\n${ctxText}`,
  ].join('\n');
  try { return String(await llm(prompt) || '').trim() || null; } catch (e) { return null; }
}

async function answer(tenant, question, deps) {
  const d = deps || {};
  const now = d.now || Date.now();
  const n = norm(question);
  const channels = /telegram/.test(n) && !/whatsapp/.test(n) ? ['TELEGRAM'] : (/whatsapp/.test(n) && !/telegram/.test(n) ? ['WHATSAPP'] : ['WHATSAPP', 'TELEGRAM']);
  const period = parsePeriod(question, now);
  const target = parseTarget(question);
  const topic = parseTopic(question);
  const kind = detectKind(question);
  const { all, inWindow } = await collect(tenant, channels, period);
  const cov = coverageLine(all);
  const warn = coverageWarning(all, period);
  const foot = [cov, warn].filter(Boolean).join(' ');
  const log = (label) => [{ icon: '🧠', label, status: 'done' }];

  if (!all.length) return { text: `Je n'ai aucun message en mémoire pour l'instant. ${foot}`, actionLog: log('Mémoire vide'), data: { kind, count: 0 } };

  let pool = inWindow;
  let scope = `sur ${period.label}`;
  let targetConvs = null;
  if (target.name || target.phone) {
    const q = target.phone || target.name;
    const digits = String(q).replace(/\D/g, '');
    const nq = messageHistory.normalizeSearch(q);
    const hit = (m) => (digits.length >= 6 ? String(m.number || m.chatId || m.party || '').includes(digits) : messageHistory.normalizeSearch([m.name, m.senderName, m.groupName, m.number, m.chatId].filter(Boolean).join(' ')).includes(nq));
    const chatsMatching = new Set(all.filter(hit).map((m) => `${m.channel}:${m.chatId || m.party}`));
    if (!chatsMatching.size) {
      const recent = groupByChat(all).slice(0, 5).map((g) => g.label).join(', ');
      return { text: `Je ne trouve aucune discussion avec « ${q} » dans la mémoire des 7 derniers jours. Discussions récentes : ${recent}. ${foot}`, actionLog: log('Contact introuvable'), data: { kind, count: 0 } };
    }
    targetConvs = chatsMatching;
    pool = inWindow.filter((m) => chatsMatching.has(`${m.channel}:${m.chatId || m.party}`));
    scope = `avec ${q}, ${period.label}`;
  }
  if (topic) {
    const words = topic.words.map((w) => messageHistory.normalizeSearch(w));
    pool = pool.filter((m) => m.direction === 'in' && words.some((w) => messageHistory.normalizeSearch(m.text).includes(w)));
    scope += `, sujet « ${topic.label} »`;
  }

  if (kind === 'COUNT' || kind === 'WHO') {
    const groups = groupByChat(pool.filter((m) => m.direction === 'in'));
    const people = groups.filter((g) => !g.isGroup);
    if (!groups.length) return { text: `Aucune discussion ne correspond (${scope}). ${foot}`, actionLog: log('Aucun résultat'), data: { kind, count: 0 } };
    const lines = groups.slice(0, 15).map((g) => `• ${g.label} — ${fmt(g.last.tsMs)} : « ${excerpt(g.last.text, 100)} »`);
    const head = kind === 'COUNT' ? `${groups.length} discussion(s) correspondent (${scope}), dont ${people.length} individuelle(s).` : `${groups.length} personne(s)/groupe(s) (${scope}) :`;
    return { text: [head, ...lines, foot].join('\n'), actionLog: log(`${groups.length} discussion(s)`), data: { kind, count: groups.length } };
  }

  if (kind === 'LIST') {
    const m = n.match(/(\d+) (?:dernieres?|derniers?)/);
    const limit = Math.min(30, m ? Number(m[1]) : 10);
    const groups = groupByChat(pool).slice(0, limit);
    if (!groups.length) return { text: `Aucune discussion ${scope}. ${foot}`, actionLog: log('Aucun résultat'), data: { kind, count: 0 } };
    const lines = groups.map((g, i) => `${i + 1}. ${g.label} — ${g.messages.length} msg, dernier ${fmt(g.last.tsMs)} (${g.last.direction === 'out' ? 'moi' : 'eux'}) : « ${excerpt(g.last.text || '[média]', 90)} »`);
    return { text: [`Les ${groups.length} dernières discussions (${scope}) :`, ...lines, foot].join('\n'), actionLog: log(`${groups.length} discussion(s)`), data: { kind, count: groups.length } };
  }

  // LAST / SAID / SUMMARY : une discussion précise (la cible, sinon la plus récente)
  const groups = groupByChat(pool);
  if (!groups.length) return { text: `Aucun message ${scope}. ${foot}`, actionLog: log('Aucun résultat'), data: { kind, count: 0 } };
  const g = groups[0];
  const full = (await collect(tenant, [g.channel], { from: 0, to: now })).all.filter((m) => (m.chatId || m.party) === g.chatId);
  const slice = kind === 'SAID' ? full.filter((m) => m.tsMs >= period.from && m.tsMs <= period.to && (m.direction === 'in')) : full.filter((m) => m.tsMs >= period.from && m.tsMs <= period.to);
  const shown = (slice.length ? slice : full).slice(-40);
  const tr = transcript(shown, 40);
  let body = null;
  if (kind === 'SUMMARY' || kind === 'SAID') body = await summarize(d.llm, tr, question);
  const head = `${kind === 'SUMMARY' ? 'Résumé' : (kind === 'SAID' ? 'Ce que dit' : 'Dernière discussion avec')} ${g.label} (${g.channel === 'TELEGRAM' ? 'Telegram' : 'WhatsApp'}, ${shown.length} message(s), du ${fmt(shown[0].tsMs)} au ${fmt(shown[shown.length - 1].tsMs)}) :`;
  const text = [head, body || tr, groups.length > 1 ? `Autres discussions ${scope} : ${groups.slice(1, 4).map((x) => x.label).join(', ')}.` : '', foot].filter(Boolean).join('\n');
  return { text, actionLog: log(`Discussion : ${g.label}`), data: { kind, count: shown.length, chatId: g.chatId } };
}

// Une demande simple (« qui m'a écrit ? ») reste servie par la boîte de réception ; dès qu'une période, un contact ou un sujet
// est précisé, c'est la mémoire 7 jours qui répond.
function hasSpecifics(text) {
  return !parsePeriod(text).implicit || !!(parseTarget(text).name || parseTarget(text).phone) || !!parseTopic(text);
}

module.exports = { hasSpecifics, answer, isMemoryQuestion, parsePeriod, parseTarget, parseTopic, detectKind, localMidnight, fmt };
