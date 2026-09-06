// Encyclopédie marketing locale : base de connaissances STATIQUE (aucun
// appel réseau, aucune dépendance à une API externe/IA générative) qui
// alimente lib/ai/localCopywriterEngine.js — l'"assistant" du Copywriter
// Studio IA compose ses réponses en piochant/assemblant ce contenu, jamais
// en l'inventant à la volée. Toute mise à jour du savoir-faire métier (une
// nouvelle règle anti-ban, un nouveau framework) passe par ce fichier, pas
// par le moteur de composition — qui reste, lui, un simple assembleur.
//
// Structure : chaque entrée de `topics` porte un `label` (affiché à
// l'utilisateur), des `keywords` (déclenchent la détection d'intention côté
// moteur — voir findTopics) et le contenu structuré propre au sujet.

const topics = {
  facebook_ads: {
    label: 'Facebook & Instagram Ads (Meta)',
    keywords: [
      'facebook ads', 'fb ads', 'meta ads', 'publicité facebook', 'pub facebook',
      'instagram ads', 'boost post', 'campagne facebook', 'ads manager',
    ],
    antiban: [
      "Ne jamais publier une annonce identique sur plusieurs comptes pub le même jour depuis la même IP/le même appareil : Meta corrèle les comptes et peut tous les suspendre en cascade (\"account cluster ban\").",
      "Laisser tourner une nouvelle annonce au moins 24-48h avant toute modification lourde (budget, ciblage, créa) : chaque changement remet l'annonce en phase d'apprentissage et un enchaînement de modifications ressemble, du point de vue de Meta, à un comportement de test agressif.",
      "Éviter le vocabulaire \"avant/après\" trop appuyé, les promesses de résultat garanti, les superlatifs santé/argent non modérés (\"guérit\", \"devenez riche en 7 jours\") : ce sont les déclencheurs les plus fréquents de rejet ou de restriction de diffusion.",
      "Toujours faire vérifier le compte pub (identité professionnelle) et activer la 2FA avant de monter en budget : un compte pub non vérifié qui scale vite est un profil-type de suspension automatique.",
      "Monter le budget progressivement (max +20% tous les 2-3 jours) plutôt que de multiplier brutalement : un scaling trop rapide déclenche à la fois l'algorithme anti-fraude de Meta ET fait perdre l'apprentissage de l'audience.",
    ],
    hooks: [
      "Question directe qui nomme la douleur : \"Vous perdez encore du temps à [tâche pénible] ?\"",
      "Chiffre choc en 3 premiers mots : \"73% des [audience] ignorent ceci...\"",
      "Pattern interrupt visuel + texte contre-intuitif : \"Arrêtez de faire X (voici pourquoi).\"",
      "Preuve sociale immédiate : \"+2 400 [audience] utilisent déjà cette méthode pour [résultat].\"",
      "Curiosité incomplète : \"La raison n°1 pour laquelle votre [problème] ne se résout jamais (ce n'est pas ce que vous croyez).\"",
    ],
    structure: [
      "Hook (1-2 lignes, casse le scroll) → Problème reformulé avec les mots exacts de l'audience → Agitation courte (conséquence si rien ne change) → Solution/Offre → Preuve (avis, chiffre, avant-après conforme aux règles) → Appel à l'action unique et clair.",
      "Une seule offre par publicité — jamais deux CTA concurrents (ex: \"Achetez\" ET \"Contactez-nous\") : ça divise la conversion et complique l'optimisation de l'algorithme.",
      "Texte visible AVANT le \"Voir plus\" : 125 caractères maximum doivent porter tout le message, le reste n'est qu'un complément.",
    ],
    landingPage: [
      "Message match parfait entre l'accroche de l'annonce et le titre H1 de la landing page : un visiteur qui clique doit reconnaître IMMÉDIATEMENT la promesse qu'il vient de voir.",
      "Un seul objectif de conversion par page (achat OU prise de contact OU inscription) — jamais les trois en même temps.",
      "Preuve sociale visible sans scroller (logos clients, nombre d'utilisateurs, note moyenne) : la confiance se joue dans les 3 premières secondes.",
      "Formulaire de contact court (3-4 champs max) pour un marché où la connexion peut être instable (Afrique de l'Ouest notamment) : chaque champ en trop est une perte de conversion mobile.",
    ],
  },

  google_ads: {
    label: 'Google Ads (Search & Display)',
    keywords: [
      'google ads', 'adwords', 'sea', 'campagne google', 'search ads', 'display ads', 'google shopping',
    ],
    antiban: [
      "Respecter scrupuleusement les politiques \"Contenu trompeur\" et \"Pratiques commerciales déloyales\" : Google suspend le COMPTE entier (pas seulement l'annonce) en cas de récidive.",
      "Ne jamais utiliser le nom d'une marque concurrente dans le texte d'annonce sans autorisation — motif de suspension immédiate et fréquente.",
      "Une landing page qui ne correspond pas au produit annoncé (ou en maintenance, ou avec redirections multiples) déclenche un rejet \"Destination non fonctionnelle\".",
      "Le Quality Score (pertinence mot-clé/annonce/page) conditionne le coût par clic réel : une annonce mal alignée coûte littéralement plus cher, indépendamment du budget.",
    ],
    hooks: [
      "Titre 1 = le mot-clé recherché tel quel (correspondance exacte perçue = confiance immédiate).",
      "Titre 2 = bénéfice chiffré ou différenciateur (\"Livraison 24h\", \"-30% ce mois-ci\").",
      "Titre 3 = urgence ou réassurance (\"Stock limité\", \"Satisfait ou remboursé\").",
    ],
    structure: [
      "Structure SKAG-friendly : un groupe d'annonces dédié à un mot-clé (ou une poignée de mots-clés très proches) plutôt qu'un grand fourre-tout — chaque annonce colle exactement à l'intention de recherche.",
      "Description : bénéfice concret + preuve + CTA, dans cet ordre — jamais de remplissage générique.",
      "Extensions d'annonce (sitelinks, accroches, appel) systématiques : elles augmentent la surface cliquable ET le Quality Score sans coût additionnel.",
    ],
    landingPage: [
      "La landing page Search doit répondre à l'intention de recherche en moins de 5 secondes de lecture — pas de storytelling long en haut de page pour du trafic Search (contrairement à une pub Facebook, l'internaute Google est déjà en intention d'achat/action).",
    ],
  },

  tiktok_ads: {
    label: 'TikTok Ads',
    keywords: [
      'tiktok ads', 'pub tiktok', 'spark ads', 'campagne tiktok', 'tiktok business',
    ],
    antiban: [
      "Le format qui \"sent\" la publicité classique (voix off institutionnelle, musique de stock, plan fixe produit) est pénalisé par la distribution organique de l'algorithme ET moins bien accepté en modération — privilégier un format natif filmé au téléphone.",
      "Éviter les promesses financières irréalistes (\"gagnez X€ par jour\") et les avant/après physiques non conformes : motifs de rejet fréquents, en particulier sur les verticales finance/santé/beauté.",
      "Un compte tout neuf qui poste directement une pub à gros budget déclenche une vérification renforcée — laisser le compte \"vivre\" (quelques posts organiques) avant de lancer du Spark Ads dessus.",
    ],
    hooks: [
      "Les 1res 1-2 secondes DOIVENT casser le pattern (mouvement brusque, phrase choc à l'écran, changement de plan) — le pouce qui scroll ne laisse aucune marge d'erreur.",
      "Texte à l'écran dès la 1ère seconde (le son est souvent coupé au début du visionnage) : \"Si tu fais encore ça, arrête tout de suite.\"",
      "Storytelling \"POV\" (point de vue) : \"POV : tu viens de découvrir [solution] et tu regrettes de pas l'avoir su avant.\"",
    ],
    structure: [
      "Hook natif (0-2s) → Problème/situation relatable (2-6s) → Démonstration/preuve (6-15s) → Offre + CTA clair (dernières secondes) — format vertical, sous-titré, rythmé.",
      "Un CTA vocal ET écrit en fin de vidéo (\"Lien en bio\" / \"Commente STOP pour recevoir les détails\") : redondance volontaire, l'attention est fragmentée sur ce format.",
    ],
    landingPage: [
      "Landing page mobile-first obligatoire, chargement en moins de 3 secondes : le trafic TikTok est 100% mobile et très impatient.",
    ],
  },

  closing_frameworks: {
    label: 'Frameworks de vente (AIDA, PAS, Hook-Story-Offer)',
    keywords: [
      'aida', 'pas', 'hook story offer', 'hso', 'framework de vente', 'structure de vente', 'copywriting de vente',
    ],
    aida: {
      name: 'AIDA (Attention, Intérêt, Désir, Action)',
      steps: [
        'Attention : une accroche qui interrompt le scroll ou la routine (chiffre, question, affirmation contre-intuitive).',
        "Intérêt : développer POURQUOI ce sujet concerne spécifiquement le lecteur, avec ses propres mots/situations.",
        'Désir : projeter le résultat concret obtenu (transformation, gain de temps, économie, statut) — pas les caractéristiques du produit, le BÉNÉFICE vécu.',
        "Action : un appel à l'action unique, simple, sans ambiguïté (\"Répondez OUI\", \"Cliquez ici\", \"Écrivez-moi maintenant\").",
      ],
    },
    pas: {
      name: 'PAS (Problème, Agitation, Solution)',
      steps: [
        "Problème : nommer précisément la douleur du prospect, dans SON vocabulaire à lui, pas le vôtre.",
        "Agitation : montrer ce qu'il en coûte de ne rien faire (temps perdu, argent perdu, opportunité manquée, frustration qui s'accumule) — sans exagération malhonnête, juste la vérité rendue tangible.",
        "Solution : présenter votre offre comme la résolution logique et évidente de ce qui vient d'être agité — jamais avant d'avoir agité, sinon elle tombe à plat.",
      ],
    },
    hso: {
      name: 'Hook-Story-Offer',
      steps: [
        "Hook : la phrase ou l'image qui arrête tout, en une fraction de seconde.",
        "Story : une histoire courte et crédible (la vôtre, celle d'un client) qui amène naturellement à l'offre — le storytelling crée la connexion émotionnelle qu'aucune liste de bénéfices ne produit seule.",
        "Offer : l'offre elle-même, présentée comme la conclusion logique de l'histoire, avec un CTA clair et un sentiment d'urgence légitime (quantité, délai, bonus limité).",
      ],
    },
  },

  objections: {
    label: "Matrice de levée d'objections",
    keywords: [
      'objection', 'trop cher', 'je vais réfléchir', 'pas confiance', 'pas le temps', 'déjà un fournisseur', 'sans argent',
    ],
    // Méthode générale appliquée à CHAQUE objection : Écouter → Reformuler
    // (montrer qu'on a compris, sans être d'accord ni en désaccord) →
    // Répondre (méthode "Feel-Felt-Found" ou preuve concrète) → Re-poser
    // une question qui relance vers l'action. Ne JAMAIS argumenter frontalement
    // contre l'objection : ça braque le prospect au lieu de le rassurer.
    method: [
      "Écouter entièrement l'objection sans couper la parole ni répondre avant qu'elle soit formulée en entier.",
      "Reformuler pour montrer qu'on a compris (\"Je comprends, le budget est un vrai sujet pour vous en ce moment\").",
      "Répondre avec la méthode Feel-Felt-Found : \"Je comprends ce que vous ressentez (Feel), d'autres clients ressentaient la même chose au début (Felt), et voici ce qu'ils ont constaté (Found)\".",
      "Relancer avec une question ouverte qui ramène vers l'action, jamais une question fermée qui invite à un nouveau \"non\".",
    ],
    matrix: {
      "c'est trop cher": {
        reframe: "Ce n'est pas un refus, c'est une question de valeur perçue : le prix seul n'a jamais été le vrai problème, c'est le rapport entre le prix et la valeur perçue à cet instant.",
        response: "Recentrer sur le coût de l'INACTION (\"Combien ça vous coûte de continuer sans résoudre ce problème ?\"), puis découper le prix en unité plus petite (par jour/par semaine) pour le rendre tangible, et rappeler la garantie/preuve de résultat si elle existe.",
        example: "\"Je comprends, le budget compte. Est-ce que c'est le prix en lui-même, ou le fait de ne pas être encore sûr que ça va vous apporter ce résultat ? Parce que ramené à la semaine, ça représente moins qu'un [comparaison concrète du quotidien].\"",
      },
      'je vais réfléchir': {
        reframe: "C'est très souvent une objection-écran qui cache une autre objection non formulée (prix, doute, besoin de valider avec un tiers) — le vrai travail est de découvrir LAQUELLE.",
        response: "Ne jamais laisser partir sans clarifier : \"Bien sûr, c'est normal de vouloir prendre le temps. Pour être sûr de bien vous accompagner, qu'est-ce qui vous ferait hésiter le plus à cet instant ?\" — la réponse révèle la vraie objection à traiter.",
        example: "\"Je comprends totalement. Juste pour m'assurer d'avoir bien répondu à tout : y a-t-il un point précis qui vous fait hésiter, ou c'est plutôt une question de timing ?\"",
      },
      "je n'ai pas confiance": {
        reframe: "La confiance se construit avec de la preuve tangible, jamais avec de l'insistance — plus on insiste sans preuve, plus le doute grandit.",
        response: "Apporter une preuve sociale concrète (avis, cas client similaire à sa situation), proposer une garantie ou un premier pas à faible risque (essai, échantillon, appel découverte gratuit) pour réduire la perception du risque à quasi zéro.",
        example: "\"C'est une question totalement légitime. Voici ce qu'en dit [client similaire] : [preuve]. Et pour lever le doute sans engagement de votre côté, on peut commencer par [premier pas à faible risque].\"",
      },
      "je n'ai pas le temps": {
        reframe: "Le temps est souvent une objection de priorité, pas de disponibilité réelle — la vraie question est \"est-ce assez important pour vous ?\".",
        response: "Montrer que la solution fait GAGNER du temps (pas en prend), ou proposer un format ultra-court pour démarrer (\"5 minutes suffisent pour...\").",
        example: "\"Je comprends, tout le monde est débordé. C'est justement pour ça que [solution] est pensée pour prendre 5 minutes montre en main — pas plus que le temps qu'on vient de passer à en parler.\"",
      },
      "j'ai déjà un fournisseur/une solution": {
        reframe: "Ce n'est pas un mur, c'est une information : le prospect a déjà un budget alloué au problème — la question devient \"est-il pleinement satisfait ?\".",
        response: "Poser une question ouverte sur sa satisfaction actuelle plutôt que dénigrer le concurrent (jamais de dénigrement direct — ça se retourne toujours contre soi), puis positionner votre différenciateur précis sur le point faible identifié.",
        example: "\"Très bien, et est-ce que vous êtes 100% satisfait de [ce point précis] avec votre solution actuelle ? Parce que c'est exactement ce sur quoi on se démarque.\"",
      },
      "je n'ai pas les moyens en ce moment": {
        reframe: "Objection budgétaire réelle (à distinguer du \"trop cher\" perçu) — nécessite une solution d'accès plus douce plutôt qu'un argumentaire de valeur.",
        response: "Proposer un paiement échelonné, une offre d'entrée de gamme, ou du contenu de valeur gratuit en attendant (pour rester dans la relation sans forcer la vente).",
        example: "\"Je comprends complètement. Est-ce qu'un paiement en plusieurs fois vous faciliterait les choses, ou préférez-vous qu'on reste en contact et que je vous partage déjà [ressource gratuite] en attendant ?\"",
      },
    },
  },

  one_to_one: {
    label: 'Closing 1-to-1 (WhatsApp / Telegram)',
    keywords: [
      'whatsapp', 'telegram', 'dm', 'message privé', 'closing 1 to 1', 'discussion privée', 'prospection privée',
    ],
    whatsapp: [
      "Toujours ouvrir par une question ou un constat personnalisé (jamais un pavé de présentation générique) : le format WhatsApp est perçu comme une conversation, pas comme une publicité.",
      "Messages COURTS et séquencés (2-3 messages courts plutôt qu'un seul long pavé) : ça imite le rythme naturel d'une vraie conversation et augmente le taux de réponse.",
      "Utiliser les messages vocaux avec parcimonie pour les prospects chauds déjà engagés dans l'échange — jamais en premier contact (perçu comme intrusif).",
      "Un emoji ou deux maximum par message, jamais une accumulation — ça garde le ton professionnel-chaleureux sans tomber dans le \"spammy\".",
      "Respecter un délai de 10 à 15 secondes minimum entre deux messages lors d'un envoi semi-automatisé pour éviter tout signal anti-flood côté plateforme (voir le module Anti-ban & délivrabilité).",
    ],
    telegram: [
      "Le premier message doit toujours donner une raison claire de contact (\"Je vous contacte suite à...\") — un DM Telegram sans contexte est perçu comme spam et signalé plus facilement que sur WhatsApp.",
      "Privilégier un ton direct et informatif dès le départ : l'audience Telegram est en moyenne plus technophile et moins tolérante au remplissage marketing classique.",
      "Respecter un délai de 30 à 60 secondes entre chaque message individuel lors d'une diffusion — c'est un terrain beaucoup plus sensible au FloodWaitError qu'un simple ralentissement, une restriction peut couper temporairement le compte.",
    ],
  },

  anti_ban_channels: {
    label: 'Sécurité & anti-ban des canaux (réchauffement, fréquence, délivrabilité)',
    keywords: [
      'anti-ban', 'anti ban', 'réchauffement', 'warmup', 'ban', 'blocage', 'flood', 'spam', 'délivrabilité',
    ],
    warmup: [
      "Un nouveau numéro (WhatsApp comme Telegram) doit d'abord avoir une activité \"humaine\" pendant 5 à 7 jours (contacts enregistrés, quelques échanges normaux, photo de profil, bio remplie) avant tout envoi en masse — un numéro neuf qui envoie 200 messages le jour 1 est le signal le plus détecté par les systèmes anti-spam.",
      "Monter en charge progressivement sur 2 à 3 semaines : quelques dizaines de messages/jour la 1ère semaine, puis augmenter par palier de +20-30% seulement si aucun signal négatif (blocage, plainte) n'est constaté.",
      "Éviter d'utiliser un numéro fraîchement réchauffé pour DIFFUSER vers des inconnus en premier lieu — commencer par des contacts qui ont déjà interagi (opt-in, ancien client) avant d'élargir.",
    ],
    frequency: [
      "Respecter un délai minimum entre chaque message individuel (10-15s WhatsApp, 30-60s Telegram) — voir Closing 1-to-1 — et un temps de pause après chaque lot (\"batch\") plutôt qu'un envoi continu sans interruption.",
      "Ne jamais envoyer plusieurs fois le même contenu exact au même contact dans une fenêtre de 24 à 48h (anti-doublons) : c'est le motif de plainte le plus fréquent qui déclenche un signalement.",
      "Répartir les envois dans le temps plutôt qu'en un seul pic — un volume soudain et inhabituel est le signal n°1 des systèmes de détection automatique, bien avant le contenu du message lui-même.",
    ],
    deliverability: [
      "Un taux de réponse/engagement élevé protège le compte : une conversation qui reçoit des réponses est un signal positif fort pour les algorithmes anti-spam des deux plateformes.",
      "Un taux de blocage ou de signalement élevé (même sur un petit volume) pèse plus lourd qu'un gros volume sans signalement — la QUALITÉ du ciblage prime toujours sur la quantité.",
      "Varier systématiquement la formulation d'un message envoyé à plusieurs destinataires (voir le moteur Spintax du dashboard) : un texte identique envoyé à un grand nombre de destinataires est un pattern facilement détectable, la variation est une protection autant qu'un principe marketing.",
    ],
  },

  regional_west_africa: {
    label: "Adaptation régionale — marché francophone & Afrique de l'Ouest",
    keywords: [
      'afrique', "afrique de l'ouest", 'mobile money', 'orange money', 'wave', 'mtn momo', 'francophone', "côte d'ivoire", 'sénégal', 'proximité',
    ],
    tone: [
      "Privilégier un ton chaleureux et de proximité plutôt qu'un ton corporate distant : le rapport de confiance personnel pèse souvent plus que la marque elle-même sur ce marché.",
      "Le tutoiement est largement accepté et même attendu dans une approche 1-to-1 WhatsApp — il rapproche plutôt qu'il ne dévalorise, à l'inverse de certains marchés européens plus formels.",
      "Les formules de politesse et de bienveillance en ouverture (\"J'espère que vous allez bien\", \"Que Dieu vous bénisse\" selon le contexte) sont un vrai marqueur culturel de respect, pas un simple remplissage — les garder plutôt que les couper pour \"aller à l'essentiel\".",
    ],
    mobileMoney: [
      "Toujours proposer le paiement via Mobile Money (Orange Money, Wave, MTN MoMo, Moov Money selon le pays) en option par défaut, pas seulement carte bancaire — c'est souvent le moyen de paiement PRINCIPAL, pas une alternative secondaire.",
      "Simplifier au maximum le parcours de paiement Mobile Money (numéro + confirmation) : chaque étape supplémentaire perd une part significative de clients sur connexion mobile parfois instable.",
      "Mentionner explicitement les moyens de paiement acceptés dès l'offre (pas seulement en fin de tunnel) : ça lève une objection silencieuse fréquente (\"est-ce que je pourrai payer facilement ?\") avant même qu'elle soit formulée.",
    ],
    proximity: [
      "Le bouche-à-oreille et la recommandation personnelle restent un des leviers de confiance les plus puissants — solliciter et mettre en avant les témoignages de clients locaux identifiables plutôt que des avis anonymes génériques.",
      "Privilégier des visuels et exemples représentatifs du contexte local (villes, situations du quotidien) plutôt que des visuels 100% occidentaux importés tels quels — l'audience s'identifie beaucoup plus vite à ce qui lui ressemble.",
      "La disponibilité et la réactivité humaine (répondre vite, rester joignable) comptent souvent plus que la sophistication de l'offre elle-même dans la décision finale d'achat.",
    ],
  },
};

