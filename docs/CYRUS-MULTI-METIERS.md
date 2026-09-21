# Cyrus multi-métiers — cycle de vie, auto-connaissance, guidage, rapport, auto-amélioration

Le **Service métier** est la racine : la formation n'en est qu'un cas. Tout ce qui suit est indépendant du métier (commerce, restaurant, prestation, e-commerce, formation…). Aucun second Chat / Orchestrateur : tout passe par le Service Orchestrateur, le Tool Registry et les canaux existants.

## Modules (ai-engine/)
| Module | Rôle |
|---|---|
| `customerLifecycle.js` | Dossiers (ORDERED → PAYMENT_PENDING → PAID → IN_PROGRESS → DELIVERED / CANCELLED), SAV dédoublonné, relances/suivis. **10 vérifications au moment d'envoyer** (statut, dernier échange, action déjà faite, conversion, activité récente, opt-out, Service actif, campagne/source, permission, décision SEND/WAIT/CANCEL/HUMAN). Sans autorisation propriétaire (`followUps:true` ou `FOLLOWUPS_ENABLED=true`) → HUMAN. Livraison ⇒ suivi planifié ; paiement en attente ⇒ relance de paiement. |
| `cyrusSelf.js` | Auto-connaissance : capacités lues dans les registres réels (outils autorisés, agents, Services métiers, canaux connectés, réglages). Première personne. Présentation adaptative BESOIN → CE QUE JE PEUX FAIRE → EXEMPLE → BÉNÉFICE → PROCHAINE ÉTAPE ; demande l'activité si inconnue. Modes EXPLIQUE-MOI / GUIDE-MOI / FAIS-LE. Jamais de modèle/fournisseur/clé. |
| `guidedSetup.js` | Guidage pas à pas (10 plans) : chaque étape est vérifiée sur l'état RÉEL du compte, pas sur la parole de l'utilisateur. |
| `activityIntelligence.js` | Rapport & Activité (fait / pas fait / bloqué / à améliorer / amélioré + comment + résultat), filtres, isolation par compte ; boucle OBSERVATION → DIAGNOSTIC → RECOMMANDATION → action / validation / technique ; mesure avant/après ; analyse par les spécialistes (données réelles seulement). |
| `toolsLifecycle.js` | Outils : recordOrder, updateOrderStatus, listOrders, openSavCase, resolveSavCase, listSavCases, planFollowUp, listFollowUps, followUpCandidates, whyFollowUpNotSent, guideSetup, linkServiceGroup, unlinkServiceGroup, describeCapabilities, activityReport, improvementCycle, analyzeActivity. |
| `taskQueue.js` | États publics QUEUED, RUNNING, WAITING_EXTERNAL, VERIFYING, COMPLETED, FAILED, CANCELLED, PAUSED ; pause/reprise ; gestionnaire `FOLLOW_UP`. |

## Règles de sécurité de la boucle d'amélioration
- `AUTO_SAFE` (planifier un suivi/une relance — l'envoi reste soumis aux 10 vérifications) : appliqué seulement si autorisé (`selfImprove:true` ou validation propriétaire).
- `NEEDS_VALIDATION` (compléter un service, autoriser les relances) : jamais sans validation du propriétaire.
- `TECHNICAL` : jamais appliqué automatiquement.
- Une amélioration n'est « MEASURED/améliorée » qu'avec une mesure avant/après réelle ; sinon « aucune mesure comparable ».

## Groupes
`linkServiceGroup` lie un groupe à un Service métier après vérification réelle : service existant, compte connecté, groupe trouvé, statut administrateur. `autoResponder` répond dans un groupe lié d'abord sur ce service.

## Limites connues
Libellé exact de la question « activité inconnue » : formulation raisonnable (le texte d'origine n'était plus disponible). Pas de recherche web (quota). Portage PC/mobile non fait.
