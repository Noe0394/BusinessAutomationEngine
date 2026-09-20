// Classifieur d'intention conversationnelle (FR) : déterministe, mots entiers,
// négation locale. Complété (si ambigu) par arbitrate() qui interroge l'IA.

const INTENTS = [
  'INTEREST', 'QUESTION', 'REQUEST_INFORMATION', 'PURCHASE_INTENT', 'PAYMENT_INTENT',
  'REFUSAL', 'DISINTEREST', 'HESITATION', 'OBJECTION', 'PRICE_OBJECTION',
  'REQUEST_MORE_INFORMATION', 'REQUEST_TIME', 'LATER', 'STOP', 'CONFIRMATION',
  'CANCELLATION', 'GREETING', 'THANKS', 'COMPLAINT', 'SUPPORT', 'UNKNOWN',
];

const NEGATIVE = new Set(['REFUSAL', 'DISINTEREST', 'STOP', 'CANCELLATION']);

function norm(text) {
  return String(text == null ? '' : text)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`´]/g, ' ')
    .replace(/[^a-z0-9?!\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const R = (src) => new RegExp(`(?:^|\\s)(?:${src})(?=\\s|$|[?!])`);

const P = {
  stop: R('stop|ne m ecrivez plus|ne m ecris plus|ne me contactez plus|ne me contacte plus|ne me relancez plus|desabonn\\w*|desinscri\\w* moi|retirez moi|supprimez moi|arretez( de m ecrire)?|spam'),
  refusal: R('non merci|merci non|j ai dit non|je te dis non|je vous dis non|c est non|je ne veux pas|je veux pas|non non|absolument pas|certainement pas|jamais|non'),
  disinterest: R('pas interess\\w*|plus interess\\w*|ne m interesse pas|ca ne m interesse pas|ne m interesse plus|pas pour moi|pas besoin|aucun interet|pas ce que je cherche|pas ce qu il me faut|deja trouve\\w*|j ai deja (?:une?|trouve|pris|ce qu il faut)|pas interessant|sans interet|ne suis pas preneur|pas preneur'),
  cancellation: R('annul\\w*|je me desinscris|je veux me desinscrire|resilier|resiliation|remboursez|remboursement'),
  complaint: R('inadmissible|scandale|mecontent\\w*|pas satisfait\\w*|decu\\w*|honteux|arnaque|escroquerie|vous m avez menti|je suis furieu\\w*|c est nul|catastrophe|ras le bol'),
  payment: R('je paie|je paye|je vais payer|comment payer|comment (?:je )?paie|mode de paiement|moyens? de paiement|numero (?:de |pour )?(?:paiement|payer|depot)|orange money|mobile money|moov money|wave|mtn money|lien de paiement|j ai paye|j ai effectue le paiement|paiement effectue|j ai envoye l argent|j ai fait le depot|je fais le depot|virement'),
  purchase: R('je m inscris|je veux (?:bien )?(?:m inscrire|acheter|commander|prendre|participer|rejoindre|souscrire|reserver|payer)|je voudrais (?:bien )?(?:m inscrire|acheter|commander|prendre|participer|rejoindre|souscrire|reserver)|j aimerais (?:bien )?(?:m inscrire|acheter|commander|prendre|participer|rejoindre|souscrire|reserver)|je souhaite (?:m inscrire|acheter|commander|prendre|participer|rejoindre|souscrire|reserver)|inscrivez moi|inscris moi|je prends|je commande|je suis partant\\w*|je veux en profiter|je veux la formation|je la prends|ok je (?:prends|m inscris|commande)'),
  priceObjection: R('trop cher|c est cher|tres cher|pas dans mon budget|hors budget|pas les moyens|je n ai pas (?:les moyens|assez d argent|l argent)|budget|moins cher|reduction|reduire le prix|baisser le prix|remise|rabais|facilite de paiement|payer en plusieurs fois|par tranches?'),
  objection: R('pas sur\\w*|j hesite|je doute|confiance|garantie|est ce que ca marche|ca marche vraiment|pas le temps|pas convaincu\\w*|je ne suis pas convaincu\\w*|je ne crois pas|preuve|temoignage|sceptique'),
  hesitation: R('je vais (?:y )?reflechir|laissez moi reflechir|laisse moi reflechir|je reflechis|je vais y penser|laissez moi y penser|peut etre|je ne sais pas|je sais pas|je vais voir|a voir|demander a (?:mon|ma|mes) \\w+|en parler (?:a|avec) \\w+|consulter (?:mon|ma|mes) \\w+|voir avec (?:mon|ma|mes) \\w+|je verrai'),
  later: R('plus tard|demain|apres demain|la semaine prochaine|le mois prochain|en fin de mois|fin du mois|ce week end|dans quelques jours|je reviens vers vous|je reviendrai|je vous recontacte|je vous recontacterai|quand j aurai|pas maintenant|pas aujourd hui|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|ce soir|cet apres midi'),
  requestTime: R('donnez moi (?:un peu de )?temps|laissez moi (?:un peu de )?temps|un peu de temps|attendez|patientez|une minute|un instant|un moment'),
  support: R('je n arrive pas|j arrive pas|ne marche pas|marche pas|ne fonctionne pas|fonctionne pas|mot de passe|connexion|acces|lien ne|je ne recois pas|pas recu|bug|erreur|aide moi|besoin d aide|probleme'),
  interest: R('interess\\w*|ca m interesse|j aime|ca me plait|super|genial|excellent|top|parfait|je suis chaud|j adore|hate de'),
  thanks: R('merci(?: beaucoup| bien| infiniment)?|thanks|thank you|je vous remercie'),
  confirm: R('oui|ouais|ok|okay|d accord|dac|entendu|c est bon|bien recu|ca marche|exact|tout a fait|compris|j ai compris|c est note|note'),
  greeting: R('bonjour|bonsoir|salut|hello|hey|coucou|bjr|bsr|salam|salut a vous'),
  moreInfo: R('plus d info\\w*|plus de details|davantage|en savoir plus|plus de precisions?|expliquez moi plus|dites moi en plus|dites m en plus|detaille\\w*'),
  info: R('renseign\\w*|informations?|infos?|details?|presentation|programme|contenu|modules?|expliqu\\w*|c est quoi|de quoi s agit|en quoi consiste'),
  repeatComplaint: R('(?:ca )?fait (?:deja )?\\w+ fois|je (?:vous )?(?:l ai |te l ai )?(?:deja )?(?:demande|dit|repete)\\w* (?:deja|encore|plusieurs fois)|j ai (?:deja )?(?:demande|dit|ecrit)|vous ne repondez pas|pas de reponse|vous n avez pas repondu|encore la meme|toujours la meme'),
};

const TOPICS = [
  ['price', /(?:^|\s)(?:prix|tarif\w*|combien|cout\w*|coute\w*|montant|c est combien|frais)(?=\s|$|[?!])/],
  ['schedule', /(?:^|\s)(?:date|quand|horaire\w*|heure|debut|commence\w*|session|prochaine|duree|calendrier)(?=\s|$|[?!])/],
  ['enrollment', /(?:^|\s)(?:inscri\w+|s inscrire|inscription|s enregistrer|reserv\w+)(?=\s|$|[?!])/],
  ['payment', /(?:^|\s)(?:paiement|payer|regler|reglement|paye)(?=\s|$|[?!])/],
  ['delivery', /(?:^|\s)(?:livraison|livrer|livre|expedition|retrait)(?=\s|$|[?!])/],
  ['format', /(?:^|\s)(?:en ligne|presentiel|distance|zoom|whatsapp|visio|video)(?=\s|$|[?!])/],
  ['location', /(?:^|\s)(?:ou|lieu|adresse|localisation|ville)(?=\s|$|[?!])/],
];

const QUESTION_START = /^(?:comment|quand|ou|quel|quelle|quels|quelles|combien|pourquoi|est ce|y a t il|avez vous|vous faites|faites vous|peut on|puis je|je peux|c est quoi|qu est ce|quoi|qui|est il|est elle|c est combien)(?:\s|$)/;

function has(re, s) { return re.test(s); }

function detectTopics(n) {
  return TOPICS.filter(([, re]) => re.test(n)).map(([t]) => t);
}

// Retourne { intent, intents[], flags, confidence, needsArbitration }
function classify(text, opts) {
  const n = norm(text);
  const o = opts || {};
  const flags = {
    question: /\?/.test(String(text || '')) || QUESTION_START.test(n),
    topics: detectTopics(n),
    deferral: null,
    repeatComplaint: has(P.repeatComplaint, n),
    greeting: has(P.greeting, n),
    topicChange: /(?:^|\s)(?:finalement|en fait|sinon|au fait|autre chose)(?=\s|$|,)/.test(n),
    understood: /(?:j ai compris|compris|c est note|bien recu)/.test(n),
    negative: false,
  };
  if (!n) return { intent: 'UNKNOWN', intents: ['UNKNOWN'], flags, confidence: 0, needsArbitration: false };

  const hit = new Set();
  if (has(P.stop, n)) hit.add('STOP');
  if (has(P.disinterest, n)) hit.add('DISINTEREST');
  if (has(P.refusal, n)) hit.add('REFUSAL');
  if (has(P.cancellation, n)) hit.add('CANCELLATION');
  if (has(P.complaint, n)) hit.add('COMPLAINT');
  if (has(P.payment, n)) hit.add('PAYMENT_INTENT');
  if (has(P.purchase, n)) hit.add('PURCHASE_INTENT');
  if (has(P.priceObjection, n)) hit.add('PRICE_OBJECTION');
  if (has(P.objection, n)) hit.add('OBJECTION');
  if (has(P.hesitation, n)) hit.add('HESITATION');
  if (has(P.later, n)) hit.add('LATER');
  if (has(P.requestTime, n)) hit.add('REQUEST_TIME');
  if (has(P.support, n)) hit.add('SUPPORT');
  if (has(P.moreInfo, n)) hit.add('REQUEST_MORE_INFORMATION');
  if (has(P.info, n) || (flags.question && flags.topics.length)) hit.add(flags.question ? 'QUESTION' : 'REQUEST_INFORMATION');
  else if (flags.question) hit.add('QUESTION');
  if (has(P.interest, n) && !hit.has('DISINTEREST')) hit.add('INTEREST');
  if (has(P.confirm, n)) hit.add('CONFIRMATION');
  if (has(P.thanks, n)) hit.add('THANKS');
  if (flags.greeting) hit.add('GREETING');

  // "non" seul mot d'un message plus long ("non, je veux m'inscrire") : pas un refus
  if (hit.has('REFUSAL') && !/(?:^|\s)(?:non merci|merci non|j ai dit non|je te dis non|je vous dis non|c est non|je ne veux pas|je veux pas|absolument pas|certainement pas)(?=\s|$|[?!])/.test(n)) {
    const bare = /^non[\s!.]*$/.test(n);
    if (!bare && (hit.has('PURCHASE_INTENT') || hit.has('QUESTION') || hit.has('INTEREST') || hit.has('PAYMENT_INTENT'))) hit.delete('REFUSAL');
  }
  // "je ne veux pas" suivi d'un objet de prix : plutôt une objection
  if (hit.has('REFUSAL') && hit.has('PRICE_OBJECTION') && !/(?:non merci|j ai dit non|c est non)/.test(n)) hit.delete('REFUSAL');
  // "j'ai déjà trouvé" + question = pas un refus net
  if (hit.has('DISINTEREST') && flags.question && !/pas interess|plus interess|ne m interesse/.test(n)) hit.delete('DISINTEREST');

  const order = [
    'STOP', 'REFUSAL', 'DISINTEREST', 'CANCELLATION', 'COMPLAINT', 'PAYMENT_INTENT', 'PURCHASE_INTENT',
    'PRICE_OBJECTION', 'OBJECTION', 'HESITATION', 'REQUEST_TIME', 'LATER', 'SUPPORT',
    'QUESTION', 'REQUEST_MORE_INFORMATION', 'REQUEST_INFORMATION', 'INTEREST', 'CONFIRMATION', 'THANKS', 'GREETING',
  ];
  const intents = order.filter((i) => hit.has(i));

  // Un report ("demain") accompagne un achat/paiement ; seul, c'est LATER
  if (hit.has('LATER')) {
    const m = n.match(/(demain|apres demain|la semaine prochaine|le mois prochain|fin du mois|en fin de mois|ce week end|ce soir|cet apres midi|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|plus tard|dans quelques jours)/);
    flags.deferral = m ? m[1] : 'plus tard';
  }
  // "Ça fait trois fois que je demande le prix" : la question prime sur la plainte
  if (flags.repeatComplaint && flags.topics.length) {
    if (!hit.has('QUESTION')) intents.unshift('QUESTION');
  } else if (flags.repeatComplaint && !intents.includes('COMPLAINT') && !intents.some((i) => NEGATIVE.has(i))) {
    intents.unshift('COMPLAINT');
  }

  // Mots de politesse seuls : sans autre signal utile
  let primary = intents[0] || 'UNKNOWN';
  if (primary === 'LATER' && intents.includes('HESITATION')) primary = 'HESITATION';
  if (primary === 'GREETING' && intents.length > 1) primary = intents[1];
  if (primary === 'CONFIRMATION' && intents.includes('THANKS') && intents.length === 2) primary = 'CONFIRMATION';
  if (primary === 'THANKS' && intents.includes('CONFIRMATION')) primary = 'CONFIRMATION';

  flags.negative = NEGATIVE.has(primary);
  if (o.state && o.state.state === 'REFUSED' && primary === 'CONFIRMATION') primary = 'CONFIRMATION';

  const conflict = (hit.has('REFUSAL') || hit.has('DISINTEREST')) && (hit.has('PURCHASE_INTENT') || hit.has('PAYMENT_INTENT') || hit.has('INTEREST'));
  const confidence = primary === 'UNKNOWN' ? 0.2 : (conflict ? 0.45 : (n.length < 4 ? 0.5 : 0.85));
  return { intent: primary, intents: intents.length ? intents : ['UNKNOWN'], flags, confidence, needsArbitration: primary === 'UNKNOWN' || conflict };
}

function extractJson(raw) {
  const s = String(raw || '');
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

// L'IA tranche uniquement les cas ambigus. STOP déterministe reste toujours prioritaire.
async function arbitrate({ text, history, llm, base }) {
  if (!llm || !base || base.intents.includes('STOP')) return base;
  const hist = Array.isArray(history) ? history.slice(-6).map((h) => `${h.direction === 'out' ? 'Vendeur' : 'Client'}: ${h.text}`).join('\n') : '';
  const prompt = [
    'Tu classes l\'intention du DERNIER message d\'un client. Réponds UNIQUEMENT en JSON: {"intent":"<UNE valeur>","deferral":null|"texte du report"}.',
    `Valeurs autorisées: ${INTENTS.join(', ')}.`,
    'Règles: un refus explicite (non merci, pas intéressé) = REFUSAL/DISINTEREST; "je vais réfléchir" = HESITATION; "demain/plus tard" avec envie d\'acheter = PURCHASE_INTENT + deferral; ne confonds jamais hésitation et paiement.',
    hist ? `Historique récent:\n${hist}` : '',
    `Dernier message du client: "${String(text).slice(0, 500)}"`,
  ].filter(Boolean).join('\n');
  try {
    const parsed = extractJson(await llm(prompt));
    if (!parsed || !INTENTS.includes(parsed.intent)) return base;
    const intents = [parsed.intent].concat(base.intents.filter((i) => i !== parsed.intent && i !== 'UNKNOWN'));
    const flags = Object.assign({}, base.flags, { deferral: parsed.deferral || base.flags.deferral, negative: NEGATIVE.has(parsed.intent) });
    return { intent: parsed.intent, intents, flags, confidence: 0.75, needsArbitration: false, arbitrated: true };
  } catch (e) {
    return base;
  }
}

module.exports = { INTENTS, NEGATIVE, classify, arbitrate, norm };
