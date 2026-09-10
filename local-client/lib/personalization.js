// Personnalisation des messages de campagne : variables dynamiques
// ({first_name}, {name}, {username}, et les alias historiques {nom}/{prenom})
// combinées au Spintax (voir lib/spintax.js). Partagé par les deux moteurs de
// campagne (queues/campaignEngine.js pour WhatsApp, queues/telegramCampaignEngine.js
// pour Telegram) et par la programmation multi-canal (index.js), pour que les
// deux canaux se comportent exactement de la même façon.
const { resolveSpintax } = require('./spintax');

// Jeton de protection (caractère de contrôle ASCII 0x01, jamais tapé dans un
// message normal) utilisé le temps de résoudre le Spintax — voir
// personalizeMessage.
const PROTECT_TOKEN = '\u0001';

// Marqueur temporaire (caractère de contrôle ASCII 0x02) posé à la place
// d'une balise sans valeur, le temps du nettoyage ciblé qui suit — voir
// replaceVariables. Évite qu'un nettoyage global des espaces avant
// ponctuation n'altère aussi une espace française légitime déjà présente
// ailleurs dans le message (ex: "Comment allez-vous ?"), qui elle n'a rien à
// voir avec une balise absente.
const REMOVED_MARK = '\u0002';

// Variable de personnalisation ({first_name}, etc.) : une clé absente, nulle
// ou vide est remplacée par une chaîne vide, ET l'espace qui précédait
// immédiatement la balise est retiré avec elle si elle colle à une
// ponctuation ou à la fin du message — un message "Bonjour {first_name},"
// sans prénom connu doit devenir "Bonjour," et non "Bonjour ," (espace
// orphelin) ni "Bonjour null,". Au milieu d'une phrase (ex: "Salut
// {first_name} (voir profil)"), cette même espace est conservée pour ne pas
// coller deux mots ("Salutvoir"). Le nettoyage ne touche que le voisinage
// immédiat d'une balise effectivement retirée (voir REMOVED_MARK), jamais le
// reste du message (pas de ponctuation française légitime déjà précédée
// d'une espace, ex: "Comment allez-vous ?").
function replaceVariables(template, vars) {
  const row = vars || {};
  const marked = String(template).replace(/([ \t]*)\{(\w+)\}/g, (match, leadingSpace, key) => {
    const value = row[key];
    if (value !== undefined && value !== null && value !== '') {
      return `${leadingSpace}${String(value)}`;
    }
    return leadingSpace ? ` ${REMOVED_MARK}` : REMOVED_MARK;
  });

  // Répété jusqu'à stabilité : plusieurs balises vides consécutives (ex:
  // "{first_name} {username}, bonjour") ne se retrouvent collées à la
  // ponctuation qu'une fois le marqueur voisin déjà retiré au tour précédent.
  let cleaned = marked;
  let previous;
  do {
    previous = cleaned;
    cleaned = cleaned.replace(new RegExp(`[ \\t]*${REMOVED_MARK}[ \\t]*(?=[,.;:!?]|$)`, 'g'), '');
  } while (cleaned !== previous);

  return cleaned
    // Marqueur restant en milieu de phrase : une seule espace de séparation,
    // l'aplatissement ci-dessous absorbe le doublon avec l'espace déjà
    // présente de l'autre côté dans le gabarit d'origine.
    .replace(new RegExp(REMOVED_MARK, 'g'), ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Construit le jeu de variables d'un destinataire à partir de son nom (déjà
// résolu — import Excel, cache de contact, ou vide si inconnu/profil masqué)
// et de son identifiant (numéro WhatsApp, username/téléphone Telegram) : la
// colonne prénom/nom d'un import alimente {first_name}/{name} (et les alias
// historiques {nom}/{prenom}), la colonne identifiant alimente {username} —
// voir /api/contacts/import et /api/telegram/contacts/import.
function buildPersonalizationVars(name, identifier) {
  const cleanName = name ? String(name).trim() : '';
  const cleanIdentifier = identifier !== undefined && identifier !== null && identifier !== ''
    ? String(identifier).trim()
    : '';
  return {
    nom: cleanName,
    prenom: cleanName,
    first_name: cleanName,
    name: cleanName,
    username: cleanIdentifier,
  };
}

// Résout le Spintax PUIS remplace les variables de personnalisation (ordre
// demandé : le prénom doit apparaître dans le texte définitivement choisi par
// le tirage Spintax, pas l'inverse). Les balises de variable ({\w+}, sans
// "|") sont protégées avant la résolution du Spintax puis restituées après :
// resolveSpintax ne reconnaît un bloc Spintax "le plus interne" que s'il ne
// contient aucune autre accolade (voir lib/spintax.js) — un Spintax imbriqué
// autour d'une variable (ex: "{Bonjour {first_name}|Salut {first_name}}") ne
// serait donc jamais résolu si la balise restait telle quelle pendant le
// tirage.
function personalizeMessage(template, vars) {
  if (typeof template !== 'string' || !template) {
    return template || '';
  }

  const placeholders = [];
  const protectedText = template.replace(/\{(\w+)\}/g, (match, key) => {
    placeholders.push(key);
    return `${PROTECT_TOKEN}${placeholders.length - 1}${PROTECT_TOKEN}`;
  });

  const spun = resolveSpintax(protectedText);

  const restored = spun.replace(
    new RegExp(`${PROTECT_TOKEN}(\\d+)${PROTECT_TOKEN}`, 'g'),
    (match, idx) => `{${placeholders[idx]}}`,
  );

  return replaceVariables(restored, vars);
}

module.exports = {
  replaceVariables,
  buildPersonalizationVars,
  personalizeMessage,
};
