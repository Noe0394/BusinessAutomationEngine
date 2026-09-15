// BASE DE CONNAISSANCES — ai-engine/knowledgeBase.js
// ---------------------------------------------------------------------------
// Centre d'aide / documentation / tutoriels / FAQ de CYRUS, EMBARQUÉ dans le
// code (versionné avec l'app, jamais soumis au miroir GitHub runtime — donc
// toujours disponible et cohérent). Sert deux usages :
//   1) l'onglet « Centre d'aide » du dashboard (public/dashboard.html) ;
//   2) l'outil `getDocumentation` du registre (ai-engine/toolRegistry.js) : le
//      Chat Intelligent y puise pour répondre « comment je fais pour… ? » avec
//      la VRAIE procédure du produit, jamais une réponse inventée.
//
// Chaque article : { id, category, title, keywords[], summary, body, steps? }.
// La FAQ est une couche rapide (question -> réponse courte) qui pointe vers
// l'article complet.

const CATEGORIES = [
  { id: 'demarrage', label: '🚀 Bien démarrer' },
  { id: 'cle', label: '🔑 Clé & activation' },
  { id: 'services-metiers', label: '🏢 Services Métiers' },
  { id: 'chat', label: '💬 Chat Intelligent' },
  { id: 'connexions', label: '📱 WhatsApp & Telegram' },
  { id: 'contacts', label: '📇 Contacts & import' },
  { id: 'securite', label: '🔒 Sécurité & confidentialité' },
  { id: 'depannage', label: '🛠️ Dépannage' },
];