// Association mot-clé -> clé de topic, construite une fois au chargement du
// module (évite de reparcourir tous les topics à chaque message).
const KEYWORD_INDEX = [];
Object.entries(topics).forEach(([key, topic]) => {
  (topic.keywords || []).forEach((kw) => {
    KEYWORD_INDEX.push({ keyword: kw.toLowerCase(), topicKey: key });
  });
});

// Détecte les topics pertinents pour un message libre (recherche de
// sous-chaîne simple, insensible à la casse — pas de NLP, volontairement
// basique et 100% déterministe/local, aucun appel externe). Retourne les
// clés de topics triées par nombre de mots-clés matchés (le plus pertinent
// d'abord), dédupliquées.
function findTopics(message) {
  const text = String(message || '').toLowerCase();
  const scores = new Map();
  KEYWORD_INDEX.forEach(({ keyword, topicKey }) => {
    if (text.includes(keyword)) {
      scores.set(topicKey, (scores.get(topicKey) || 0) + 1);
    }
  });
  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([topicKey]) => topicKey);
}

// Recherche une entrée de la matrice d'objections par correspondance de
// sous-chaîne sur les formulations connues — volontairement tolérant (un
// message contenant "c'est un peu cher pour moi" doit quand même matcher
// "c'est trop cher").
function findObjection(message) {
  const text = String(message || '').toLowerCase();
  const entries = Object.entries(topics.objections.matrix);
  const direct = entries.find(([phrase]) => text.includes(phrase));
  if (direct) return { phrase: direct[0], ...direct[1] };

  // Repli par mots-clés isolés (prix/cher, réfléchir, confiance, temps,
  // fournisseur/concurrent, moyens/budget) quand la formulation exacte ne
  // matche pas mot pour mot.
  const fallbackMap = [
    { test: /cher|prix|budget élevé|coûte/, phrase: "c'est trop cher" },
    { test: /réfléchir|réflexion|je verrai|plus tard/, phrase: 'je vais réfléchir' },
    { test: /confiance|arnaque|sûr que|garanti(e)?\b/, phrase: "je n'ai pas confiance" },
    { test: /pas le temps|trop occupé|débordé/, phrase: "je n'ai pas le temps" },
    { test: /déjà (un|une)|concurrent|fournisseur actuel/, phrase: "j'ai déjà un fournisseur/une solution" },
    { test: /pas les moyens|pas d'argent|fauché|petit budget/, phrase: "je n'ai pas les moyens en ce moment" },
  ];
  const match = fallbackMap.find((f) => f.test.test(text));
  if (match) return { phrase: match.phrase, ...topics.objections.matrix[match.phrase] };
  return null;
}

module.exports = {
  topics,
  findTopics,
  findObjection,
};
