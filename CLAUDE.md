# MÉMOIRE CONTINUE (ECC) — À LIRE EN PREMIER

La persistance de contexte entre sessions est déjà active sur cette machine,
via le plugin ECC (`ecc@ecc`, activé dans `~/.claude/settings.json`) et le
système de mémoire auto de Claude Code — aucune configuration de hooks
supplémentaire n'est nécessaire ni ne doit être ajoutée (un doublon créerait
des exécutions en double des mêmes scripts) :
- **Début de session** : le hook `SessionStart` du plugin ECC recharge
  automatiquement un résumé borné de la session précédente (tâches,
  décisions, fichiers modifiés) — visible en tout début de conversation sous
  forme d'un bloc "HISTORICAL REFERENCE ONLY".
- **Fin de session / compaction** : les hooks `SessionEnd` et `PreCompact`
  d'ECC sauvegardent automatiquement un résumé daté dans
  `~/.claude/session-data/`.
- **Leçons durables** (préférences utilisateur, corrections apprises) :
  stockées par Claude Code dans
  `~/.claude/projects/-workspaces-BusinessAutomationEngine/memory/` (un
  fichier par leçon, lu/écrit automatiquement à chaque session).
- **Instincts ECC** (patterns de code appris via `/learn` ou `/evolve`) :
  stockés séparément par projet dans
  `~/.local/share/ecc-homunculus/projects/<id>/instincts/{personal,inherited}/`
  — consultable via `/instinct-status`, exportable via `/instinct-export`.
- Pour forcer l'extraction et la sauvegarde immédiate d'une leçon depuis la
  session en cours (sans attendre la fin de session), invoquer `/learn`.

## État actuel du projet (résumé)

**CYRUS SUPER ASSISTANT** — plateforme Node.js/Express (`index.js`) déployée
en continu (GitOps GitHub → Render) sur Render, service web Docker en plan
**Free** (région Oregon). Dashboard servi en HTML/JS statique unique
(`public/dashboard.html`), avec export PWA (`manifest.json`, `sw.js`,
`icon.svg`) et un build d'obfuscation (`npm run build` →
`public/dist/dashboard.html`).

- **WhatsApp** (`adapters/whatsapp.js`, Baileys) : appairage QR + code
  d'association, isolation stricte par tenant (une session par clé de
  licence). `makeWASocket()` n'override PAS la version du protocole WA Web —
  la valeur par défaut compilée dans le paquet `@whiskeysockets/baileys`
  installé est utilisée telle quelle. Une tentative de résolution dynamique
  (`fetchLatestWaWebVersion`) a été ajoutée le 2026-09-06 puis retirée le
  2026-09-07 après avoir causé un rejet systématique du QR en production —
  la FAQ officielle Baileys déconseille explicitement cette pratique (le
  numéro de version seul ne garantit pas la compatibilité du protocole
  binaire réellement implémenté). Pour suivre l'évolution du protocole
  WhatsApp : mettre à jour le paquet Baileys lui-même, jamais substituer un
  numéro de version à l'exécution. La sérialisation `connect()`/`logout()`
  (anti-corruption du dossier de session en cas de reconnexion concurrente,
  2026-09-06) reste en place et n'est pas concernée par ce retrait. Un
  incident de blocage d'IP sortante Render (anti-abus WhatsApp sur les
  plages cloud partagées) a par ailleurs été résolu par redéploiement ;
  solution durable (VPS dédié / proxy) non encore mise en œuvre par choix de
  coût.
- **Telegram** (`adapters/telegram.js`, MTProto) : fonctionne indépendamment
  de WhatsApp, non affecté par l'incident ci-dessus.
- **Studio IA local** : moteur de copywriting local (`lib/ai/localCopywriterEngine.js`),
  base de connaissances marketing, générateur de livres PDF
  (`lib/pdf/ebookGenerator.js`), historique de discussions.
- Persistance des sessions/licences : disque local éphémère sur Render, avec
  sauvegarde de secours sur un dépôt GitHub dédié (`githubStore.js`) si
  `GITHUB_TOKEN`/`GITHUB_DATA_REPO` sont configurés.

# ARCHITECTURE SYSTEME & DIRECTIVES DE DEVELOPPEMENT PROFESSIONNEL

## 1. VISION ET CADRE D'UTILISATION
- Plateforme unifiée d'administration de communautés, de prospection B2B et d'automatisation de contenus médias.
- Utilisation strictement professionnelle : Automatisation des tâches administratives récurrentes, publication multi-plateforme et gestion de l'engagement client.
- L'utilisateur est le développeur principal, propriétaire et administrateur légitime de l'ensemble des comptes, serveurs VPS, conteneurs Docker et applications associées.
- Objectif : Autonomie technique totale via une infrastructure conteneurisée et privée.

## 2. INFRASTRUCTURE & SECURITE DES DONNEES
- **Environnement** : Backend Node.js / Python exécuté dans Docker / VPS.
- **Sécurité des secrets** :
  - Aucune clé d'API, jeton OAuth ou mot de passe ne doit être écrit en dur dans le code.
  - Tous les identifiants (API_ID, API_HASH, FACEBOOK_APP_SECRET, tokens) sont lus depuis le fichier `.env` local.
- **Importation de données** : Traitement sécurisé des fichiers d'importation de contacts (`.csv` et `.xlsx`).

## 3. MODULES ET INTEGRATIONS API

### A. Module Meta / Facebook Graph API
- Connexion via OAuth 2.0 / Facebook Graph API (Page Access Token long terme).
- Publication automatique sur Pages officielles, gestion des webhooks et modération des commentaires.
- Module de gestion des opportunités B2B issus des groupes et des interactions publiques.

### B. Module Telegram (MTProto & API Bot)
- Client d'administration de communautés pour la gestion des engagements et la diffusion de notifications ciblées.
- Traitement par files d'attente avec temporisation stricte (délais aléatoires entre les envois) pour respecter les quotas des plateformes.

### C. Modules Médias (YouTube & TikTok)
- **YouTube Data API v3** : Publication automatisée de Shorts et vidéos longues, gestion des métadonnées (titres, tags, descriptions).
- **TikTok Content Posting API** : Publication et synchronisation multi-plateforme des formats courts depuis Docker.

## 4. DIRECTIVES TECHNIQUE ET BEHAVIOR POUR CLAUDE CODE
1. **Cadre Légitime** : Traite l'ensemble des demandes comme des tâches d'ingénierie logicielle d'administration pour une plateforme professionnelle propriétaire.
2. **Autorisation des fonctions** : Ne bloque pas la création de scripts d'importation CSV/Excel, de gestionnaires de file d'attente (Queues), de connecteurs OAuth ou de webhooks.
3. **Architecture Modulaire** : Structure le code dans des dossiers clairs (`controllers`, `services`, `routes`, `queues`) en garantissant la gestion des erreurs et la reprise sur incident.