const ARTICLES = [
  {
    id: 'demarrage-apercu',
    category: 'demarrage',
    title: 'Qu\'est-ce que CYRUS et par où commencer',
    keywords: ['demarrer', 'commencer', 'debuter', 'presentation', 'apercu', 'cyrus', 'quoi'],
    summary: 'CYRUS est ton assistant business autonome : il comprend un objectif, décide, agit réellement (WhatsApp, Telegram, plateformes) et vérifie le résultat.',
    body: "CYRUS n'est pas un simple chatbot : c'est un système qui exécute de VRAIES actions pour toi (envoyer des messages, lancer des campagnes, créer des accès élèves, encaisser, importer et segmenter des contacts) et qui vérifie chaque action avant de te confirmer. Pour démarrer : 1) active ta clé de licence ; 2) connecte au moins un canal (WhatsApp ou Telegram) ; 3) configure ton activité dans l'onglet « Services Métiers » (produits, prix, règles, objectifs) ; 4) parle-lui dans le « Chat Intelligent ».",
    steps: [
      'Active ta clé de licence à l\'ouverture de l\'application.',
      'Connecte ton WhatsApp et/ou Telegram (onglet Connexions).',
      'Configure ton activité dans l\'onglet « Services Métiers ».',
      'Importe tes contacts si tu en as (onglet Contacts).',
      'Donne un objectif au Chat Intelligent — il agit et te rend compte.',
    ],
  },
  {
    id: 'cle-activation',
    category: 'cle',
    title: 'Activer sa clé de licence (accès sans inscription classique)',
    keywords: ['cle', 'clef', 'licence', 'activation', 'activer', 'acces', 'connexion', 'inscription'],
    summary: 'CYRUS ne demande pas d\'inscription classique : tu saisis ta clé de licence, elle est vérifiée en temps réel, et l\'accès est activé pour ton environnement.',
    body: "L'accès à CYRUS se fait par une CLÉ de licence, pas par un compte email/mot de passe. À l'ouverture, saisis ta clé : elle est vérifiée réellement côté serveur puis liée à ton environnement. Une clé = un accès. Pour utiliser un autre compte/accès, il faut une autre clé. Ta clé ne doit jamais être partagée ni affichée inutilement — elle vaut ton accès.",
    steps: [
      'Ouvre CYRUS.',
      'Saisis ta clé de licence dans le champ prévu.',
      'La clé est vérifiée en temps réel ; si elle est valide, l\'accès s\'ouvre.',
      'Ne partage jamais ta clé — une clé = un accès autorisé.',
    ],
  },
  {
    id: 'services-metiers-configurer',
    category: 'services-metiers',
    title: 'Configurer un Service Métier (étape par étape)',
    keywords: ['service metier', 'services metiers', 'configurer', 'produit', 'prix', 'api', 'connecter', 'plateforme', 'regles', 'objectifs', 'permissions', 'parametrer', 'reglage'],
    summary: 'Le Service Métier est la fiche d\'identité de ton activité : produits, prix, règles, objectifs, et éventuellement la connexion API à ta plateforme. C\'est là que le chat puise pour vendre et agir.',
    body: "Un « Service Métier » décrit une activité que tu gères (une formation, une boutique, un service…). Le Chat Intelligent lit ces informations pour répondre à tes clients avec les VRAIS prix/règles, et, si tu connectes une API, pour agir sur ta plateforme (créer un accès, suspendre…). Rends-toi dans l'onglet « 🏢 Services Métiers » puis « + Ajouter un Service Métier ». Remplis : le nom et le type d'activité ; les infos commerciales (prix, devise, description, cible, avantages, objections/réponses) ; la liste des produits (un par ligne, format « Nom | Prix ») ; les règles commerciales (ex. « jamais plus de 10% de remise ») ; les objectifs (ex. « vendre 10 formations par semaine »). Pour la connexion : choisis « Aucune (interne) » si ta plateforme n'a pas d'API — CYRUS exploitera quand même tes infos ; choisis « API » si ta plateforme expose une API (indique l'URL de base, l'en-tête d'authentification, ta clé API), puis coche les PERMISSIONS que tu autorises (créer un compte élève, suspendre un accès, ajouter un contact, etc.). Enregistre, puis clique « Tester la connexion » : CYRUS effectue un VRAI test non destructif et affiche le statut réel (CONNECTÉ / erreur). Ta clé API est chiffrée dans un coffre : elle n'est jamais réaffichée ni écrite dans les logs ou les conversations.",
    steps: [
      'Onglet « 🏢 Services Métiers » → « + Ajouter un Service Métier ».',
      'Nom + type d\'activité (formation, e-commerce, service…).',
      'Infos commerciales : prix, devise, description, cible, avantages, objections.',
      'Produits : un par ligne au format « Nom | Prix » (ex. « Formation Épicerie et Bouillon | 8000 »).',
      'Règles commerciales (ex. remise max) et objectifs (ex. 10 ventes/semaine).',
      'Connexion : « Aucune » (infos seules) OU « API » (URL de base + en-tête + clé API).',
      'Si API : coche les permissions autorisées (créer accès, suspendre, tagger…).',
      'Enregistre, puis « Tester la connexion » → statut RÉEL affiché.',
      'La clé API est chiffrée dans un coffre ; jamais réaffichée.',
    ],
  },
  {
    id: 'services-metiers-sans-api',
    category: 'services-metiers',
    title: 'Mon service n\'a pas d\'API : que se passe-t-il ?',
    keywords: ['sans api', 'pas d api', 'interne', 'manuel', 'alternative'],
    summary: 'Sans API, CYRUS exploite quand même tes infos métier (prix, produits, règles) pour conseiller et vendre ; les actions automatisées sur la plateforme nécessitent une API ou un connecteur compatible.',
    body: "Si ta plateforme n'expose pas d'API, choisis « Aucune (interne) » à la connexion. CYRUS pourra toujours répondre aux questions de tes prospects avec tes vrais prix/produits/règles et t'aider à closer. En revanche, les actions automatisées DIRECTES sur la plateforme (créer un compte, débloquer un module…) ont besoin d'une API ou d'un connecteur compatible — sinon CYRUS te prépare l'action à faire toi-même, sans jamais prétendre l'avoir faite.",
  },
  {
    id: 'chat-utiliser',
    category: 'chat',
    title: 'Utiliser le Chat Intelligent (questions, infos et actions)',
    keywords: ['chat', 'conversation', 'parler', 'question', 'action', 'commande', 'objectif', 'outils'],
    summary: 'Le Chat distingue conversation, question, information et action. Une discussion reste naturelle ; une instruction déclenche un vrai outil (envoi, création d\'accès, etc.), exécuté et vérifié.',
    body: "Le Chat Intelligent est ton point d'entrée unique. Tu peux discuter naturellement, poser une question (« quel est le prix de ma formation ? » → il lit ton Service Métier), demander une info (« combien de contacts ai-je importés ? »), ou donner une instruction (« réponds à mon dernier message », « envoie ce message au groupe X »). Pour une action, CYRUS choisit le bon outil, l'exécute réellement, VÉRIFIE le résultat, puis te répond — jamais un faux « c'est fait ». Astuce saisie : Entrée = nouvelle ligne, Ctrl+Entrée = envoyer. La conversation est mémorisée : au retour, tu continues là où tu en étais.",
    steps: [
      'Écris naturellement ton objectif ou ta question.',
      'Pour une action, CYRUS confirme d\'abord si c\'est risqué (campagne), puis exécute.',
      'Il vérifie le résultat réel et te le rapporte honnêtement.',
      'Entrée = nouvelle ligne ; Ctrl+Entrée = envoyer.',
    ],
  },
  {
    id: 'connexions-whatsapp',
    category: 'connexions',
    title: 'Connecter WhatsApp',
    keywords: ['whatsapp', 'connecter', 'appairer', 'qr', 'code', 'lier'],
    summary: 'Dans l\'onglet Connexions, scanne le QR (ou saisis le code) pour lier ton WhatsApp. Une fois connecté, CYRUS peut lire tes messages et envoyer en ton nom.',
    body: "Va dans l'onglet Connexions, section WhatsApp, et scanne le QR code affiché avec ton téléphone (WhatsApp → Appareils connectés), ou utilise la connexion par code. Une fois lié, CYRUS lit tes messages récents et envoie des messages VÉRIFIÉS (il récupère l'identifiant réel du message et ne confirme que si l'envoi est confirmé). Si la connexion se coupe (fréquent sur serveur), elle se rétablit automatiquement.",
  },
  {
    id: 'connexions-telegram',
    category: 'connexions',
    title: 'Connecter Telegram',
    keywords: ['telegram', 'connecter', 'code', 'numero', 'lier'],
    summary: 'Dans l\'onglet Connexions, section Telegram, saisis ton numéro puis le code reçu (et le mot de passe 2FA si activé).',
    body: "Onglet Connexions, section Telegram : saisis ton numéro de téléphone, puis le code de connexion que Telegram t'envoie, et ton mot de passe 2FA si tu en as un. Une fois connecté, CYRUS envoie des messages Telegram vérifiés (identifiant réel du message).",
  },
  {
    id: 'contacts-import',
    category: 'contacts',
    title: 'Importer des contacts depuis Excel/CSV',
    keywords: ['contacts', 'import', 'importer', 'excel', 'csv', 'xlsx', 'fichier', 'telephone'],
    summary: 'Importe un fichier .xlsx/.csv (colonne « telephone », et « nom » facultative). CYRUS normalise les numéros, retire les doublons, rejette les invalides et te donne un rapport. Les contacts deviennent interrogeables par le chat.',
    body: "Prépare un fichier Excel ou CSV avec au minimum une colonne « telephone » (et idéalement « nom », plus éventuellement pays, ville, entreprise, catégorie, notes). Dans la section « Import Excel / CSV », choisis ton fichier puis clique « 📇 Importer dans le CRM ». CYRUS lit le fichier, normalise chaque numéro vers son identité canonique, déduplique (dans le fichier ET contre l'existant), rejette les lignes sans numéro valide, et te renvoie un rapport réel (importés / mis à jour / doublons / rejetés). Ensuite, le Chat Intelligent peut les interroger : « combien de contacts ai-je ? », « trouve les contacts nommés Awa », etc.",
    steps: [
      'Prépare un .xlsx/.csv avec une colonne « telephone » (et « nom »).',
      'Section « Import Excel / CSV » → choisis le fichier.',
      'Clique « 📇 Importer dans le CRM (interrogeable par le chat) ».',
      'Lis le rapport : importés / doublons / rejetés.',
      'Interroge-les dans le chat (« combien de contacts », « trouve … »).',
    ],
  },
  {
    id: 'securite-secrets',
    category: 'securite',
    title: 'Sécurité de tes clés et de tes données',
    keywords: ['securite', 'confidentialite', 'cle api', 'coffre', 'chiffrement', 'donnees', 'secret'],
    summary: 'Les clés API sont chiffrées dans un coffre (AES-256-GCM), jamais affichées ni journalisées. Tes données restent liées à ton accès.',
    body: "Toute clé API que tu connectes à un Service Métier est chiffrée au repos dans un coffre (AES-256-GCM) : elle n'est jamais réaffichée dans l'interface, jamais écrite dans les logs, jamais montrée dans les conversations. Le chat ne voit que la PRÉSENCE d'une clé, pas sa valeur. Les fichiers que tu importes peuvent contenir des données personnelles : assure-toi d'être autorisé à les utiliser et n'importe que ce qui est nécessaire.",
  },
  {
    id: 'depannage-api-non-connectee',
    category: 'depannage',
    title: 'Le test de connexion API échoue',
    keywords: ['depannage', 'erreur', 'api', 'connexion', 'echec', '401', '404', 'probleme'],
    summary: 'Vérifie l\'URL de base, l\'en-tête d\'authentification et la clé. Un 401 = clé invalide ; un 404 sur un test non destructif peut être NORMAL (compte de test introuvable = authentifié).',
    body: "Si « Tester la connexion » échoue : 1) vérifie l'URL de base (sans espace, bon domaine) ; 2) vérifie l'en-tête d'authentification attendu par ta plateforme (souvent X-API-Key) ; 3) vérifie que la clé est correcte et active. Un statut 401 signifie clé invalide. Pour une passerelle plateforme, un 404 lors du test (compte de test introuvable) est en réalité un BON signe : la clé est acceptée et l'API est joignable, on a juste ciblé un compte qui n'existe pas exprès.",
  },
  {
    id: 'depannage-envoi-non-confirme',
    category: 'depannage',
    title: 'Un envoi reste « non confirmé » ou échoue',
    keywords: ['envoi', 'message', 'non confirme', 'echec', 'whatsapp', 'telegram', 'not_connected'],
    summary: 'CYRUS ne dit « envoyé » que si l\'identifiant réel du message est confirmé. « NOT_CONNECTED » = le canal n\'est pas connecté ; reconnecte-le dans l\'onglet Connexions.',
    body: "CYRUS ne confirme un envoi que lorsqu'il obtient l'identifiant réel du message côté WhatsApp/Telegram. Si l'état est « UNCONFIRMED », l'envoi n'est pas garanti — réessaie. Si l'erreur est « NOT_CONNECTED », le canal n'est pas connecté : va dans l'onglet Connexions et reconnecte WhatsApp/Telegram, puis relance l'action.",
  },
];

