// Analyseur Spintax : { option1 | option2 | option3 } -> une option choisie
// au hasard, re-tirée à CHAQUE appel. Appelé une fois par destinataire dans
// les moteurs de campagne (voir queues/campaignEngine.js et
// queues/telegramCampaignEngine.js) juste avant l'envoi effectif, pour que
// deux destinataires ne reçoivent quasiment jamais le texte identique mot
// pour mot — utile pour rester sous les radars anti-spam de WhatsApp/Telegram,
// qui pénalisent l'envoi en masse d'un contenu strictement identique.
//
// Ne traite QUE les blocs contenant au moins un "|" : un bloc sans "|" (ex:
// "{nom}") n'est pas du Spintax mais une variable de personnalisation (voir
// lib/whatsappRecipients.js#replaceVariables) et doit rester intact. Les
// points d'appel substituent donc TOUJOURS les variables ({nom}) AVANT
// d'appeler resolveSpintax() : sans cet ordre, un Spintax imbriqué autour
// d'une variable (ex: "{Bonjour {nom}|Salut {nom}}") ne pourrait jamais être
// reconnu comme "le plus interne" tant que "{nom}" (jamais résolu par ce
// module) reste entre ses accolades.
//
// Algorithme : à chaque passe, remplace tous les blocs "les plus internes"
// (une accolade ouvrante, du contenu sans autre accolade, une accolade
// fermante) qui contiennent un "|" par une option choisie au hasard — ce qui
// expose progressivement les blocs englobants aux passes suivantes, jusqu'à
// ce qu'il n'en reste plus. Supporte donc nativement les Spintax imbriqués
// sur plusieurs niveaux (ex: "{Bonjour|{Salut|Hello} {nom}}").
const INNERMOST_BLOCK_REGEX = /\{([^{}]*)\}/g;

// Garde-fou contre une entrée malformée (accolades non appariées, ex:
// "{a|b" sans fermeture) qui ne convergerait jamais vers un texte stable :
// un message légitime n'a jamais plus d'une poignée de niveaux d'imbrication,
// donc ce plafond n'est jamais atteint en usage normal.
const MAX_PASSES = 25;

function resolveSpintax(text) {
  if (typeof text !== 'string' || !text.includes('{')) {
    return text;
  }

  let result = text;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    let changed = false;
    result = result.replace(INNERMOST_BLOCK_REGEX, (match, inner) => {
      if (!inner.includes('|')) {
        return match; // pas un bloc Spintax (variable ou accolades vides) : intact
      }
      changed = true;
      const options = inner.split('|');
      return options[Math.floor(Math.random() * options.length)];
    });
    if (!changed) break;
  }

  return result;
}

module.exports = { resolveSpintax };
