// Guide de support produit CYRUS SUPER ASSISTANT — base de connaissances
// STATIQUE (même philosophie que marketingKnowledgeBase.js : aucun appel
// réseau, aucune IA générative externe) qui permet à localCopywriterEngine
// de répondre en support client de niveau expert sur le fonctionnement de
// l'outil lui-même (connexion WhatsApp, Spintax, Studio IA, générateur de
// PDF, Relance Express, PWA...), avec des étapes exactes et actionnables au
// lieu d'une réponse vague.
//
// Structure : chaque guide porte un `title`, des `keywords` (déclenchent la
// détection — voir findGuide) et des `steps` (instructions numérotées,
// affichées telles quelles).

const { keywordMatches } = require('./keywordMatch');

const guides = [
  {
    key: 'connexion_whatsapp',
    title: '🔗 Connexion WhatsApp (QR code / Code d\'association)',
    keywords: [
      'connecter whatsapp', 'connexion whatsapp', 'lier whatsapp', 'appareil lié', 'appareils liés',
      'code d\'association', 'code association', 'pairing code', 'deep link', 'scanner le qr',
      'qr code', 'qr rejeté', 'code rejeté', 'code refusé', 'code invalide', 'code ne marche pas',
      'code est rejeté', 'code se fait rejeter', 'le code ne passe pas', 'code ne passe pas',
      'n\'arrive pas à connecter', 'impossible de connecter', 'connexion impossible',
      'comment je me connecte', 'comment connecter mon whatsapp', 'lier un appareil',
    ],
    steps: [
      'Ouvrez l\'onglet "🔌 Connexions & Intégrations" puis repérez le bloc WhatsApp.',
      'Sur PC : laissez le mode "💻 Mode PC (QR Code)" sélectionné, cliquez sur "Ouvrir WhatsApp Web" si besoin, puis scannez le QR code affiché depuis votre téléphone : WhatsApp > Réglages > Appareils liés > Lier un appareil.',
      'Sur mobile : basculez sur "📱 Mode Mobile (Code d\'association)", saisissez votre numéro avec l\'indicatif pays (ex: 225xxxxxxxxx, sans le "+" ni espace), puis cliquez sur "📲 Valider via Deep Link".',
      'Le code à 8 chiffres (format XXXX-XXXX) est copié automatiquement dans votre presse-papier et WhatsApp s\'ouvre tout seul sur votre téléphone : WhatsApp > Appareils liés > Lier un appareil > Lier avec le numéro de téléphone, puis collez le code.',
      'Dès que WhatsApp valide l\'appairage côté serveur, le tableau de bord bascule automatiquement sur le badge "Connecté" (vérification toutes les 4 secondes) — inutile de recharger la page ni de re-cliquer sur quoi que ce soit.',
      'Si le QR ou le code est systématiquement rejeté : vérifiez que l\'heure/fuseau horaire de votre téléphone est en réglage automatique (une horloge désynchronisée fait échouer l\'appairage WhatsApp), que votre app WhatsApp est à jour, et qu\'aucun autre appareil n\'est déjà en train d\'essayer de s\'appairer sur le même numéro en même temps.',
      'Toujours bloqué ? Cliquez sur "🔄 Réinitialiser / Se déconnecter de WhatsApp" pour repartir d\'une session neuve, puis régénérez un code/QR.',
    ],
  },
  {
    key: 'whatsapp_deconnexion',
    title: '⚠️ WhatsApp déconnecté / session perdue après redéploiement',
    keywords: [
      'déconnecté', 'deconnexion', 'session perdue', 'ne se connecte plus', 'session expirée',
      'redéploiement', 'redeploy', 'reconnexion automatique', 'whatsapp coupé', 'whatsapp hors ligne',
      'badge déconnecté', 'perdu la connexion',
    ],
    steps: [
      'CYRUS relance automatiquement la connexion de chaque clé de licence déjà appairée dès le démarrage du serveur — un redéploiement Render ne devrait donc PAS nécessiter un nouveau scan dans la majorité des cas.',
      'Si le badge reste sur "Déconnecté" plus de 1 à 2 minutes après un redéploiement, ouvrez l\'onglet Connexions : un nouveau QR/code sera proposé si la session n\'a pas pu être restaurée.',
      'Une déconnexion peut aussi venir d\'une révocation côté téléphone (vous avez supprimé l\'appareil lié depuis WhatsApp) : dans ce cas, un ré-appairage complet est nécessaire, c\'est normal et attendu.',
      'En dernier recours, utilisez "🔄 Réinitialiser / Se déconnecter de WhatsApp" puis reliez l\'appareil (même numéro ou un numéro différent).',
    ],
  },
  {
    key: 'spintax',
    title: '🎲 Spintax (variateur de texte anti-doublons)',
    keywords: [
      'spintax', 'variateur de texte', 'variation de message', 'anti-doublon', 'anti doublon',
      '{option', 'accolades', 'texte spinné', 'spinner',
    ],
    steps: [
      'Le Spintax permet de varier automatiquement un message pour éviter d\'envoyer un texte strictement identique à plusieurs contacts (signal de spam détectable par les plateformes).',
      'Syntaxe : entourez les variantes d\'accolades et séparez-les par des barres verticales, ex : "{Salut|Bonjour|Coucou} {prénom}, {comment allez-vous|comment ça va} ?".',
      'À chaque envoi, une variante différente est tirée au hasard entre chaque option — plus vous ajoutez de variantes par groupe {...}, plus le message final paraît unique et naturel.',
      'Combinez le Spintax avec les variables de contact (comme le prénom) pour maximiser la personnalisation perçue de chaque message envoyé en campagne.',
      'Vous trouvez ce champ dans le module d\'envoi de campagne (Groupes/Diffusion ou Relance Express) — testez toujours un aperçu avant un envoi de masse pour vérifier que la syntaxe est correcte.',
    ],
  },
  {
    key: 'studio_ia',
    title: '🧠 Copywriter Studio IA',
    keywords: [
      'studio ia', 'copywriter studio', 'assistant ia', 'chat ia', 'discussion ia',
    ],
    steps: [
      'L\'onglet "🧠 Copywriter Studio IA" est un assistant de rédaction et de stratégie marketing 100% local — aucune donnée n\'est envoyée à un service externe.',
      'Posez une question précise (ex : "comment répondre à *c\'est trop cher*", "structure d\'une pub Facebook", "comment réchauffer un numéro WhatsApp") pour obtenir une réponse concrète et actionnable.',
      'Chaque discussion est sauvegardée et accessible depuis la liste des sessions — vous pouvez ouvrir plusieurs discussions en parallèle pour des sujets différents.',
      'L\'assistant maîtrise : les Ads (Facebook/Google/TikTok), les frameworks de closing (AIDA/PAS/Hook-Story-Offer), la levée d\'objections, l\'approche 1-to-1 WhatsApp/Telegram, l\'anti-ban/délivrabilité, l\'adaptation au marché francophone/Afrique de l\'Ouest, et désormais le fonctionnement complet de CYRUS lui-même.',
    ],
  },
  {
    key: 'pdf_ebook',
    title: '📕 Générateur de livres/ebooks PDF',
    keywords: [
      'générer un pdf', 'générateur de pdf', 'livre pdf', 'ebook', 'e-book', 'générateur de livre',
      'créer un livre', 'créer un ebook',
    ],
    steps: [
      'Le générateur de livres PDF est un moteur 100% local (aucun envoi de contenu à l\'extérieur) qui compose un ebook prêt à télécharger à partir des informations que vous saisissez.',
      'Renseignez le titre, sous-titre, auteur, date, une couverture et un logo (optionnels), puis ajoutez vos chapitres (titre + contenu + citation/astuce optionnelles + image optionnelle par chapitre).',
      'Un filigrane (watermark) personnalisable peut être appliqué automatiquement sur chaque page pour protéger votre contenu.',
      'Cliquez sur générer : le PDF final est produit et téléchargé directement, sans étape intermédiaire ni stockage sur un serveur tiers.',
    ],
  },
  {
    key: 'relance_express',
    title: '🔁 Relance Manuelle Express (WhatsApp & Telegram)',
    keywords: [
      'relance express', 'relance manuelle', 'relance multi', 'relance client', 'relance automatique',
      'relance prospect', 'deep link', 'wa.me', 't.me',
    ],
    steps: [
      'L\'onglet "📇 Relance Manuelle Express" centralise le suivi de vos contacts/prospects à relancer, canal par canal : basculez entre "WhatsApp" et "Telegram" via le sélecteur en haut de l\'onglet (ce sont, à ce jour, les deux seuls canaux couverts par cette relance 1-clic — Facebook et TikTok ont leurs propres outils dédiés, voir plus bas).',
      'Chaque prospect à relancer s\'affiche sous forme de carte avec un message déjà personnalisé (prénom + variation Spintax si vous avez renseigné "Mon Intention de Campagne") — utilisez "🔄 Varier / Tourner le Texte" pour repiocher une autre formulation sans changer de contact.',
      'Le bouton "🚀 Lancer" copie automatiquement le texte dans le presse-papiers PUIS ouvre le lien direct vers la conversation (wa.me/... pour WhatsApp, t.me/... pour Telegram) : il ne reste qu\'à coller/envoyer depuis l\'app qui s\'ouvre. La carte passe ensuite au contact suivant.',
      'Cette approche volontairement manuelle (vous cliquez "Lancer" pour chaque contact) protège vos comptes : un envoi de masse automatique et non supervisé est justement le type de comportement détecté et sanctionné par les plateformes (voir anti-ban).',
    ],
  },
  {
    key: 'facebook_publication',
    title: '📘 Facebook — Page, Groupes & relance CRM',
    keywords: [
      'page facebook', 'groupe facebook', 'groupes facebook', 'publier sur facebook',
      'programmer facebook', 'planifier facebook', 'importer des contacts facebook', 'crm facebook',
      'relance facebook', 'messenger', 'connecter facebook', 'connexion facebook',
    ],
    steps: [
      'Connectez d\'abord votre Page depuis l\'onglet "🔌 Connexions & Intégrations" ("Se connecter avec Facebook", OAuth officiel Meta) — l\'onglet "Facebook" reste masqué tant que ce n\'est pas fait.',
      'Import & relance CRM : importez un fichier .csv/.xlsx de contacts déjà connus. Seuls ceux ayant une conversation Messenger existante avec votre Page peuvent être relancés (limitation imposée par Meta, pas par CYRUS) — les autres restent visibles dans le tableau mais ne sont pas contactables.',
      'Publication & programmation : rédigez un texte + média optionnel (image/vidéo — un PDF ne peut jamais être joint nativement, hébergez-le ailleurs et collez le lien) et publiez immédiatement ou programmez (Meta exige un créneau entre 10 minutes et 75 jours dans le futur). La case "Diffuser également sur mes groupes" republie automatiquement sur tous vos Groupes gérés.',
      'Alternative : le "Planificateur de Contenu" interne (mot-clé + suivi unifié avec les autres canaux) — vérifié toutes les 60 secondes par ce serveur plutôt que par la programmation native de Meta.',
      'Groupes Facebook : Meta ayant retiré la permission "publish_to_groups" aux applications tierces, la publication dans un Groupe géré ouvre la fenêtre de partage officielle de Facebook pour une validation manuelle finale — c\'est une contrainte Meta, pas une limite de CYRUS.',
    ],
  },
  {
    key: 'youtube_tiktok',
    title: '🎬 Connexion YouTube & TikTok (Studio Vidéo)',
    keywords: [
      'connecter tiktok', 'connecter youtube', 'connexion tiktok', 'connexion youtube',
      'compte tiktok', 'compte youtube', 'lier tiktok', 'lier youtube', 'studio vidéo',
      'publier une vidéo', 'publier un short', 'shorts youtube',
    ],
    steps: [
      'Depuis l\'onglet "🔌 Connexions & Intégrations", utilisez "Se connecter avec TikTok" et le bouton équivalent YouTube (OAuth officiel des deux plateformes) — ces deux connexions alimentent le module Studio Vidéo (Shorts YouTube + TikTok, métadonnées gérées via YouTube Data API v3 et TikTok Content Posting API).',
      'Si le badge reste sur "Déconnecté" après une tentative, revérifiez que l\'autorisation a bien été validée côté fenêtre TikTok/Google (un refus ou une fermeture prématurée de la fenêtre d\'autorisation annule la connexion).',
    ],
  },
  {
    key: 'pwa',
    title: '📲 Installer CYRUS comme application (PWA)',
    keywords: [
      'pwa', 'installer l\'application', 'installer l\'app', 'app mobile', 'application mobile',
      'ajouter à l\'écran d\'accueil', 'icône sur l\'écran d\'accueil', 'progressive web app',
    ],
    steps: [
      'CYRUS peut s\'installer comme une application native sur votre téléphone ou ordinateur (PWA), sans passer par un store.',
      'Sur mobile (Chrome/Safari) : ouvrez le dashboard dans le navigateur, puis utilisez le menu du navigateur > "Ajouter à l\'écran d\'accueil" (ou "Installer l\'application" si la bannière apparaît automatiquement).',
      'Sur PC (Chrome/Edge) : une icône d\'installation apparaît dans la barre d\'adresse — cliquez dessus puis "Installer".',
      'Une fois installée, l\'application fonctionne comme un raccourci direct vers le dashboard, avec une icône dédiée, sans avoir à retaper l\'URL.',
    ],
  },
  {
    key: 'statut_render',
    title: '🟢 Statut de connexion / hébergement Render',
    keywords: [
      'statut de connexion', 'render', 'service down', 'hors ligne', 'serveur down', 'serveur hors ligne',
      'plan free', 'mise en veille', 'lenteur au démarrage',
    ],
    steps: [
      'CYRUS est hébergé sur Render (plan Free, région Oregon) avec déploiement continu depuis GitHub : chaque mise à jour de code publiée se redéploie automatiquement.',
      'Sur le plan Free, le service peut se mettre en veille après une période d\'inactivité — la première requête après une veille peut donc prendre quelques dizaines de secondes le temps que le serveur redémarre, c\'est normal et pas un bug.',
      'Une fois réveillé, la reconnexion WhatsApp de toute clé de licence déjà appairée se relance automatiquement, sans action de votre part.',
      'Le badge de statut ("Connecté"/"Déconnecté") reflète l\'état réel de la session WhatsApp en direct, vérifié toutes les 4 secondes depuis votre navigateur.',
    ],
  },
];

// Recherche le meilleur guide pour un message libre (correspondance de
// sous-chaîne insensible à la casse, comme marketingKnowledgeBase#findTopics
// — volontairement simple et 100% déterministe, aucun appel externe).
// Retourne le guide avec le plus de mots-clés matchés, ou null.
function findGuide(message) {
  const text = String(message || '').toLowerCase();
  let best = null;
  let bestScore = 0;

  guides.forEach((guide) => {
    const score = guide.keywords.reduce((acc, kw) => (keywordMatches(text, kw) ? acc + 1 : acc), 0);
    if (score > bestScore) {
      bestScore = score;
      best = guide;
    }
  });

  return best;
}

module.exports = {
  guides,
  findGuide,
};