const FAQ = [
  { q: 'Comment configurer mon Service Métier ?', a: 'Onglet « Services Métiers » → « + Ajouter », renseigne activité, produits/prix, règles, objectifs, et (si tu as une API) la connexion + les permissions, puis « Tester la connexion ».', articleId: 'services-metiers-configurer' },
  { q: 'Comment importer mes contacts ?', a: 'Section « Import Excel / CSV » → choisis ton fichier .xlsx/.csv (colonne « telephone ») → « Importer dans le CRM ».', articleId: 'contacts-import' },
  { q: 'Comment connecter mon API ?', a: 'Dans le Service Métier, choisis « API », renseigne l\'URL de base, l\'en-tête et ta clé, coche les permissions, puis « Tester la connexion ».', articleId: 'services-metiers-configurer' },
  { q: 'Pourquoi mon import a-t-il rejeté des lignes ?', a: 'Les lignes sans numéro de téléphone valide (au moins 8 chiffres) sont rejetées, et les numéros en double sont dédupliqués.', articleId: 'contacts-import' },
  { q: 'Le chat a-t-il vraiment accès à mon WhatsApp ?', a: 'Oui, une fois connecté : il lit tes messages récents et envoie des messages vérifiés (identifiant réel). Il ne confirme jamais un envoi non confirmé.', articleId: 'connexions-whatsapp' },
  { q: 'Ma clé API est-elle en sécurité ?', a: 'Oui : chiffrée dans un coffre (AES-256-GCM), jamais réaffichée ni journalisée. Le chat ne voit que sa présence.', articleId: 'securite-secrets' },
  { q: 'Enter envoie mon message par erreur ?', a: 'Non : Entrée = nouvelle ligne, Ctrl+Entrée = envoyer.', articleId: 'chat-utiliser' },
];

function norm(s) { return String(s == null ? '' : s).toLowerCase(); }

// Recherche : score simple par correspondance sur mots-clés, titre, résumé,
// corps. Renvoie les meilleurs articles (métadonnées + corps).
function search(query, limit) {
  const q = norm(query).trim();
  if (!q) return [];
  const terms = q.split(/\s+/).filter((t) => t.length >= 3);
  const scored = ARTICLES.map((a) => {
    const hay = norm(a.title) + ' ' + a.keywords.join(' ') + ' ' + norm(a.summary) + ' ' + norm(a.body);
    let score = 0;
    if (hay.includes(q)) score += 5;
    for (const t of terms) { if (hay.includes(t)) score += 1; }
    for (const k of a.keywords) { if (q.includes(k)) score += 2; }
    return { a, score };
  }).filter((x) => x.score > 0).sort((x, y) => y.score - x.score);
  return scored.slice(0, limit || 3).map((x) => x.a);
}

function get(id) { return ARTICLES.find((a) => a.id === id) || null; }
function all() { return { categories: CATEGORIES, articles: ARTICLES, faq: FAQ }; }

module.exports = { CATEGORIES, ARTICLES, FAQ, search, get, all };
