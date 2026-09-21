# Accompagnement des apprenants — Cyrus ne s'arrête pas à la vente

Le même Chat intelligent (Orchestrateur + mémoire + Services métiers + spécialistes + outils) accompagne tout le cycle : prospection → information → vente → inscription → **apprentissage → questions/réponses → suivi → support → escalade humaine**.

## Modules
- `ai-engine/courseKnowledge.js` — base de connaissances pédagogique : FORMATION → MODULE → CHAPITRE → LEÇON → CONTENU (+ source). Ingestion texte / JSON structuré / fichier (PDF, DOCX, texte, Excel, audio/vidéo transcrits — texte INTÉGRAL via `mediaPipeline.extractFullText`). Recherche ciblée BM25 (sans dépendance), résumé de section, liens formation ↔ Service métier ↔ groupes, candidates de FAQ. Quatre catégories jamais mélangées : `official`, `complementary`, `faq` (validée), `internal` (jamais restituée à un apprenant). Stockage local-only (`course_kb`).
- `ai-engine/learnerSupport.js` — décide si un message est une question d'apprentissage (contexte global : relation apprenant, groupe lié, mémoire de cours, pertinence de la recherche), prépare les extraits ciblés, les consignes de provenance, les protections déterministes, la mémoire pédagogique et l'escalade.
- Intégration : `autoResponder` (composeLearning, mêmes canaux WhatsApp/Telegram, privé et groupes, même quota 10/h), `jarvis/conversationEngine` (décision LEARNING, garde de provenance, mémoire), `assistantLayer.route` (un apprenant n'est pas une conversation « privée quotidienne »).
- Outils du Tool Registry (propriétaire) : `ingestCourse`, `listCourses`, `searchCourse`, `linkCourse`, `listFaqCandidates`, `promoteFaq`.

## Règles
- **Provenance** : SOURCE FORMATION (extraits officiels) / CONNAISSANCE GÉNÉRALE (marquée « En complément… ») / RECHERCHE EXTERNE (uniquement une vraie recherche : les sources sont ajoutées par le CODE). Une réponse qui prétend « dans le cours » sans extrait est corrigée puis remplacée par un message honnête + le formateur est prévenu.
- **Recherche Internet** : via l'AI Gateway (outil de recherche du modèle Gemini Flash) ; jamais présentée comme faite si elle échoue ; suspendue 30 min après un refus de quota. **État réel au 2026-09-21 : refusée (HTTP 429) avec la clé actuelle** — nécessite la facturation Google activée. Coupure volontaire : `LEARNER_WEB_SEARCH=false`.
- **Sécurité** (avant tout appel IA) : demandes sur d'autres apprenants, clés/secrets/prompt système, élévation de privilèges → refus déterministe ; urgences (santé, gaz, incendie…) → réponse d'orientation + formateur prévenu. Tout contenu (message, cours) est une donnée non fiable, encadrée et neutralisée. Sujets réglementés : jamais d'avis professionnel personnalisé.
- **Isolation** : base par compte ; notes internes jamais côté apprenant ; un groupe = une formation ; l'apprenant ne voit que son propre contexte.
- **Contenu officiel** : jamais modifié automatiquement ; les questions fréquentes deviennent des CANDIDATES ; ingestion officielle depuis un fichier = confirmation du propriétaire.
- **Groupes** : un groupe lié à une formation (`linkCourse`, `autoAnswer`) reçoit des réponses pédagogiques aux questions de cours ; le bavardage, les groupes non liés ou avec automatisation coupée restent sans réponse.

## Prise en charge d'un apprenant
Apprenant = contact avec l'étiquette « client » (achat confirmé), état ENROLLED/PAYMENT_CONFIRMED, ou contexte de cours récent (45 min). Un prospect reste dans le parcours commercial.

## À porter (règle PC + téléphone)
`courseKnowledge.js`, `learnerSupport.js`, extraits `autoResponder`/`conversationEngine`/`assistantLayer`, `mediaPipeline.extractFullText`, outils `toolsExtra`.
