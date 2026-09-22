// Analyse d'une instruction de configuration de campagne Facebook Ads donnée au Chat Intelligent.
// Le MESSAGE INITIAL est extrait de façon DÉTERMINISTE (jamais par l'IA) pour rester exact au caractère près.
// L'IA (optionnelle) ne sert qu'aux champs annexes (nom de campagne, produit, dates, identifiants d'annonce).

const OPEN_CLOSE = [['«', '»'], ['“', '”'], ['"', '"'], ['„', '“']];

// Blocs entre guillemets, avec leur position (imbrication non gérée : le premier fermant valide).
function quotedBlocks(text) {
  const s = String(text || '');
  const out = [];
  let i = 0;
  while (i < s.length) {
    const pair = OPEN_CLOSE.find(([o]) => s[i] === o);
    if (!pair) { i += 1; continue; }
    // Guillemets asymétriques (« » “ ”) : on tient compte de l'imbrication, un « OK » dans le message ne le ferme pas.
    let close = -1;
    if (pair[0] !== pair[1]) {
      let depth = 0;
      for (let j = i; j < s.length; j += 1) {
        if (s[j] === pair[0]) depth += 1;
        else if (s[j] === pair[1]) { depth -= 1; if (depth === 0) { close = j; break; } }
      }
    } else {
      close = s.indexOf(pair[1], i + 1);
    }
    if (close < 0) { i += 1; continue; }
    const inner = s.slice(i + 1, close);
    // Un guillemet droit isolé dans un mot (ex. l'apostrophe typographique) n'ouvre pas un bloc.
    // Espaces (dont insécables) autour du texte, typiques des guillemets français « … », retirés ; le contenu reste intact.
    if (inner.trim()) out.push({ start: i, end: close + 1, text: inner.replace(/^[\s  ]+|[\s  ]+$/g, '') });
    i = close + 1;
  }
  return out;
}

const MESSAGE_MARKER = /(?:exactement\s+(?:ce|le|ledit)\s+(?:texte|message)|(?:ce|le)\s+(?:texte|message)\s+(?:suivant|pr[ée]par[ée]|ci[- ]dessous)|(?:mon|le)\s+message\s+(?:d[’']accueil|initial|automatique|pr[ée]par[ée])|message\s+pr[ée]par[ée]|texte\s+pr[ée]par[ée]|le\s+message\s+suivant|ce\s+texte|ce\s+message)\s*(?:est|:|-|→|=|\bà\s+envoyer)?\s*:?\s*/i;
// Fin du message = début de la consigne suivante. Sur une nouvelle ligne : « Ensuite… » suffit ; dans la même phrase, il faut
// un verbe de consigne (« Ensuite, continue… ») pour ne pas couper un message qui contiendrait lui-même « Ensuite ».
const STOP_AFTER = /(?:\n\s*(?:ensuite|puis|apr[èe]s\s+(?:[çc]a|cela|ce\s+message)|et\s+(?:ensuite|apr[èe]s)|continue|poursuis)\b|(?<=[.!?…])\s+(?:ensuite|puis|apr[èe]s\s+(?:[çc]a|cela|ce\s+message)|et\s+(?:ensuite|apr[èe]s))\s*,?\s*(?:continue|poursuis|reprends|laisse|discute|r[ée]ponds)\b)[\s\S]*$/i;

// Retourne { message, entryMessages, source } ; message = null si introuvable (l'appelant le demande à l'utilisateur).
function extractInitialMessage(text) {
  const s = String(text || '');
  const blocks = quotedBlocks(s);
  const marker = s.match(MESSAGE_MARKER);
  const markerEnd = marker ? marker.index + marker[0].length : -1;

  // 1) bloc entre guillemets qui SUIT le marqueur « exactement ce texte : »
  if (markerEnd >= 0) {
    const after = blocks.find((b) => b.start >= marker.index && b.start <= markerEnd + 6);
    if (after) return { message: after.text, entryMessages: blocks.filter((b) => b !== after).map((b) => b.text), source: 'quoted_after_marker' };
    // 2) texte libre après le marqueur (jusqu'à « Ensuite, … »)
    let rest = s.slice(markerEnd);
    rest = rest.replace(STOP_AFTER, '').trim();
    rest = rest.replace(/^\[([\s\S]*)\]$/, '$1').trim(); // [MESSAGE …] entre crochets
    if (rest.length >= 3) return { message: rest, entryMessages: blocks.map((b) => b.text), source: 'free_after_marker' };
  }
  // 3) crochets explicites : [ … ] contenant plus que quelques mots
  const br = s.match(/\[([^\]]{12,})\]/);
  if (br && !/^\s*MESSAGE\s+FOURNI/i.test(br[1])) return { message: br[1].trim(), entryMessages: blocks.map((b) => b.text), source: 'brackets' };
  // 4) plusieurs blocs entre guillemets : le plus long est le message, les autres sont les messages d'entrée
  if (blocks.length >= 2) {
    const sorted = blocks.slice().sort((a, b) => b.text.length - a.text.length);
    return { message: sorted[0].text, entryMessages: blocks.filter((b) => b !== sorted[0]).map((b) => b.text), source: 'longest_quoted' };
  }
  return { message: null, entryMessages: blocks.map((b) => b.text), source: null };
}

// Période « cette semaine / ce mois / du 12 au 18 septembre 2026 / jusqu'au 30/09 » -> { startAt, endAt } (ms) ou null.
function endOfDay(d) { const x = new Date(d); x.setHours(23, 59, 59, 999); return x.getTime(); }
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); }
function detectPeriod(text, now) {
  const n = String(text || '').toLowerCase();
  const base = new Date(now || Date.now());
  if (/cette\s+semaine/.test(n)) {
    const day = (base.getDay() + 6) % 7; // lundi = 0
    const mon = new Date(base); mon.setDate(base.getDate() - day);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    return { startAt: startOfDay(mon), endAt: endOfDay(sun), label: 'cette semaine' };
  }
  if (/(ce\s+mois|ce\s+mois-ci)/.test(n)) {
    const first = new Date(base.getFullYear(), base.getMonth(), 1);
    const last = new Date(base.getFullYear(), base.getMonth() + 1, 0);
    return { startAt: startOfDay(first), endAt: endOfDay(last), label: 'ce mois' };
  }
  if (/aujourd.?hui/.test(n)) return { startAt: startOfDay(base), endAt: endOfDay(base), label: "aujourd'hui" };
  return null;
}

module.exports = { quotedBlocks, extractInitialMessage, detectPeriod };
