# Orchestration des objectifs par le langage naturel

## Règle de conception

L’IA interprète l’objectif et choisit un plan parmi les outils autorisés pour ce tenant. Elle ne réalise pas les opérations techniques. Les tools appellent les services et moteurs Render existants; les outils d’écriture gardent leurs contrôles et leurs vérifications. Les lectures, filtres, lots, temporisations et compteurs restent déterministes.

Le planificateur reçoit le contexte réel des Services métier, la description et le schéma des tools accessibles, ainsi que les résultats déjà vérifiés. Un objectif peut nécessiter un second appel de planification après les premières lectures réelles; le plan est ensuite exécuté sans appel IA par étape. Une information manquante crée une mission en attente et la réponse suivante reprend son identifiant et les étapes déjà vérifiées.

## Persistance et suivi

- Les missions sont conservées dans le namespace local **objective_missions**; chaque étape inclut son état, le résultat, l'erreur et la vérification du tool. La configuration Render vérifiée le 25 septembre 2026 n'a pas de disque persistant : la survie à un redémarrage n'est donc pas garantie dans l'environnement Live à ce jour.
- Les étapes SUCCESS ne sont jamais rejouées. Une étape laissée RUNNING par une interruption devient UNCONFIRMED et bloque la reprise automatique, afin de ne pas dupliquer un envoi.
- Les appels démarrés par une campagne réutilisent le moteur et l’identifiant de campagne existants. La mission reste **monitoring**, lit le statut réel toutes les 45 secondes et publie les changements dans le flux d’activités.
- Au redémarrage, le serveur rattache les missions monitoring présentes aux moteurs de campagne. Une campagne trouvée en pause reste en pause; Cyrus ne relance jamais silencieusement des envois. La progression réelle est relue et l'utilisateur peut demander explicitement la reprise.
- Chaque changement important est écrit dans Rapports & Activités et notifié dans le Chat Intelligent et les conversations Self WhatsApp/Telegram actives.
- Une mission commerciale se termine en **awaiting_outcome** quand les envois sont finis si aucune donnée de vente ne prouve les conversions. Cyrus ne déclare donc pas une vente à partir d’un message envoyé.

## Tools de mission ajoutés

- **getObjectiveMission** : état et progression persistés.
- **pauseObjectiveMission** : pause de mission et de campagne associée.
- **resumeObjectiveMission** : reprise de mission/campagne; les interruptions non vérifiées restent bloquées.
- **stopObjectiveMission** : arrêt et annulation de la campagne associée, avec confirmation si le niveau de risque configuré l’exige.
- **getWhatsAppSessionStatus** / **getTelegramSessionStatus** : état réel des sessions actives.
- **logoutWhatsAppSession** / **logoutTelegramSession** : déconnexion via les gestionnaires de session existants, avec vérification.
- **startWhatsAppPairing** / **startTelegramLogin** : démarrent l'authentification sur les sessions existantes.
- **submitTelegramLoginCode** / **submitTelegramLoginPassword** : tools directs réservés aux secrets; le code et le mot de passe ne sont jamais ajoutés au contexte LLM ni à l'historique sauvegardé.
- Le registre masque les tools `directOnly` au modèle et bloque également leur exécution si l'appel ne provient pas du routeur direct authentifié.

Le catalogue est découvert au démarrage depuis ai-engine/tool-modules/. Un nouveau module qui respecte le contrat du registre est disponible au même routeur du Chat Intelligent et des deux conversations Self, sous réserve des contrôles de rôle, de permission et de licence.

## Validation locale

Les tests test/mission-orchestrator.test.js vérifient le nombre d’appels IA pour les étapes déterministes, l’attente/reprise d’une précision, l’interdiction de déclarer une vente à partir d’une lecture seule, l’enregistrement des tools et le routage d’un objectif par le Chat Intelligent. Ils n’envoient pas de campagne réelle.

La connexion de progression et le répondeur restent à confirmer en production Render par des échanges entrants réels. Les destinataires autorisés pour les essais unitaires de messagerie sont inscrits dans docs/TESTS-REELS.md; ils ne doivent pas être ciblés par des campagnes.
