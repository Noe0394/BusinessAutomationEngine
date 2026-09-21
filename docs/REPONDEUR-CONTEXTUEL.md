# Répondeur contextuel — comment il décide, comment le piloter

Tout passe par la **cascade d'IA** (AI Gateway) : rédaction des réponses, arbitrage des cas ambigus, spécialistes. Aucun appel direct à un fournisseur. Les échanges clients utilisent le niveau « standard » de la cascade (réponse spontanée) : si un modèle est lent, le suivant est lancé en parallèle.

## Le trajet d'un message (4 étapes, chacune un fichier)
1. **Contexte** — `ai-engine/conversationContext.js` : lit la mémoire des 7 jours de CETTE discussion (privée ou groupe) : thèmes, service concerné (affinité), température business (froide/tiède/chaude), présentation récente de mes services, participants, échange entre deux membres, mes réponses des 10 dernières minutes. Aucun réseau, aucune IA : quelques millisecondes.
2. **Politique** — `ai-engine/conversationPolicy.js` : ce que vous réglez (voir plus bas).
3. **Engagement** — `ai-engine/engagement.js` : décide *répondre ou non*, *sur quel registre*, *présenter un service ou non*, et **explique pourquoi** (`code` stable + phrase en français). Cas ambigus (`uncertain`) : la cascade d'IA tranche en moins de 1,8 s ; sans réponse à temps, les règles s'appliquent. Les règles dures (politique, plafond, échange entre membres, sujet sensible, refus) ne sont jamais contournées.
4. **Rédaction** — `autoResponder.composeReply` + `jarvis/conversationEngine` : l'IA écrit ; les garde-fous existants (pas de prix inventé, pas de « fait » sans preuve, quota 10/h, anti-boucle) restent en place.

## Les registres
| Registre | Quand | Effet |
|---|---|---|
| NATURAL | discussion courante, aucun lien avec l'activité | discuter, aucune offre/prix cités |
| NATURAL_CONTINUITY | salutation après une discussion business récente | saluer + rappeler le fil en une phrase, sans relance |
| BUSINESS_ANSWER | question sur l'activité | réponse précise, sans re-présenter |
| PRESENT_SERVICE | on demande ce que je propose / sujet s'y prête et pas présenté récemment | présenter le service concerné (ou tous, brièvement) + une question |
| GROUP_ANSWER | groupe : on s'adresse à moi ou vraie question sur le thème d'un groupe métier | réponse brève (1 à 3 phrases) |

## Pilotage (trois réglages + exceptions)
- **Discussions privées** : `auto` (défaut) · `natural` · `business`
- **Groupes** : `topic` (défaut) · `addressed` (mention / réponse à mon message / mon nom) · `off`
- **Présenter mes services** : `when-relevant` (défaut) · `on-request` · `never`
- **L'IA tranche les cas ambigus** : oui (défaut) / non ; mémoire 1–7 jours ; plafond de réponses par groupe.
- **Exceptions** par discussion/groupe (ex. un groupe en `addressed`, un contact en `natural`).
Où : tableau de bord → Chat Intelligent → 🤖 → « Comportement du répondeur » ; ou dans le chat (site, self WhatsApp/Telegram) : « Dans le groupe X, réponds seulement si on me mentionne », « Ne parle jamais business à Awa », « Montre le comportement du répondeur ».

## Comprendre une décision
« Pourquoi as-tu répondu / pas répondu à X ? » → relit le journal des décisions (code + raison). Outil `describeConversation` : ce que je sais d'une discussion d'après les 7 jours.

## Groupes : règles par défaut (mode `topic`)
Silence sur les conversations entre membres · réponse si mention / réponse à mon message / mon nom · réponse brève à une vraie question sur le thème d'un groupe **lié à votre activité** (groupe lié à un service, ou thèmes des 7 jours proches d'un service) · jamais dans un échange à deux · plafond de réponses par 10 minutes.

## À porter (PC + téléphone)
`conversationContext.js`, `conversationPolicy.js`, `engagement.js`, `toolsConversation.js`, extraits `autoResponder`/`conversationEngine`, intention `convpolicy`, adressage WhatsApp (`waAddressing` dans index.js), routes `/api/conversation-policy`, panneau « Comportement du répondeur ».
