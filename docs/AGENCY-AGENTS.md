# Agency Agents dans Cyrus — bibliothèque de spécialistes sous la tutelle du Service Orchestrateur

Source officielle : https://github.com/msitarzewski/agency-agents (licence MIT, jamais un fork). Catalogue vendorisé : `ai-engine/agents/catalog/` (279 agents, 18 divisions, provenance dans `catalog.lock.json`).

## Principe : un seul cerveau
`CANAL → normalisation → identification → mémoire → intention → SERVICE ORCHESTRATEUR CYRUS → sélection du/des spécialiste(s) → spécialiste (avis) → retour à l'Orchestrateur → validation → Tool Registry → exécution → vérification → réponse`.
Un spécialiste analyse, propose, prépare un brouillon, DEMANDE un outil. Il n'exécute rien, ne parle jamais au client, n'a aucun outil ni secret. Le client perçoit UN SEUL Cyrus.

## Modules (`ai-engine/agents/`)
- `agentRegistry.js` : fiche de chaque agent (id, capacités, domaines, outils compatibles LECTURE, plateformes, modalités, risque, permissions, version, statut, règles), activation/désactivation par compte, validation de chaînes, traçabilité. Agents « orchestrateur » du catalogue (`agents-orchestrator`, `specialized-chief-of-staff`, `specialized-workflow-architect`, `specialized-master-plan-architect`, `automation-governance-architect`) : **bloqués**.
- `specialistSelector.js` : besoins déduits du CONTEXTE (intention, étape, sujets, médias, complexité) → capacités → scoring → filtres (statut, audience, risque) ; arbitrage IA parmi la présélection seulement (propriétaire).
- `specialistRunner.js` : consultation via l'AI Gateway, contrat d'exécution, sortie filtrée (secrets masqués, injections neutralisées, brouillon suspect supprimé).
- `orchestrationService.js` : coordination (séquentielle/parallèle), outils LECTURE exécutés par l'Orchestrateur via le Tool Registry (sous le principal, tour teinté), écritures = propositions, synthèse en une voix.

## Branchements
- Client (WhatsApp/Telegram, DM et groupes) : `autoResponder.composeReply` — uniquement pour intérêt / objection / closing / négociation / plainte ; jamais salutation, remerciement, refus, paiement, contexte sensible. Le spécialiste rend un avis ; Cyrus écrit la réponse finale (garde-fous Service métier inchangés). Les appels comptent dans le MÊME échange que la limite de 10/h/client.
- Propriétaire (Web, self-chat WhatsApp, Telegram) : `chatOrchestrator.handleInner` (demandes libres et demandes d'analyse/stratégie).
- Service métier : `specialists` (recommandés), `lifecycle` (active/paused/disabled), `audience`, `period`, `source`, `initialMessage`, `closing`, `escalation`, `knowledge`.
- Outils propriétaire : `listSpecialists`, `setSpecialistStatus`.
- Variable : `SPECIALISTS_ENABLED=false` coupe tout (retour au comportement précédent).

## Mise à jour du catalogue
`node scripts/sync-agency-agents.js` (clone superficiel du dépôt officiel, validation, bascule atomique ; l'ancien catalogue est conservé si le nouveau est invalide). `--from <dossier>` pour un clone local, `--dry-run` pour valider seulement.

## Claude Code (bibliothèque réutilisable, hors Cyrus)
Installée par l'installeur officiel : `bash scripts/install.sh --tool claude-code --no-interactive` → 279 agents dans `~/.claude/agents/` (niveau utilisateur : disponibles dans tous les projets). Clone conservé dans `~/.claude/tools/agency-agents` : mise à jour = `git pull` puis relancer l'installeur. Ne modifie ni le modèle ni le système interne de Claude : ce sont de simples fichiers d'agents que Claude Code charge au démarrage d'une session.

## À porter (règle PC + téléphone)
`local-client/` et `mobile/webapp/` : catalogue + `ai-engine/agents/` + branchements (voir `docs/PORTAGE-LOCAL-MOBILE.md`).
