const llmFallbackEngine = require('../lib/ai/llmFallbackEngine');
const taskParser = require('../lib/intelligence/task-parser');
const goalChat = require('../lib/intelligence/goal-chat');
const offerClarifier = require('./offerClarifier');
const personaManager = require('./personaManager');
const platformOrchestrator = require('./platformOrchestrator');
const connectorManager = require('./connectors/connectorManager');
const businessServices = require('./businessServices');
const toolRegistry = require('./toolRegistry');
const authz = require('./authz');
const specialists = require('./agents/orchestrationService');
const untrustedWrap = (label, t) => require('./untrusted').wrap(label, t, 4000);
const toolAgent = require('./toolAgent');
const agentLoop = require('./jarvis/agentLoop');
const memoryQuery = require('./memoryQuery');
const manualPaymentValidator = require('./manualPaymentValidator');
const contactCrm = require('./contactCrm');
const recurringTasks = require('../queues/recurringTasks');
const messageHistory = require('./messageHistory');
const actionLedger = require('./actionLedger');
const conversationRouter = require('./conversationRouter');
const alertCenter = require('./alertCenter');
const contactIdentity = require('./contactIdentity');
const missionOrchestrator = require('./missionOrchestrator');

// Tous les modèles appelés pendant un tour du Chat Intelligent ou du Self
// WhatsApp/Telegram ont un budget court. Les missions longues sont transférées
// au moteur de missions persistant et poursuivies en arrière-plan.
function generateInteractive(prompt, history, meta) {
  return llmFallbackEngine.generateAIResponse(prompt, history || [], null, undefined, null, Object.assign({
    purpose: 'owner_chat', tier: 'standard', interactive: true,
    interactiveBudgetMs: 2800, interactiveProviderTimeoutMs: 1800,
  }, meta || {}));
}

// CHAT-DRIVEN AGENT ORCHESTRATOR — ai-engine/chatOrchestrator.js
// ---------------------------------------------------------------------------
// Point d'entrée UNIQUE demandé par le cahier des charges : chaque message
// saisi dans la fenêtre de tchat principale (Copywriter Studio IA côté VPS,
// voir index.js#POST /api/ai-studio/sessions/:id/messages) est interprété
// comme une instruction de pilotage AVANT d'être traité comme un simple
// message de conversation.
//
// NE RÉINVENTE AUCUN MOTEUR — compose 3 systèmes déjà existants et éprouvés
// dans ce dépôt (voir docs/PARITE-LOCAL.md pour le détail de cette
// découverte) :
//   - ai-engine/offerClarifier.js : nouvelle offre -> questions structurées.
//   - lib/intelligence/{task-parser,goal-chat}.js : objectif business
//     (ventes/prospection/contenu/relance/rapport/comptes) -> plan de tâches
//     multi-canal, exécuté via le MÊME automation-engine que
//     /api/intelligence/goal-chat (voir `deps.engineFor`, injecté par
//     index.js depuis lib/intelligence/vps-bridge.js — jamais un second
//     moteur construit ici, ce qui fragmenterait l'idempotence par runId).
//   - lib/intelligence/action-executor.js (18 actions) : exécution directe
//     et immédiate des outils "un coup" (paiement, remise, compte élève,
//     accès module, rapport) via `deps.runtime.actionExecutor.execute(...)`
//     — jamais la file de tâches différées de l'automation-engine, inutile
//     pour une action synchrone à répondre dans le tour de tchat courant.
//
// Contrairement à l'UI Goal Chat existante (bouton "🚀 Oui, lancer
// maintenant"), ce module ne montre jamais de bouton — mais n'exécute plus
// non plus AUTOMATIQUEMENT une campagne dès que le plan est prêt (revu suite
// au cahier des charges "Human-like Dialogue", voir ai-engine/personaManager.js) :
// pour 'goal' (une campagne, potentiellement coûteuse/visible par de vrais
// clients), l'Agent reformule chaleureusement la mission et DEMANDE
// confirmation avant de lancer — l'exécution ne démarre qu'au message
// suivant si le vendeur confirme (voir personaManager.detectAffirmative),
// et tourne alors EN ARRIÈRE-PLAN (réponse immédiate + notification de fin
// via platformOrchestrator.notifyTenantChat, jamais de latence perçue —
// "Fluid Streaming", §2 du cahier des charges). Les actions "un coup" plus
// légères (paiement, remise, compte élève, accès module, rapport) restent
// exécutées dès que prêtes : leur coût/risque est sans commune mesure avec
// une campagne envoyée à de vrais contacts.

function extractJsonBlock(rawText) {
  const match = String(rawText || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (err) { return null; }
}

// Pas de `\b` final volontairement (voir lib/intelligence/task-parser.js#detectGoals,
// même convention) : les racines ci-dessous (vend, prospect, relanc, analys,
// encaiss, negoci, debloque...) sont volontairement TRONQUÉES pour capter
// toutes leurs formes conjuguées/dérivées (vendre/vends/vendu, prospecter/
// prospection, relance/relancer, analyser/analyse, encaisser/encaisse,
// négocie/négocier, débloque/débloquer...) — un `\b` final les aurait
// bloquées à tort (ex: /\bvend\b/ ne matche jamais "vendre").
const REPORT_RE = /(o[uù]\s+en\s+(?:est|sont)|bilan\s+(?:du\s+jour|de\s+la\s+journ[ée]e|de\s+la\s+semaine|des\s+ventes)|statut\s+de|rapport\s+de|comment\s+(?:vont|se\s+portent)|combien\s+de\s+ventes|r[ée]sultats?\s+du\s+jour)/i;
const PAYMENT_RE = /(lien\s+de\s+paiement|\bpayer\b|\bpaiement\b|encaiss|mobile\s?money|orange\s?money|mtn\s?money|moov\s?money|\bwave\b|\bremise\b|r[ée]duction|\brabais\b|n[ée]goci)/i;
const ACCOUNT_RE = /(compte\s+(?:[ée]l[eè]ve|[ée]tudiant|client)|cl[ée]\s+d.?acc[èe]s|acc[èe]s\s+(?:[ée]l[eè]ve|module|au\s+module)|g[ée]n[èe]re?\s+un\s+acc[èe]s|d[ée]bloque|inscri(?:s|re|t)|enr[ôo]le|suspend|d[ée]sactive)/i;
// Actions "plateforme externe" (connecteurs pilotés par les permissions du
// vendeur, voir ai-engine/connectors/) : ajout de contact/tag CRM, inscription
// sur une plateforme tierce, comptabilité... CYRUS n'est PAS limité à une
// plateforme précise — les mots-clés ci-dessous sont volontairement TRONQUÉS
// (contact/tag/inscri/factur/vente) pour capter leurs formes dérivées, comme
// task-parser.js. Le handler ne propose au LLM que les outils réellement
// autorisés pour ce tenant (getToolsForTenant) — s'il n'y en a aucun, il
// retombe sur le flux compte interne classique.
// NB : "contact" seul est volontairement EXCLU (trop générique — "prospecter
// 100 contacts" est un objectif, pas une action connecteur) ; on exige un
// verbe/contexte explicite (ajoute … contact / system.io / crm / tag / facture).
const CONNECTOR_RE = /(ajoute[rz]?\s+(?:ce\s+|le\s+|un\s+|mon\s+)?contact|\btague?r?\b|\btags?\b|system\.?io|systeme\.?io|\bcrm\b|factur|enregistre?\s+(?:la|une|cette)\s+vente|journal\s+des\s+ventes)/i;
// Lecture de la boîte de réception (prouver la connexion réelle + citer un
// vrai message/expéditeur). Volontairement placé AVANT 'goal' dans
// detectIntent : "dernier message reçu" ne doit pas être happé par le moteur
// d'objectifs.
const INBOX_RE = /((?:as|ai|avez)-?\s*(?:tu|je|vous)\s+re[çc]u\s+(?:des?\s+|de\s+)?(?:nouveaux?\s+)?(?:messages?|nouvelles?)|derniers?\s+messages?|messages?\s+re[çc]us?|qui\s+m.?a\s+(?:écrit|ecrit|envoy[ée]|contact[ée])|num[ée]ro\s+de\s+l.?exp[ée]diteur|\bexp[ée]diteur\b|bo[îi]te\s+de\s+r[ée]ception|\binbox\b|(?:es|est)-?\s*tu\s+(?:vraiment\s+)?connect[ée]|connect[ée]\s+[àa]\s+mon\s+(?:whatsapp|telegram)|montre(?:-|\s+)(?:moi\s+)?mes\s+messages)/i;
// Consultation des groupes (liste, "où je suis admin", filtre par sujet).
// Placé AVANT 'goal' (GOAL_RE capte "groupes"/"membres") : une QUESTION sur les
// groupes ne doit pas lancer le moteur d'objectifs. La véritable exécution
// ("écris aux membres du groupe X …") reste gérée par 'goal' (à enrichir).
const GROUPS_RE = /(mes\s+groupes?|liste[rz]?\s+(?:mes\s+)?groupes?|quels?\s+(?:sont\s+)?(?:mes\s+)?groupes?|combien\s+de\s+groupes?|groupes?\s+(?:dont|o[ùu])\s+je\s+suis\s+admin|groupes?\s+que\s+j.?administre|mes\s+groupes?\s+admin)/i;
const GROUPS_LOOKUP_RE = /\b(?:list\w*|montre\w*|affiche\w*|donne\w*|dis[- ]moi|quel(?:s|les)?|combien|trouve\w*|cherch\w*|recherch\w*)\b[^.?!]{0,100}\bgroupes?\b/i;
const SEND_LIST_TO_REQUESTER_RE = /\b(?:envoi\w*|transmets?)\s*[- ]?\s*moi\s+(?:la\s+)?liste\b/i;
// « Cherche/trouve le groupe Épicerie » : recherche parmi MES PROPRES groupes connectés (jamais la découverte publique, déjà couverte par
// COMMUNITY_SEARCH_RE et vérifiée avant ce point) — même intention 'groups', avec extraction du nom recherché (voir handleGroups ci-dessous).
const GROUP_SEARCH_MINE_RE = /\b(?:cherch\w*|trouve\w*|recherch\w*|montre\w*|affiche\w*)\b[^.?!]{0,15}\b(?:mon|le|un|ce)?\s*groupes?\b/i;
// Consultation du CRM (contacts étiquetés prospect/client, comptages).
// AVANT 'goal' (GOAL_RE capte "prospect") : une question sur les contacts
// étiquetés ne doit pas lancer le moteur d'objectifs.
const CRM_RE = /(mes\s+(?:prospects?|clients?|contacts?)|combien\s+de\s+(?:prospects?|clients?|contacts?)|contacts?\s+[ée]tiquet|contacts?\s+tagg?[ée]s?|liste[rz]?\s+(?:mes\s+)?(?:prospects?|clients?|contacts?)|qui\s+sont\s+mes\s+(?:prospects?|clients?)|mes\s+[ée]tiquettes)/i;
// Tâches récurrentes ("chaque matin envoie X au groupe Y") + gestion (liste,
// arrêt). Placé AVANT 'grouppost' : un envoi récurrent est d'abord une
// programmation, pas un envoi immédiat.
const RECURRING_RE = /(chaque\s+(?:matin|jour|soir|semaine|nuit|midi|\d{1,2}\s*h)|tous\s+les\s+(?:matins|jours|soirs)|chaque\s+jour|t[âa]ches?\s+r[ée]curren|r[ée]currente?s?\b|automatiser?\b|programme[rz]?\s+(?:un\s+)?(?:message|envoi)\s+quotidien)/i;
// Publication/partage DANS un ou des groupes (poste ça dans le groupe X, envoie
// à tous mes groupes admin). Exclut "membre" (là c'est un envoi aux MEMBRES en
// DM = 'goal'/campagne, pas une publication dans le groupe).
const GROUPPOST_RE = /(poste|publie|partage|diffuse|balance|envoi[e]?)\w*[^]{0,80}?(groupe|groupes|canal|canaux)/i;
// Réponse RÉELLE au dernier message (ou à un contact nommé), avec vérification.
// NB : « \b » ne fonctionne pas après une lettre accentuée en JavaScript ("à\b" ne matche jamais) : on utilise (?=\s) à la place.
const REPLY_RE = /(r[ée]ponds?(?:\s|-)?(?:lui|leur|(?:à|a)(?=\s))|r[ée]pondre\s+(?:à|a)(?=\s)|dis(?:\s|-)?lui|renvoie(?:\s|-)?lui|r[ée]pond(?:s|re)\s+(?:au|à|a)(?=\s))/i;
// File d'attente du propriétaire : conversations qui attendent son intervention, paiements à valider, messages/alertes
// importants (états RÉELS lus dans les conversations, actions en attente et alertes — jamais inventés).
const OWNERQUEUE_RE = /((conversations?|discussions?|personnes?|contacts?|gens|messages?)[^]{0,40}(n[ée]cessit\w*|attend\w*|demand\w*|requi\w*|exig\w*)[^]{0,25}\b(mon|ma|ton|ta)\s+(intervention|r[ée]ponse|attention))|(qui\s+attend\w*\s+(ma|mon|ta|ton)\s+(r[ée]ponse|intervention))|((paiements?|preuves?\s+de\s+paiement)[^]{0,30}(en\s+attente|[àa]\s+valider|non\s+valid[ée]s?))|(en\s+attente\s+de\s+(validation|ma\s+d[ée]cision))|(ai[- ]?je\s+(re[çc]u|des?)[^]{0,30}(message|alerte)s?[^]{0,15}important\w*)|(j.?ai\s+(re[çc]u|des?)[^]{0,30}(message|alerte)s?[^]{0,15}important\w*)|(messages?\s+importants?)|(qu.?est[- ]ce\s+qui\s+(m.?attend|attend\s+ma|est\s+urgent))|(mes\s+alertes)|(reste[- ]t[- ]il\s+quelque\s+chose\s+[àa]\s+traiter)|(\b[àa]\s+traiter\b)/i;
// Configuration d'une campagne publicitaire Facebook/Meta (Click-to-WhatsApp) : message d'accueil exact pour les nouveaux
// contacts qui en proviennent. Exige à la fois la publicité Facebook ET une notion de contacts/messages reçus.
const ADCAMPAIGN_RE = /((facebook|meta|\bfb\b)\s*ads?\b|publicit[ée]s?\s+(?:sur\s+)?(?:facebook|meta)|\bpub\s+(?:sur\s+)?facebook|campagne\s+(?:publicitaire\s+)?(?:sur\s+)?(?:facebook|meta)|annonces?\s+(?:sur\s+)?facebook)[^]{0,600}(nouveau|nouveaux|contacts?|prospects?|[ée]cri(?:vent|ront|t)\b|arriv\w+|re[çc]oiv\w+|message\s+d.accueil|message\s+automatique|message\s+pr[ée]par[ée])|((nouveau|nouveaux|contacts?|prospects?)[^]{0,120}(facebook|meta)\s*ads?\b)/i;
// Campagne programmée sur les groupes ADMINISTRÉS dont le nom contient un mot-clé (durée, horaires, messages, intérêt -> paiement).
const GROUPCAMPAIGN_TARGET_RE = /(cible\w*|envoi\w*|diffuse\w*|poste\w*|publie\w*|lance\w*|programme\w*|lanc\w*)[^]{0,160}groupes?[^]{0,160}(nom|intitul\w+|titre)[^]{0,30}(contien\w+|contenant|comportant|comprenant)/i;
const GROUPCAMPAIGN_TIME_RE = /(pendant|durant|chaque\s+jour|tous\s+les\s+jours|\d{1,2}\s*h\b|\bmatin\b|\bmidi\b|\bsoir\b|semaine|\bmois\b|\bjours?\b)/i;
const GROUPCAMPAIGN_REPORT_RE = /((rapport|bilan|suivi|r[ée]sultats?|progression|avancement|statistiques?|o[ùu]\s+en\s+est|o[ùu]\s+en\s+sommes)[^]{0,70}campagne[^]{0,70}(groupes?|[ée]picerie)|campagne\s+de\s+groupes?[^]{0,50}(rapport|bilan|r[ée]sultats?|progress|avancement)|objectifs?[^]{0,50}(atteint|progress|o[ùu]\s+en|avancement))/i;
const GROUPCAMPAIGN_STOP_RE = /(arr[êe]te\w*|stoppe\w*|annule\w*|suspend\w*)[^]{0,50}campagne[^]{0,50}groupes?/i;
const GROUPGOAL_RE = /objectifs?[^\n]{0,70}?\d[\d\s.,]*\s*(fcfa|f\s?cfa|xof|cfa|€|eur|euros?|usd|\$)/i;
// Supervision : "qu'as-tu fait / statut de tes actions / rapport de tes envois".
const ACTIONS_RE = /(qu.?as-?tu\s+fait|tes\s+actions|actions\s+r[ée]centes|statut\s+de[s]?\s+actions|rapport\s+de[s]?\s+(?:tes\s+)?(?:actions|envois)|historique\s+de[s]?\s+actions)/i;
const GOAL_RE = /(\bcampagne|\bvend|\bvente|prospect|groupes?|membres?|publier|poster|\bcontenu|relanc|follow\s?up|\bsuivi|rappel|analys|\brapport|\bbilan)/i;
// Question FACTUELLE sur l'activité configurée dans l'onglet Services Métiers
// (prix, tarif, produit, formation, offre, catalogue, règle, objectif). Le
// chat doit y répondre depuis les VRAIES données (businessServices), jamais en
// inventant — c'est le maillon "DONNÉES → INTELLIGENCE" qui manquait. Exige un
// cue de CONSULTATION (quel/combien/liste/montre/rappelle… OU « prix de … »)
// pour ne PAS happer un ordre d'action ("présente ma formation à ce client" =
// action, pas une question). Placé APRÈS toutes les intentions d'action et
// juste AVANT 'goal' : une vraie commande garde la priorité.
const BUSINESSINFO_RE = /((?:\bquel(?:le|s|les)?\b|\bcombien\b|c(?:'|’)?est\s+(?:quoi|combien)|\bliste[rz]?\b|\bmontre|\baffiche|\brappelle|\bdonne(?:-|\s)moi|\bc'est\s+quoi)[^]{0,60}(?:prix|tarif|co[ûu]te?|produits?|formations?|offres?|services?|catalogue|r[èe]gles?|objectifs?|horaires?|dates?|promotions?|paiement|livraison|localisation|conditions?|activit[ée]|FAQ|num[ée]ro))|((?:prix|tarif|horaire|date|promotion|paiement|livraison)\s+(?:de|d'|du|de\s+la|de\s+ma|de\s+mon)\b)|(mes\s+(?:produits?|offres?|formations?|r[èe]gles?|objectifs?|tarifs?|horaires?|promotions?|conditions?)\b)|(mon\s+catalogue\b)/i;
// Configuration d'un Service Métier PAR LE CHAT (création / connexion API /
// permissions). Placé AVANT payment/account/businessinfo/goal.
const CONFIGSVC_RE = /((cr[ée]e?r?|configur|param[èe]tr|enregistre?|ajoute?r?|mets?\s+en\s+place)\w*[^]{0,40}(service\s+m[ée]tier|nouveau\s+service|mon\s+service|activit[ée]|business))|((connect|branch|relie?|lie?)\w*[^]{0,30}(api|plateforme|passerelle|system\.?io))|(configure?r?\s+mon\s+api)/i;
const SERVICE_UPDATE_RE = /\b(?:ajout\w*|chang\w*|modifi\w*|remplac\w*|corrig\w*|actualis\w*|mets?\s+(?:[àa]\s+)?jour|pr[ée]cis\w*)\b[^]{0,120}\b(?:promo(?:tion)?|prix|tarif|paiement|wave|orange\s+money|mtn\s+money|moov|num[ée]ro|t[ée]l[ée]phone|horaire|ouverture|date|livraison|localisation|faq|r[èe]gle|condition|offre|produit|service)\b/i;
// Import de contacts en masse depuis un fichier joint dans le chat.
const IMPORTCONTACTS_RE = /((importe?r?|charge?r?|ajoute?r?|int[èe]gre?r?)\s+(ces?|les?|mes?|mon|ma|ce|le|un|des)?\s*(contacts?|fichier|liste|excel|csv))|(importe?r?\s+(ce|le)\s+fichier)/i;
// Génération d'un média (affiche/image/visuel) — hors publication de groupe.
const GENMEDIA_RE = /(g[ée]n[èe]re?r?|cr[ée]e?r?|fabrique?r?|dessine?r?|fais(?:-|\s)moi|con[çc]ois)\w*[^]{0,25}(affiche|image|visuel|flyer|banni[èe]re|logo|illustration|poster|carte|design)/i;

// Détection d'intention (Command Parsing, §1.1 du cahier des charges) —
// zéro appel réseau, comme index.js#detectStudioIntent dont ce module étend
// le principe. `lastAssistantMessage` (voir même mécanisme de "reprise du
// fil" que index.js#POST .../messages) fait gagner la continuation d'une
// intention en cours sur toute reclassification par mots-clés du nouveau
// message, exactement comme pour image/vidéo/livre.
// COMMUNAUTÉS : créer/inviter dans un groupe, ou découvrir des groupes/canaux publics par thème. Traitées par l'AGENT À OUTILS (Tool Registry :
// createCommunityGroup / discoverCommunities…), donc avec PREPARE → confirmation → exécution → vérification.
const COMMUNITY_BUILD_RE = /(?:\bcr[ée]{1,2}\w*|\bmonte\w*|\bouvre\w*|\bconstitue\w*|\bmets?\s+en\s+place|\bfai(?:s|re)\s+un|\binvite\w*|\bajoute\w*)\b[^.?!]{0,60}\b(?:(?:un|une|le|la|mon|ma|ce|cette|nouveau|nouvelle)\s+)?(?:groupes?|communaut[ée]s?)\b/i;
const COMMUNITY_SEARCH_RE = /(?:\btrouve\w*|\bcherche\w*|\brecherche\w*|\bd[ée]couvre\w*|\bidentifie\w*|\brep[èe]re\w*|\bd[ée]niche\w*)\b[^.?!]{0,60}\b(?:groupes?|canaux|cha[iî]nes?|communaut[ée]s?)\b[^.?!]{0,40}\b(?:publics?|th[ée]matiques?|sur|autour|li[ée]s?|d['’]int[ée]r[êe]t)\b|\b(?:groupes?|canaux)\s+(?:publics?\s+)?(?:whatsapp|telegram)\s+(?:sur|autour|du|d['’]|pour)\b/i;

// --- Cyrus multi-métiers : auto-connaissance, guidage pas à pas, cycle de vie client (relances/SAV/commandes), rapport d'activité ---
const GUIDE_START_RE = /\b(?:guide[zr]?[- ]moi|guidez[- ]moi|accompagne[zr]?[- ]moi|pas [àa] pas|[ée]tape par [ée]tape)\b/i;
const GUIDE_STEP_RE = /^\s*(?:suivant|c['’]est fait|fait|termin[ée]|j['’]ai fini|ok(?:\s+suivant)?|v[ée]rifie(?:s)?|on continue|continue)\s*[.!]*\s*$/i;
const LIFE_CANDIDATES_RE = /(?:\bquels?\s+(?:prospects?|clients?)\b[^.?!]{0,60}\b(?:relanc|suivi|recontact)|\b(?:prospects?|clients?)\b[^.?!]{0,40}\b(?:doivent|devrais[- ]je|faut[- ]il)\b[^.?!]{0,30}\brelanc|\bcommandes?\s+livr[ée]es?\s+sans\s+suivi|\bqui\s+(?:dois[- ]je|faut[- ]il)\s+relancer)/i;
const LIFE_WHY_RE = /pourquoi\b[^.?!]{0,60}\brelance\b[^.?!]{0,60}\b(?:pas|non|jamais)\b[^.?!]{0,20}\benvoy/i;
const LIFE_SAV_RE = /(?:\b(?:dossiers?|r[ée]clamations?|cas)\s+(?:sav|ouverts?|en cours)\b|\bsav\b[^.?!]{0,30}\b(?:ouverts?|en cours|quels|liste)\b|\bquels?\s+(?:sont\s+)?(?:les\s+)?(?:dossiers?\s+)?sav\b)/i;
const LIFE_ORDERS_RE = /(?:\b(?:liste|montre|affiche|quelles?\s+sont)\b[^.?!]{0,30}\b(?:mes\s+|les\s+)?(?:commandes?|r[ée]servations?|dossiers?\s+clients?)\b|\bcommandes?\s+(?:en attente|non pay[ée]es?|en cours)\b)/i;
const ACTIVITY_REPORT_RE = /(?:rapport\s+(?:d['’]\s*)?(?:activit[ée]s?|d['’]intelligence)|qu['’]est[- ]ce qui\s+(?:a\s+[ée]t[ée]|est)\s+(?:fait|bloqu[ée]|am[ée]lior[ée])|ce qui\s+(?:est|a\s+[ée]t[ée])\s+bloqu[ée]|\bque\s+(?:dois[- ]tu|faut[- ]il)\s+am[ée]liorer|comment\s+(?:t['’]es[- ]tu|tu\s+t['’]es)\s+am[ée]lior|analyse\s+(?:mon|l['’])\s*activit[ée])/i;
const SELF_QUESTION_RE = /(?:^|\b)(?:qui es[- ]tu|pr[ée]sente[- ]toi|que (?:peux|sais)[- ]tu faire|qu['’]est[- ]ce que tu (?:peux|sais) faire|quels?\s+(?:sont\s+)?(?:tes|les)\s+(?:outils|fonctions|fonctionnalit[ée]s|capacit[ée]s|agents|services|modules)|quels?\s+(?:agents|outils)\s+(?:as|utilises|sont)|que ne peux[- ]tu pas|quelles?\s+sont\s+tes\s+limites|comment\s+(?:tu\s+)?t['’]am[ée]liores)|^\s*peux[- ]tu\s+(?:relancer|g[ée]rer|utiliser|vendre)\b[^.!]*\?\s*$/i;

// Pilotage du répondeur depuis le chat (site, self WhatsApp/Telegram) : « pourquoi as-tu répondu à X ? », « dans le groupe Y réponds seulement si on te mentionne », « arrête de parler business à Z ».
const WHY_REPLY_RE = /pourquoi\s+(?:as[- ]tu|tu\s+as|n['’]as[- ]tu\s+pas|tu\s+n['’]as\s+pas|le\s+r[ée]pondeur\s+(?:a|n['’]a\s+pas)|il\s+(?:a|n['’]a\s+pas))\s+(?:r[ée]pondu|r[ée]pond)/i;
const CONVPOLICY_RE = /(?:comportement|politique|r[èe]glages?)\s+(?:du\s+)?r[ée]pondeur|(?:dans|pour|avec)\s+(?:le\s+groupe|la\s+discussion|ce\s+groupe|ce\s+contact)\b[^.?!]{0,80}\b(?:r[ée]ponds?|parle|pr[ée]sente)\b[^.?!]{0,60}\b(?:seulement|uniquement|plus|jamais|toujours|naturel\w*|business)\b|(?:arr[êe]te|cesse|ne\s+parle\s+plus)\b[^.?!]{0,30}\b(?:business|vente|de\s+mes\s+services)\b|(?:quand|comment)\s+(?:dois[- ]tu|le\s+r[ée]pondeur\s+doit[- ]il)\s+(?:parler|r[ée]pondre|pr[ée]senter)/i;

// CONVERSATION COURANTE (salutation, question simple, échange) : aucune action ni donnée du compte demandée → réponse directe du modèle (UN appel, niveau standard, doublon
// parallèle), sans spécialistes ni boucle d'outils. Un ordre (envoyer, créer, lister, importer, programmer…), un fichier joint ou un long texte prennent le chemin complet.
// VERBES d'action uniquement (jamais un simple nom comme « service », « prix », « clients », « tarifs »…) : un nom seul dans une question
// informationnelle (« quels sont mes tarifs ? », « combien coûte le service ? ») ne doit PAS forcer le chemin lent (boucle d'outils + spécialistes) —
// seul un ordre avec un verbe d'action réel le justifie. Une question sur l'activité est déjà bien répondue par le chemin rapide (contexte métier réel
// injecté dans le prompt, voir assistantLayer.chatFallback), plus vite et sans détour inutile.
const ACTION_RE = /\b(?:envoi\w*|envoy\w+|cr[ée]e\w*|cr[ée]er|lance\w*|list\w*|donne\w*|montre\w*|affiche\w*|programm\w*|planifi\w*|import\w*|ajout\w*|ajoute\w*|supprim\w*|efface\w*|retir\w*|configur\w*|g[ée]n[èe]r\w*|publi\w*|relanc\w*|cherch\w*|trouv\w*|activ\w*|d[ée]sactiv\w*|arr[êe]t\w*|stopp\w*|pause\w*|reprend\w*|resume\w*|modifi\w*|renomm\w*|chang\w*|mets?|compt\w*|export\w*|t[ée]l[ée]charg\w*|pay\w*|valid\w*|annul\w*|connect\w*|d[ée]connect\w*|restaur\w*|r[ée]gl\w*)\b/i;
// L'avis des spécialistes ne doit jamais faire attendre : passé ce délai, on continue sans lui.
const SPECIALIST_BUDGET_MS = Math.max(0, parseInt(process.env.OWNER_SPECIALIST_BUDGET_MS, 10) || 4000);
const withSpecialistBudget = (p) => Promise.race([p, new Promise((res) => setTimeout(() => res(null), SPECIALIST_BUDGET_MS))]);
const ADDITIONAL_ACTION_RE = /\b(?:extrait\w*|inscri\w*|enregistr\w*|suspend\w*|factur\w*|fais\w*|analyse\w*|relie\w*|attribu\w*|tagu\w*)\b/i;
const COMPOSITE_RE = /\b(?:puis|ensuite|apr[eè]s|d'abord|avant de|et|ainsi que)\b/i;
const REGISTRY_READ_INTENTS = new Set(['report', 'inbox', 'crm', 'activityreport', 'actionsreport', 'lifecycle', 'businessinfo', 'payment', 'account']);
function isQuickChat(text) {
  const t = String(text || '').trim();
  return t.length > 0 && t.length <= 280 && !ACTION_RE.test(t) && !ADDITIONAL_ACTION_RE.test(t) && !/PIÈCES JOINTES reçues|\[id:\s*f_/.test(t);
}

// Short follow-ups must re-enter the tool loop when they point to real results
// from the immediately preceding turn (for example, filtering a fetched list).
const CONTEXT_REFERENCE_RE = /\b(?:ce(?:ux|lles?)(?:[- ](?:ci|l[àa]))?|ce|celui(?:[- ](?:ci|l[àa]))?|cette|ces|cet|eux|elles|leur|leurs|les mêmes?|la même|le même|parmi eux|parmi elles|them|those|these|that one|same ones|hier|avant[- ]hier|il y a (?:\d+|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix) (?:jours?|semaines?|mois))\b/i;
function hasRecentToolResult(history) {
  if (!Array.isArray(history)) return false;
  const last = [...history].reverse().find((item) => item && item.role === 'assistant');
  return !!last && (
    (last.toolCall && last.toolCall.state === 'SUCCESS' && last.toolCall.result != null)
    || (Array.isArray(last.steps) && last.steps.some((step) => step && step.state === 'SUCCESS' && step.result != null))
    || (Array.isArray(last.toolCalls) && last.toolCalls.some((call) => call && call.state === 'SUCCESS'))
  );
}
function isContextualToolRequest(text, history) {
  return hasRecentToolResult(history) && CONTEXT_REFERENCE_RE.test(String(text || ''));
}

function detectIntent(text, lastAssistantMessage) {
  const continuation = ['offer', 'payment', 'account', 'connector', 'goal', 'recurring', 'grouppost', 'reply', 'adcampaign', 'groupcampaign', 'configsvc'];
  // Une précision courte répond à la question de clarification courante.
  // Une nouvelle commande ou question repasse d'abord par sa propre intention,
  // afin qu'un ancien scénario ne capture pas un changement de sujet.
  const clarification = String(text || '').trim();
  // A verbatim message supplied after Cyrus explicitly requested the exact
  // message is the answer to that pending question, even if its content has
  // punctuation or imperative verbs.
  if (lastAssistantMessage && lastAssistantMessage.isPlanningQuestion
      && lastAssistantMessage.intent === 'adcampaign'
      && lastAssistantMessage.adDraft && lastAssistantMessage.adDraft.awaiting === 'message'
      && clarification.length > 0) return 'adcampaign';
  const canContinuePlanning = lastAssistantMessage && lastAssistantMessage.isPlanningQuestion
    && continuation.includes(lastAssistantMessage.intent)
    && clarification.length > 0 && clarification.length <= 160
    && !/[?!]/.test(clarification)
    && !ACTION_RE.test(clarification) && !ADDITIONAL_ACTION_RE.test(clarification)
    && !/^\s*(?:bonjour|salut|coucou|merci|bonne?\s+(?:journ[ée]e|soir[ée]e))\b/i.test(clarification);
  if (canContinuePlanning) return lastAssistantMessage.intent;
  if (lastAssistantMessage && lastAssistantMessage.intent === 'guide' && GUIDE_STEP_RE.test(text)) return 'guide';
  if (SELF_QUESTION_RE.test(text) && !/\d{6,}/.test(text)) return 'selfknow';
  if (WHY_REPLY_RE.test(text) || CONVPOLICY_RE.test(text)) return 'convpolicy';
  if (/\b(?:cr[ée]e\w*|cr[ée]er|ajoute\w*|ajouter)\s+(?:(?:le|la|un|une|ce|mon|nouveau|nouvelle)\s+){1,2}service\b/i.test(text) && !/\b(?:supprim|effac|retir)\w*/i.test(text)) return 'configsvc'; // création d'un Service métier : extraction + outil vérifié
  if (SERVICE_UPDATE_RE.test(text)) return 'configsvc'; // toute correction métier part dans la mémoire du service, sans remplacer le reste
  if (require('./serviceCommands').isCommand(text)) return 'svccmd'; // supprimer / mettre en pause / réactiver / restaurer un Service métier : exécution directe et vérifiée
  if (LIFE_WHY_RE.test(text) || LIFE_CANDIDATES_RE.test(text) || LIFE_SAV_RE.test(text) || LIFE_ORDERS_RE.test(text)) return 'lifecycle';
  if (ACTIVITY_REPORT_RE.test(text)) return 'activityreport';
  if (GUIDE_START_RE.test(text) || (/\bexplique[- ]moi\b/i.test(text) && require('./guidedSetup').planForText(text))) return 'guide';
  if (COMMUNITY_SEARCH_RE.test(text) || (COMMUNITY_BUILD_RE.test(text) && !/(?:groupes?\s+(?:admin|que\s+j)|mes\s+groupes|dans\s+(?:le|mes|tous)\s+groupes?\b)/i.test(text))) return 'community';
  // Campagnes de groupes administrés (création, rapport, arrêt) : AVANT « recurring » / « grouppost » / « goal ».
  if ((GROUPCAMPAIGN_TARGET_RE.test(text) && GROUPCAMPAIGN_TIME_RE.test(text)) || GROUPCAMPAIGN_REPORT_RE.test(text) || GROUPCAMPAIGN_STOP_RE.test(text)) return 'groupcampaign';
  // Campagne Facebook Ads (message d'accueil des nouveaux contacts) : AVANT « offer » / « goal » qui la happaient.
  if (ADCAMPAIGN_RE.test(text)) return 'adcampaign';
  if (offerClarifier.detectNewOfferIntent(text)) return 'offer';
  // 'reply' (répondre réellement au dernier message) AVANT 'inbox' : "réponds-lui"
  // est une action d'envoi, pas une lecture. AVANT 'report' aussi (répond ≠ rapport).
  // « Réponds-lui… » = ordre COURT adressé au dernier message reçu. Un long texte d'instructions (création de service, configuration…) qui contient
  // « réponds aux prospects » n'est PAS un ordre d'envoi : sinon il partait tel quel vers le dernier contact.
  if (REPLY_RE.test(text) && String(text).length <= 400 && !CONFIGSVC_RE.test(text)) return 'reply';
  if (OWNERQUEUE_RE.test(text)) return 'ownerqueue';
  if (ACTIONS_RE.test(text)) return 'actionsreport';
  // Questions sur la mémoire 7×24 h (retrouver une discussion, ce qu'un client a dit, qui a parlé de...) : réponse factuelle.
  if (memoryQuery.isMemoryQuestion(text) && !(INBOX_RE.test(text) && !memoryQuery.hasSpecifics(text))) return 'memory';
  if (INBOX_RE.test(text)) return 'inbox';
  // Actions "centre des intentions" pilotées par le chat, prioritaires sur les
  // intentions génériques (payment/account/businessinfo/goal) qui les
  // happaient. genmedia laisse la main à grouppost si un groupe est mentionné.
  if (CONFIGSVC_RE.test(text)) return 'configsvc';
  if (IMPORTCONTACTS_RE.test(text)) return 'importcontacts';
  if (GENMEDIA_RE.test(text) && !/groupe/i.test(text)) return 'genmedia';
  // Une demande de consultation explicite des groupes l'emporte sur la
  // détection de publication ("envoie-moi la liste de mes groupes").
  if (((GROUPS_LOOKUP_RE.test(text) && !GROUPPOST_RE.test(text)) || SEND_LIST_TO_REQUESTER_RE.test(text))
      && (GROUPS_RE.test(text) || GROUP_SEARCH_MINE_RE.test(text))) return 'groups';
  // Ordre important : une programmation récurrente ("chaque matin envoie au
  // groupe…") l'emporte sur une publication ponctuelle ; une publication (verbe
  // poste/partage/…) l'emporte sur la simple LISTE des groupes — sinon
  // "partage à tous mes groupes admin" serait pris pour une question de liste.
  if (RECURRING_RE.test(text)) return 'recurring';
  if (GROUPPOST_RE.test(text) && !/membre/i.test(text)) return 'grouppost';
  if (GROUPS_RE.test(text) || GROUP_SEARCH_MINE_RE.test(text)) return 'groups';
  // « relance mes prospects » = ACTION de campagne (objectif), pas une consultation du CRM ; « aide-moi à définir mon offre » = offre.
  if (/\brelanc\w*\s+(?:mes|les|tous|toutes|ces)\s+(?:prospects?|clients?|contacts?)/i.test(text) && !/\?\s*$/.test(text)) return 'goal';
  if (/(?:d[ée]finir|structurer|construire|pr[ée]ciser)\s+(?:mon|mes|ma|l['’])\s*(?:offres?|catalogue|produits?)/i.test(text)) return 'offer';
  if (CRM_RE.test(text)) return 'crm';
  if (REPORT_RE.test(text)) return 'report';
  if (PAYMENT_RE.test(text)) return 'payment';
  // 'account' et 'connector' partagent le même handler (handleConnector) :
  // action d'administration sur une plateforme (interne cyrus_students en
  // repli, ou plateforme externe du vendeur via connecteur autorisé).
  if (ACCOUNT_RE.test(text) || CONNECTOR_RE.test(text)) return 'connector';
  // Question factuelle sur l'activité (prix/produits/règles/objectifs) —
  // APRÈS les actions, AVANT 'goal' : "analyse mes ventes" reste un objectif,
  // "quel est le prix de ma formation ?" devient une consultation de données.
  if (BUSINESSINFO_RE.test(text)) return 'businessinfo';
  // PILOTAGE d'une campagne existante (pause, reprise, annulation, statut, progression) : l'AGENT À OUTILS l'exécute réellement
  // (pauseCampaign, resumeCampaign, cancelCampaign, getCampaignProgress…) — jamais un nouveau plan d'objectif. Seule la CRÉATION va à « goal ».
  if (/\bcampagnes?\b/i.test(text)
    && /(?:\bmets?\b|\bmet\b|\breprends?\b|\breprendre\b|\bannule\w*|\barr[êe]te\w*|\bstoppe\w*|\bsuspend\w*|\bpause\b|\bstatut\b|\bprogression\b|\bavancement\b|combien\s+de\s+messages|o[ùu]\s+en\s+est|\bd[ée]tails?\b)/i.test(text)
    && !/(?:\blance\w*|\bcr[ée]e\w*|\bprogramme\w*|\bd[ée]marre\w*|\bnouvelle\b)/i.test(text)) return null;
  // Une simple QUESTION d'explication (« comment ça marche », « c'est quoi ») n'est pas un objectif : conversation / agent à outils.
  if (/(?:^|\s)(?:explique\w*|comment\s+(?:ça\s+|ca\s+)?(?:fonctionne|marche)|c['’]?est\s+quoi|qu['’]?est[- ]ce\s+que|[àa]\s+quoi\s+sert)/i.test(text)) return null;
  if (OBJECTIVE_RE.test(text)) return 'goal';
  if (GOAL_RE.test(text)) return 'goal';
  return null;
}

// ---------------------------------------------------------------------------
// 'offer' — délègue entièrement à offerClarifier (Phases 1/2/3 du module de
// clarification d'offre).
// ---------------------------------------------------------------------------
async function handleOffer(text, history, tenantId) {
  const { domain } = await buildPersonaFacts(tenantId);
  const { raw, parsed } = await offerClarifier.planOffer(text, history, domain);
  if (parsed && parsed.ready && parsed.offer) {
    const entry = await offerClarifier.saveOffer(tenantId, parsed.offer, parsed.category);
    const name = entry.name || parsed.offer.name || 'votre offre';
    return {
      text: `${parsed.summary || ''}\n\n✅ C'est noté ! J'ai configuré l'offre "${name}". Je suis prêt à gérer les ventes et les questions des prospects.`.trim(),
      actionLog: [{ icon: '🗂️', label: `Offre "${name}" enregistrée`, status: 'done' }],
    };
  }
  return { text: raw, isPlanningQuestion: true, intent: 'offer' };
}

// ---------------------------------------------------------------------------
// 'goal' — délègue à goal-chat (multi-tour tant qu'il manque une info REQUISE
// — cible, canaux). Une fois le plan prêt, DEMANDE confirmation (reformulée
// chaleureusement par personaManager) au lieu d'exécuter — l'exécution ne
// démarre qu'au tour SUIVANT si le vendeur confirme, et tourne alors en
// arrière-plan (voir runGoalPlanInBackground) pendant qu'une réponse
// immédiate est déjà renvoyée (Fluid Streaming, §2 du cahier des charges).
// ---------------------------------------------------------------------------
const goalSessions = new Map();

// Faits réels à injecter dans la reformulation (JAMAIS inventés par le LLM,
// voir personaManager.js) : offres déjà clarifiées (offerClarifier.js) +
// statut du moyen de paiement configuré — permet une reformulation du style
// "la formation est prête, le lien de paiement est actif" QUAND c'est
// factuellement vrai, sans jamais l'affirmer par défaut.
async function buildPersonaFacts(tenantId) {
  const profile = await offerClarifier.getBusinessProfile(tenantId);
  const domain = personaManager.inferDomain(profile);
  const recentOffers = (profile.offers || []).slice(-3)
    .map((o) => `${o.name || o.category}${o.price ? ` (${o.price})` : ''}`);
  // Source de vérité UNIQUE des moyens de paiement : le(s) Service(s) métier réellement configuré(s) (commercial.paymentTerms), quel que soit le
  // métier — jamais une variable d'environnement globale ni un « lien de paiement » (Cyrus ne sait pas en générer). Voir ai-engine/businessServices.js.
  let paymentTerms = [];
  try { paymentTerms = (await businessServices.list(tenantId)).filter((s) => (s.lifecycle || 'active') === 'active' && s.commercial && String(s.commercial.paymentTerms || '').trim()).map((s) => `${s.name} : ${s.commercial.paymentTerms}`); } catch (e) { paymentTerms = []; }
  const parts = [];
  if (recentOffers.length) parts.push(`Offres déjà configurées : ${recentOffers.join(', ')}.`);
  parts.push(paymentTerms.length
    ? `Moyens de paiement RÉELLEMENT configurés (à communiquer tels quels, jamais un lien) : ${paymentTerms.join(' | ')}.`
    : 'Aucun moyen de paiement n\'est configuré dans les Services métiers pour le moment : ne jamais en inventer un ni promettre de « lien de paiement » (cette fonction n\'existe pas) — dis-le clairement.');
  return { domain, facts: parts.join(' ') };
}

async function handleGoal(text, sessionKey, tenantId, deps) {
  const state = goalSessions.get(sessionKey);
  const awaitingConfirmation = !!(state && state.phase === 'ready');
  const { domain, facts } = await buildPersonaFacts(tenantId);

  if (awaitingConfirmation) {
    if (personaManager.detectDecline(text)) {
      goalSessions.delete(sessionKey);
      const warm = await personaManager.rephrase({
        kind: 'declined', rawText: 'La mission est annulée pour l\'instant.', facts, domain,
      });
      return { text: warm };
    }

    if (!personaManager.detectAffirmative(text)) {
      // Ni "oui" net ni refus net : traité comme une PRÉCISION business
      // (ex: "avec 10% de remise pour les 3 premiers") — reconnue et
      // reportée dans la reformulation, mais NON encodée dans le plan de
      // tâches lui-même (task-parser/goal-chat n'ont pas de notion de
      // remise) : limitation assumée, la nuance reste conversationnelle
      // tant qu'un vrai champ dédié n'existe pas dans le plan de tâches.
      const warm = await personaManager.rephrase({
        kind: 'confirm_plan',
        rawText: (state.doc && state.doc.summary) || 'Le plan est prêt.',
        facts: `${facts} Précision du vendeur à prendre en compte : "${text}".`,
        domain,
      });
      return { text: warm, isPlanningQuestion: true, intent: 'goal' };
    }

    // Confirmé : réponse IMMÉDIATE, exécution réelle lancée EN ARRIÈRE-PLAN.
    const ackText = await personaManager.rephrase({
      kind: 'executing', rawText: 'La campagne est lancée maintenant.', facts, domain,
    });
    const eng = deps.engineFor ? deps.engineFor(tenantId) : null;
    goalSessions.delete(sessionKey);

    if (!eng) {
      return { text: ackText, actionLog: [{ icon: '⚠️', label: 'Exécution indisponible (moteur non injecté)', status: 'error' }] };
    }

    runGoalPlanInBackground(state, eng, tenantId); // fire-and-forget, voir plus bas
    return { text: ackText, actionLog: [{ icon: '🚀', label: 'Exécution démarrée en arrière-plan', status: 'pending' }] };
  }

  const freshState = state || goalChat.createSession({});
  goalSessions.set(sessionKey, freshState);
  const out = goalChat.step(freshState, { message: text, parser: taskParser, humanContext: deps.humanContext || null });

  if (out.kind !== 'plan') {
    const rawQuestion = (out.reply && out.reply.text) || 'Précisez votre objectif.';
    const warm = await personaManager.rephrase({ kind: 'question', rawText: rawQuestion, facts, domain });
    return { text: warm, isPlanningQuestion: true, intent: 'goal' };
  }

  // Ordre compris : exécution DIRECTE (aucune validation imposée). Ancien comportement (plan puis « oui ») :
  // CHAT_CONFIRM_PLANS=true.
  if (process.env.CHAT_CONFIRM_PLANS !== 'true') {
    const eng = deps.engineFor ? deps.engineFor(tenantId) : null;
    const planLine = out.reply.text.replace(/\n\nPrêt à exécuter \? Choisis une action ci-dessous\.$/, '');
    const ack = await personaManager.rephrase({ kind: 'executing', rawText: `Je m'en occupe : ${planLine}`, facts, domain });
    goalSessions.delete(sessionKey);
    if (!eng) return { text: ack, actionLog: [{ icon: '⚠️', label: 'Exécution indisponible (moteur non injecté)', status: 'error' }] };
    runGoalPlanInBackground(freshState, eng, tenantId);
    return { text: ack, actionLog: [{ icon: '🚀', label: 'Exécution démarrée en arrière-plan', status: 'pending' }] };
  }

  // Prêt : reformulation + demande de confirmation — freshState.phase est
  // déjà passé à 'ready' par goalChat.step() ci-dessus (persiste dans
  // goalSessions), aucune exécution ici.
  const planText = out.reply.text.replace(/\n\nPrêt à exécuter \? Choisis une action ci-dessous\.$/, '');
  const warm = await personaManager.rephrase({ kind: 'confirm_plan', rawText: planText, facts, domain });
  return { text: warm, isPlanningQuestion: true, intent: 'goal' };
}

// Exécution réelle du plan, hors du cycle requête/réponse HTTP courant
// (voir handleGoal ci-dessus) — pousse le résultat final dans le tchat via
// platformOrchestrator.notifyTenantChat une fois terminé, exactement comme
// les notifications anti-spam déjà en place pour les campagnes.
async function runGoalPlanInBackground(state, eng, tenantId) {
  try {
    const runResult = await goalChat.runPlan(state, {
      execute: async (tasks) => {
        await eng.createTasks(tasks);
        const runOut = await eng.runDue({ tenantId });
        return {
          runId: (tasks[0] && tasks[0].runId) || null,
          executed: runOut.executed,
          results: runOut.results,
          error: runOut.failed > 0 ? `${runOut.failed} tâche(s) en échec` : null,
        };
      },
    });

    const results = (runResult.execution && runResult.execution.results) || [];
    const actionLog = results.map((r) => ({
      icon: r.ok ? '✅' : '⚠️',
      label: `${r.type || r.action || 'Action'} — ${r.ok ? 'terminé' : (r.error || 'échec')}`,
      status: r.ok ? 'done' : 'error',
    }));
    const summaryText = runResult.ok
      ? '✅ C\'est fait, la campagne tourne — je vous tiens au courant des résultats au fil de l\'eau.'
      : `⚠️ Petit souci pendant l'exécution (${(runResult.execution && runResult.execution.error) || 'erreur inconnue'}) — j'y jette un œil.`;
    await platformOrchestrator.notifyTenantChat(tenantId, summaryText, actionLog);
  } catch (err) {
    console.error(`chatOrchestrator — échec de l'exécution en arrière-plan (tenant "${tenantId}") :`, err.message);
    await platformOrchestrator.notifyTenantChat(
      tenantId,
      `⚠️ L'exécution de la campagne a échoué (${err.message}).`,
      [{ icon: '⚠️', label: 'Échec de la campagne', status: 'error' }],
    ).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 'report' — lecture seule, exécution directe via action-executor
// (GENERATE_REPORT), aucun appel LLM nécessaire pour la détection.
// ---------------------------------------------------------------------------
async function handleReport(text, tenantId, deps) {
  if (!deps.runtime || !deps.runtime.actionExecutor) {
    return { text: 'Rapport indisponible pour le moment (moteur non injecté).' };
  }
  const out = await deps.runtime.actionExecutor.execute('GENERATE_REPORT', { scope: 'day', tenantId }, { tenantId });
  if (!out.ok) return { text: `Impossible de générer le rapport (${out.error}).` };
  const r = out.result;
  const text2 = [
    'Voici où on en est aujourd\'hui :',
    `📊 ${r.totalMessages} message(s) analysé(s), ${r.conversions} conversion(s) détectée(s), chaleur ${r.heat}.`,
    r.recommendations && r.recommendations.length ? `Recommandations : ${r.recommendations.join(' ')}` : null,
  ].filter(Boolean).join('\n');
  return { text: text2, actionLog: [{ icon: '📊', label: 'Rapport généré', status: 'done' }] };
}

// ---------------------------------------------------------------------------
// 'inbox' — lecture réelle des derniers messages reçus (READ_RECENT_MESSAGES).
// Répond à "quel est le dernier message reçu / qui m'a écrit / es-tu connecté à
// mon WhatsApp ?" avec des DONNÉES RÉELLES (expéditeur + contenu + numéro
// connecté), plutôt qu'une réponse vide du chat générique. Distingue les 3 cas
// honnêtement : non connecté / connecté mais tampon vide (après redémarrage) /
// messages disponibles.
// ---------------------------------------------------------------------------
// 'adcampaign' — configure une campagne Facebook Ads dans un SERVICE MÉTIER (outil configureFacebookAdCampaign).
// Le message initial est extrait de façon DÉTERMINISTE (exact au caractère près) ; l'IA n'aide que pour les champs annexes.
async function handleAdCampaign(text, history, tenantId, deps, last) {
  const parser = require('./adCampaignParser');
  const draft = last && last.isPlanningQuestion && last.intent === 'adcampaign' && last.adDraft ? Object.assign({}, last.adDraft) : null;
  const d = deps || {};
  let args = draft ? Object.assign({}, draft.args) : {};
  const ask = (question, newDraft) => ({ text: question, isPlanningQuestion: true, intent: 'adcampaign', adDraft: newDraft, actionLog: [{ icon: '📣', label: 'Campagne Facebook Ads : information manquante', status: 'warning' }] });

  if (draft && draft.awaiting === 'message') {
    // La réponse EST le message exact (repris tel quel ; un éventuel encadrement par guillemets est retiré).
    const q = parser.quotedBlocks(text);
    args.initialMessage = (q.length === 1 && q[0].start === 0 && q[0].end === text.trim().length) ? q[0].text : text.trim();
  } else if (draft && draft.awaiting === 'service') {
    args.serviceName = text.trim().replace(/^["«“]|["»”]$/g, '');
    args.createService = /^(nouveau|cr[ée]e)/i.test(text.trim()) ? true : args.createService;
  } else {
    const p = parser.extractInitialMessage(text);
    if (p.message) args.initialMessage = p.message;
    args.entryMessages = (p.entryMessages || []).filter((m) => m.length <= 200 && m !== p.message).join('\n');
    // Champs annexes : IA optionnelle (jamais le message initial). Échec -> valeurs par défaut honnêtes.
    let extra = {};
    try {
      const today = new Date().toISOString().slice(0, 10);
      const prompt = [
        'Extrais d\'une instruction de campagne Facebook Ads ces champs annexes. NE FOURNIS PAS le message à envoyer. Réponds UNIQUEMENT en JSON :',
        `{"name":"nom de la campagne ou de la publication","productName":"produit/formation concerné","serviceName":"service métier si nommé","startDate":"AAAA-MM-JJ ou vide","endDate":"AAAA-MM-JJ ou vide","adIds":"identifiants d'annonce cités","sourceUrls":"liens d'annonce cités","continuationRules":"règles pour la suite de la conversation, séparées par ;"}`,
        `Date du jour : ${today}. Ne remplis que ce qui est explicitement dit ; sinon chaîne vide.`,
        `Instruction : "${String(text).slice(0, 1500)}"`,
      ].join('\n');
      const llm = d.llm || ((pr) => llmFallbackEngine.generateAIResponse(pr, [], null, undefined, null, { purpose: 'ad_campaign_parse', tier: 'reasoning', tenant: tenantId, interactive: true }).then((r) => r.text));
      extra = extractJsonBlock(String(await llm(prompt) || '').trim()) || {};
    } catch (e) { extra = {}; }
    const per = parser.detectPeriod(text);
    args.name = extra.name || args.name || null;
    args.productName = extra.productName || args.productName || null;
    args.serviceName = extra.serviceName || args.serviceName || null;
    args.adIds = extra.adIds || ''; args.sourceUrls = extra.sourceUrls || '';
    args.continuationRules = extra.continuationRules || '';
    args.startDate = per ? new Date(per.startAt).toISOString().slice(0, 10) : (extra.startDate || '');
    args.endDate = per ? new Date(per.endAt).toISOString().slice(0, 10) : (extra.endDate || '');
    if (!args.name) args.name = `Facebook Ads${args.productName ? ' — ' + args.productName : ''} (${new Date().toISOString().slice(0, 10)})`;
  }

  if (!String(args.initialMessage || '').trim()) {
    return ask('Quel est le texte EXACT à envoyer aux nouveaux contacts de cette campagne ? Écris-le tel que tu veux qu\'il parte : je ne le reformulerai pas.', { awaiting: 'message', args });
  }

  let call = await toolRegistry.execute(tenantId, 'configureFacebookAdCampaign', args, {});
  if (call.state !== 'SUCCESS' && call.error && call.error.code === 'SERVICE_REQUIRED') {
    const choices = call.error.choices || [];
    if (!choices.length && (args.serviceName || args.productName)) {
      call = await toolRegistry.execute(tenantId, 'configureFacebookAdCampaign', Object.assign({}, args, { createService: true }), {});
    } else {
      return ask(`À quel service métier rattacher cette campagne ?${choices.length ? ` Services existants : ${choices.map((c) => `« ${c} »`).join(', ')}. Réponds par le nom, ou « nouveau <nom> » pour en créer un.` : ' Donne-moi le nom du produit/service.'}`, { awaiting: 'service', args });
    }
  }
  if (call.state !== 'SUCCESS') {
    return { text: `Je n'ai pas pu enregistrer la campagne (${(call.error && (call.error.message || call.error.code)) || call.state}).`, actionLog: [{ icon: '⚠️', label: 'Échec configuration campagne Facebook Ads', status: 'error' }] };
  }
  const r = call.result; const c = r.campaign;
  const fmt = (t) => (t ? new Date(t).toLocaleDateString('fr-FR') : null);
  const lines = [
    `✅ Campagne Facebook Ads « ${c.name} » ${r.updated ? 'mise à jour' : 'enregistrée'} dans le service « ${r.serviceName} »${r.serviceCreated ? ' (service créé)' : ''}.`,
    `• Période : ${c.startAt || c.endAt ? `${fmt(c.startAt) || '—'} → ${fmt(c.endAt) || 'sans fin'}` : 'sans limite (aucune date donnée)'} · statut : ${c.status === 'active' ? 'actif' : 'inactif'}`,
    `• Messages d'entrée reconnus : ${c.criteria.entryMessages.length ? c.criteria.entryMessages.map((m) => `« ${m} »`).join(' ; ') + ' (et variantes raisonnables)' : 'aucun — seule la donnée d\'annonce fournie par WhatsApp déclenchera l\'envoi'}`,
    `• Message envoyé aux NOUVEAUX contacts (exactement, sans reformulation) :\n«${c.initialMessage}»`,
    `• Ensuite le Chat Intelligent reprend la conversation avec le contexte du service${c.continuation.rules.length ? ` et tes règles : ${c.continuation.rules.join(' ; ')}` : ''}.`,
    c.criteria.adIds.length || c.criteria.sourceUrls.length ? `• Annonce reconnue par : ${[...c.criteria.adIds, ...c.criteria.sourceUrls].join(', ')}` : 'ℹ️ L\'origine Facebook n\'est marquée « vérifiée » que si WhatsApp fournit réellement les données de l\'annonce ; un contact reconnu seulement par son message d\'entrée est marqué « source déclarée », jamais présenté comme prouvé.',
  ];
  return { text: lines.join('\n'), toolCall: { name: 'configureFacebookAdCampaign', state: call.state, result: { campaignId: r.campaignId, serviceId: r.serviceId } }, actionLog: [{ icon: '📣', label: `Campagne « ${c.name} » configurée`, status: 'done' }] };
}

// 'groupcampaign' — campagnes programmées sur les groupes ADMINISTRÉS (outils createGroupCampaign / setGroupCampaignGoal /
// getGroupCampaignReport / stopGroupCampaign). Les vrais noms de groupes viennent de WhatsApp ; le statut administrateur est
// vérifié ; aucun envoi n'est simulé.
async function handleGroupCampaign(text, history, tenantId, deps, last) {
  const gp = require('./groupCampaignParser');
  const d = deps || {};
  const fmtDate = (t) => new Date(t).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  const draft = last && last.isPlanningQuestion && last.intent === 'groupcampaign' && last.gcDraft ? last.gcDraft : null;
  const ask = (q, args, awaiting) => ({ text: q, isPlanningQuestion: true, intent: 'groupcampaign', gcDraft: { args, awaiting }, actionLog: [{ icon: '👥', label: 'Campagne de groupes : information manquante', status: 'warning' }] });
  const kwHint = gp.extractKeyword(text);

  if (!draft && GROUPCAMPAIGN_STOP_RE.test(text)) {
    const call = await toolRegistry.execute(tenantId, 'stopGroupCampaign', { campaign: kwHint || undefined }, {});
    if (call.state !== 'SUCCESS') return { text: `Je n'ai pas pu arrêter la campagne (${(call.error && call.error.message) || call.state})${call.error && call.error.choices ? ` : ${call.error.choices.join(', ')}` : ''}.` };
    return { text: `⏹️ Campagne « ${call.result.name} » arrêtée : plus aucun message programmé ne partira.`, actionLog: [{ icon: '⏹️', label: 'Campagne de groupes arrêtée', status: 'done' }] };
  }

  if (!draft && GROUPCAMPAIGN_REPORT_RE.test(text) && !GROUPCAMPAIGN_TARGET_RE.test(text)) {
    const call = await toolRegistry.execute(tenantId, 'getGroupCampaignReport', { campaign: kwHint || undefined }, {});
    if (call.state !== 'SUCCESS') return { text: `Pas de rapport disponible (${(call.error && call.error.message) || call.state}).` };
    const r = call.result;
    const L = [`📊 Campagne « ${r.name} » — ${r.status === 'active' ? 'en cours' : (r.status === 'completed' ? 'terminée' : 'arrêtée')} (${fmtDate(r.startAt)} → ${fmtDate(r.endAt)})`,
      `• Groupes ciblés (${r.groups.length}) : ${r.groups.join(', ')}`,
      `• Messages réellement envoyés : ${r.messagesSent}${r.messagesFailed ? ` (échecs/ignorés : ${r.messagesFailed})` : ''}`,
      `• Prospects intéressés : ${r.leads} · offres envoyées : ${r.offersSent} · preuves reçues : ${r.proofsReceived}`,
      `• Paiements : ${r.paymentsPending} en attente de ta validation · ${r.paymentsConfirmed} confirmé(s)${r.confirmedAmountKnownFor ? ` (${r.confirmedAmount} au total, montants déclarés par les clients)` : ''}`];
    if (r.note) L.push(`ℹ️ ${r.note}`);
    if (r.goal) L.push(`🎯 Objectif ${r.goal.period ? 'du ' + r.goal.period : ''} : ${r.goal.amount} ${r.goal.currency} — atteint à ${r.goal.progressPercent}% (reste ${r.goal.remaining} ${r.goal.currency})`);
    else L.push('🎯 Aucun objectif défini pour cette campagne.');
    return { text: L.join('\n'), toolCall: { name: 'getGroupCampaignReport', state: call.state }, actionLog: [{ icon: '📊', label: `Rapport « ${r.name} »`, status: 'done' }] };
  }

  const parsed = gp.parseInstruction(text);
  // Objectif seul (« Objectif du mois : 1 000 000 FCFA ») : rattaché à la campagne existante.
  if (!draft && parsed.goal && !GROUPCAMPAIGN_TARGET_RE.test(text)) {
    const call = await toolRegistry.execute(tenantId, 'setGroupCampaignGoal', { amount: parsed.goal.amount, currency: parsed.goal.currency, period: parsed.goal.period, campaign: kwHint || undefined }, {});
    if (call.state !== 'SUCCESS') return { text: `Je n'ai pas pu enregistrer l'objectif (${(call.error && call.error.message) || call.state})${call.error && call.error.choices ? ` : ${call.error.choices.join(', ')}` : ''}.` };
    return { text: `🎯 Objectif enregistré pour « ${call.result.name} » : ${call.result.goal.amount} ${call.result.goal.currency}${call.result.goal.period ? ' (' + call.result.goal.period + ')' : ''}. Je suivrai les paiements CONFIRMÉS (montants déclarés) et je te donnerai la progression réelle.`, actionLog: [{ icon: '🎯', label: 'Objectif enregistré', status: 'done' }] };
  }

  // Création : on assemble les champs (instruction + réponses aux questions précédentes).
  const args = draft ? Object.assign({}, draft.args) : {};
  if (draft && draft.awaiting === 'messages') {
    const q = require('./adCampaignParser').quotedBlocks(text).map((b) => b.text);
    args.messages = (q.length ? q : [text.trim()]).join('\n|||\n');
  } else if (draft && draft.awaiting === 'service') {
    args.serviceName = text.trim().replace(/^["«“]|["»”]$/g, ''); args.createService = /^(nouveau|cr[ée]e)/i.test(text.trim()) ? true : args.createService;
  } else if (draft && draft.awaiting === 'days') {
    const du = gp.extractDuration(text); if (du) args.days = du.days;
  } else if (draft && draft.awaiting === 'times') {
    const tm = gp.extractTimes(text); if (tm.length) args.times = tm.join(',');
  } else {
    if (parsed.keyword) args.keyword = parsed.keyword;
    if (parsed.duration) args.days = parsed.duration.days;
    if (parsed.times.length) args.times = parsed.times.join(',');
    if (parsed.messages.length) args.messages = parsed.messages.join('\n|||\n');
    if (parsed.goal) { args.goalAmount = parsed.goal.amount; args.goalCurrency = parsed.goal.currency; args.goalPeriod = parsed.goal.period; }
    // Service / produit : IA optionnelle (jamais les messages). Échec -> l'existant décide (service unique) ou on demande.
    try {
      const prompt = ['Extrais de cette instruction de campagne le nom du produit ou service vendu et du service métier si nommé. Réponds UNIQUEMENT en JSON : {"productName":"","serviceName":""}. Vide si non dit.', `Instruction : "${String(text).slice(0, 1200)}"`].join('\n');
      const llm = d.llm || ((pr) => llmFallbackEngine.generateAIResponse(pr, [], null, undefined, null, { purpose: 'group_campaign_parse', tier: 'reasoning', tenant: tenantId, interactive: true }).then((r) => r.text));
      const ex = extractJsonBlock(String(await llm(prompt) || '').trim()) || {};
      if (ex.productName) args.productName = ex.productName; if (ex.serviceName) args.serviceName = ex.serviceName;
    } catch (e) { /* facultatif */ }
  }
  if (!args.keyword) return ask('Quel mot-clé doit contenir le nom des groupes ciblés ?', args, 'keyword');
  if (!args.days) return ask('Pendant combien de temps (ex. 3 jours, 1 semaine, 1 mois) ?', args, 'days');
  if (!args.times) return ask('À quelles heures envoyer les messages (ex. 8h, 12h et 18h) ?', args, 'times');
  if (!args.messages) return ask('Quels messages dois-je envoyer ? Écris-les entre guillemets « … » (un par horaire, ou un seul pour tous) : je ne les reformulerai pas.', args, 'messages');

  const call = await toolRegistry.execute(tenantId, 'createGroupCampaign', args, { runtime: d.runtime });
  if (call.state !== 'SUCCESS') {
    const e = call.error || {};
    if (e.code === 'SERVICE_REQUIRED') {
      const choices = e.choices || [];
      return ask(`À quel service métier / produit rattacher cette campagne ?${choices.length ? ` Services existants : ${choices.map((c) => `« ${c} »`).join(', ')}. Réponds par le nom, ou « nouveau <nom> » pour en créer un.` : ' Donne-moi le nom du produit ou service vendu.'}`, args, 'service');
    }
    return { text: `Je n'ai pas pu créer la campagne : ${e.message || e.code || call.state}`, actionLog: [{ icon: '⚠️', label: 'Échec campagne de groupes', status: 'error' }] };
  }
  const c = call.result.campaign;
  const svc = (await businessServices.list(tenantId)).find((s) => s.id === c.serviceId);
  const missing = [];
  if (svc) { const cm = svc.commercial || {}; if (cm.price == null && !(svc.products || []).some((p) => p && p.price != null)) missing.push('le prix'); if (!cm.paymentTerms) missing.push('les numéros / instructions de dépôt'); }
  const L = [
    `✅ Campagne « ${c.name} » programmée (service « ${c.serviceName} »).`,
    `• Groupes ciblés — tu y es administrateur (${c.groups.length}) : ${c.groups.map((g) => g.name).join(', ')}`,
    ...(call.result.notAdmin && call.result.notAdmin.length ? [`• Ignorés (tu n'y es pas administrateur) : ${call.result.notAdmin.join(', ')}`] : []),
    `• Du ${fmtDate(c.startAt)} au ${fmtDate(c.endAt)} · horaires : ${c.slots.map((s) => s.time).join(', ')} · arrêt automatique à la fin`,
    ...c.slots.map((s) => `   ${s.time} → « ${s.message.length > 90 ? s.message.slice(0, 90) + '…' : s.message} »`),
    'ℹ️ Les créneaux déjà passés aujourd\'hui ne sont pas envoyés rétroactivement.',
    '• Un membre qui manifeste son intérêt reçoit en privé l\'offre de ton Service métier (prix + instructions de paiement) ; sa preuve de paiement te sera remontée avec une référence PA-XXXX pour ta confirmation.',
    ...(c.goal ? [`🎯 Objectif enregistré : ${c.goal.amount} ${c.goal.currency}${c.goal.period ? ' (' + c.goal.period + ')' : ''}.`] : []),
    ...(missing.length ? [`⚠️ Dans le service « ${c.serviceName} », il manque : ${missing.join(' et ')}. Je ne les inventerai pas : complète-les avant que quelqu'un ne s'intéresse.`] : []),
  ];
  return { text: L.join('\n'), toolCall: { name: 'createGroupCampaign', state: call.state, result: { campaignId: c.id } }, actionLog: [{ icon: '👥', label: `Campagne « ${c.name} » : ${c.groups.length} groupe(s)`, status: 'done' }] };
}

// 'ownerqueue' — ce qui attend le propriétaire : lecture des états RÉELS (aucune liste inventée).
async function handleOwnerQueue(text, tenantId) {
  const wantsPayments = /paiement|preuve/i.test(text);
  const wantsConvs = /conversation|discussion|personne|contact|gens|intervention|r[ée]ponse|attend/i.test(text);
  const wantsAlerts = /important|alerte|urgent|traiter/i.test(text);
  const all = !wantsPayments && !wantsConvs && !wantsAlerts;
  const lines = [];
  const log = [];
  const ago = (ts) => { const m = Math.max(0, Math.round((Date.now() - ts) / 60000)); return m < 60 ? `il y a ${m} min` : `il y a ${Math.round(m / 60)} h`; };

  if (all || wantsConvs || wantsAlerts) {
    const waiting = await conversationRouter.listAwaitingOwner(tenantId);
    if (waiting.length) {
      lines.push(`📩 ${waiting.length} conversation(s) attendent ton intervention :`);
      waiting.slice(0, 15).forEach((c) => lines.push(`• ${c.contactLabel || contactIdentity.resolveIdentity({ channel: c.channel, jid: c.chatId }).label} (${c.channel === 'TELEGRAM' ? 'Telegram' : 'WhatsApp'}) — ${c.reason || 'intervention requise'}${c.lastMessage ? ` : “${c.lastMessage}”` : ''} · ${ago(c.since)}`));
      log.push({ icon: '📩', label: `${waiting.length} conversation(s) en attente`, status: 'done' });
    } else if (wantsConvs) {
      lines.push("📩 Aucune conversation n'attend ton intervention en ce moment.");
    }
  }
  if (all || wantsPayments) {
    const pend = await manualPaymentValidator.listPending(tenantId);
    if (pend.length) {
      lines.push(`💰 ${pend.length} paiement(s) à valider :`);
      pend.slice(0, 15).forEach((p) => lines.push(`• ${p.customerName || p.email} — ${p.declaredAmount || 'montant non précisé'} — ${p.productName || p.courseId || 'produit à préciser'} — réf. ${p.pendingActionId || 'n/a'}`));
      lines.push("Réponds « OUI » ou « NON » (avec la référence s'il y en a plusieurs).");
      log.push({ icon: '💰', label: `${pend.length} paiement(s) en attente`, status: 'done' });
    } else if (wantsPayments) {
      lines.push("💰 Aucun paiement n'est en attente de validation.");
    }
  }
  if (all || wantsAlerts) {
    const alerts = (await alertCenter.list(tenantId, { status: 'OPEN', minLevel: 'IMPORTANT', sinceMs: Date.now() - 24 * 3600 * 1000, limit: 10 }))
      .filter((a) => !['PAYMENT_VALIDATION_REQUIRED'].includes(a.type));
    if (alerts.length) {
      lines.push(`🔔 Alertes importantes (24 h) :`);
      alerts.forEach((a) => lines.push(`• [${a.level}] ${a.title}${a.count > 1 ? ` (×${a.count})` : ''} · ${ago(a.createdAt)}`));
      log.push({ icon: '🔔', label: `${alerts.length} alerte(s) importante(s)`, status: 'done' });
    } else if (wantsAlerts && !lines.length) {
      lines.push('🔔 Aucune alerte importante ouverte sur les dernières 24 h.');
    }
  }
  if (!lines.length) lines.push("✅ Rien n'attend ton intervention pour le moment.");
  return { text: lines.join('\n'), actionLog: log.length ? log : null };
}

async function handleMemory(text, tenantId, deps) {
  const llm = deps.llm || ((prompt) => generateInteractive(prompt, [], { purpose: 'memory_summary', tier: 'reasoning', tenant: tenantId }).then((r) => r.text));
  try {
    const out = await memoryQuery.answer(tenantId, text, { llm });
    return { text: out.text, actionLog: out.actionLog };
  } catch (err) {
    return { text: `Je n'ai pas pu interroger la mémoire (${err.message}).`, actionLog: [{ icon: '⚠️', label: 'Mémoire indisponible', status: 'error' }] };
  }
}

async function handleInbox(text, tenantId, deps) {
  if (!deps.runtime || !deps.runtime.actionExecutor) {
    return { text: 'Je ne peux pas lire les messages pour le moment (moteur non disponible).' };
  }
  const channel = /telegram/i.test(text) ? 'TELEGRAM' : 'WHATSAPP';
  const label = channel === 'TELEGRAM' ? 'Telegram' : 'WhatsApp';
  const out = await deps.runtime.actionExecutor.execute('READ_RECENT_MESSAGES', { channel, limit: 10, tenantId }, { tenantId });
  if (!out.ok) {
    return { text: `Je n'ai pas pu lire ${label} (${out.error}).` };
  }
  const r = out.result || {};
  const numLine = r.connectedNumber ? ` (numéro : ${r.connectedNumber})` : '';
  // Trois états distincts, honnêtes (voir la distinction connecté/appairé
  // ajoutée dans les adaptateurs) : appairé mais reconnexion en cours (coupures
  // 428 fréquentes sur IP cloud) ≠ jamais appairé. On ne dit "pas connecté" à
  // sec que si le compte n'est PAS appairé du tout.
  if (r.connected === false) {
    if (r.paired) {
      return {
        text: `Ton compte ${label}${numLine} est bien appairé, mais la connexion est momentanément coupée (WhatsApp ferme parfois la session sur les serveurs cloud) et se rétablit automatiquement. Réessaie dans quelques instants — dès que c'est reconnecté je pourrai lire tes messages.`,
        actionLog: [{ icon: '🔄', label: `${label} appairé — reconnexion en cours`, status: 'warning' }],
      };
    }
    return {
      text: `⚠️ Je ne suis pas connecté à ${label} pour l'instant, et aucun compte n'y est appairé — il faut d'abord scanner le QR / saisir le code dans l'onglet ${label} du tableau de bord.`,
      actionLog: [{ icon: '🔌', label: `${label} non appairé`, status: 'warning' }],
    };
  }
  const messages = Array.isArray(r.messages) ? r.messages : [];
  if (!messages.length) {
    return {
      text: `Je suis bien connecté à ${label}${numLine}, mais je n'ai encore aucun message en mémoire depuis mon dernier redémarrage. Demande à un contact de t'écrire (ou envoie-toi un message depuis un autre numéro), puis redemande-moi : je te donnerai l'expéditeur et le contenu exact.`,
      actionLog: [{ icon: '🔌', label: `${label} connecté${r.connectedNumber ? ' — ' + r.connectedNumber : ''}`, status: 'done' }],
    };
  }
  const fmtWho = (m) => (m.name ? `${m.name} (${m.number || m.username || m.from})` : (m.number || m.username || m.from));
  const fmtWhen = (m) => (m.ts ? new Date(m.ts * 1000).toLocaleString('fr-FR') : '');
  const fmtBody = (m) => (m.text ? `"${m.text}"` : (m.hasMedia ? '[média]' : '[message vide]'));
  const lines = messages.slice(0, 5).map((m, i) => {
    const when = fmtWhen(m);
    return `${i === 0 ? '➡️ ' : '• '}${fmtWho(m)}${m.isGroup ? ' [groupe]' : ''} — ${fmtBody(m)}${when ? ` · ${when}` : ''}`;
  });
  const last = messages[0];
  return {
    text: [`Voici tes derniers messages ${label}${numLine} :`, ...lines].join('\n'),
    actionLog: [{ icon: '📥', label: `Dernier message : ${fmtWho(last)}`, status: 'done' }],
  };
}

// ---------------------------------------------------------------------------
// 'reply' — répond RÉELLEMENT au dernier message reçu (ou à un contact nommé)
// et VÉRIFIE l'envoi. Chaîne complète : identifie l'expéditeur/canal réels
// (historique persistant) -> rédige la réponse (style du vendeur) -> envoi
// vérifié (runtime.sendMessageVerified, registre d'actions) -> rapport de
// VÉRITÉ (SUCCESS confirmé / FAILED / PENDING, jamais un faux positif).
// ---------------------------------------------------------------------------
// Compte rendu d'envoi rédigé de façon HUMAINE (pas de bloc « Canal:/Action:/
// Statut: » robotique) tout en restant strictement VRAI : on ne dit « envoyé »
// que si l'envoi est confirmé, et on cite la référence réelle comme preuve.
function sendReport({ status, label, who, replyText, confirmationId, error }) {
  if (status === 'SUCCESS') {
    return { text: `C'est parti, j'ai écrit à ${who} sur ${label} : « ${replyText} ». Message bien remis ✅ (réf. ${confirmationId}).`, actionLog: [{ icon: '✅', label: `Envoyé à ${who}`, status: 'done' }] };
  }
  if (status === 'PENDING') {
    return { text: `J'ai lancé le message pour ${who} sur ${label}, mais je n'ai pas encore la confirmation de remise — je garde un œil dessus et je te dis dès que c'est bon.`, actionLog: [{ icon: '⏳', label: `En attente — ${who}`, status: 'warning' }] };
  }
  return { text: `Aïe, je n'ai pas réussi à joindre ${who} sur ${label} (${error || 'envoi non confirmé'}). Le message n'est PAS parti — on peut réessayer dès que le canal est reconnecté.`, actionLog: [{ icon: '❌', label: `Échec — ${who}`, status: 'error' }] };
}

async function composeReplyText(instruction, last, tenantId, domain) {
  let context = '';
  try {
    const conv = await messageHistory.getConversation(tenantId, last.channel, last.number, 12);
    if (conv && conv.length) context = conv.map((m) => `${m.direction === 'in' ? 'Client' : 'Moi'}: ${m.text}`).join('\n');
  } catch (e) { context = ''; }
  const prompt = [
    personaManager.personaSystemPrompt(domain || 'default'),
    `Dernier message reçu de ${last.name || last.number} : "${last.text}"`,
    context ? `Contexte récent de la conversation :\n${context}` : '',
    `Le vendeur te demande : "${instruction}"`,
    'Rédige UNIQUEMENT le message EXACT à envoyer au client, dans le style habituel du vendeur, sans guillemets ni préambule ni explication. Si le vendeur dicte le contenu (ex : "réponds-lui que je vais bien"), reformule fidèlement (ex : "Je vais bien.").',
  ].filter(Boolean).join('\n');
  const { text: raw } = await generateInteractive(prompt, []);
  return String(raw || '').trim().replace(/^["'«»\s]+|["'«»\s]+$/g, '').slice(0, 1500);
}

async function handleReply(text, tenantId, deps) {
  if (String(text || '').length > 600) return { text: "Ce message est trop long pour être une réponse à envoyer : je ne l'envoie à personne. Dictez-moi la réponse exacte à envoyer, ou reformulez votre demande.", intent: 'reply' };
  if (!deps.runtime || typeof deps.runtime.sendMessageVerified !== 'function') {
    return { text: 'Envoi indisponible pour le moment (moteur non injecté).' };
  }
  let channel = /telegram/i.test(text) ? 'TELEGRAM' : (/whatsapp/i.test(text) ? 'WHATSAPP' : null);
  const lastWA = await messageHistory.getLastIncoming(tenantId, 'WHATSAPP').catch(() => null);
  const lastTG = await messageHistory.getLastIncoming(tenantId, 'TELEGRAM').catch(() => null);
  let last;
  if (channel === 'TELEGRAM') last = lastTG;
  else if (channel === 'WHATSAPP') last = lastWA;
  else {
    if (lastWA && lastTG) last = (lastWA.ts >= lastTG.ts) ? lastWA : lastTG;
    else last = lastWA || lastTG;
    channel = last ? last.channel : 'WHATSAPP';
  }
  const label = channel === 'TELEGRAM' ? 'Telegram' : 'WhatsApp';
  if (!last) {
    return { text: `Je n'ai aucun message reçu récemment sur ${label} auquel répondre. Demande-moi d'abord « quel est le dernier message reçu ? ».` };
  }
  const who = last.name ? `${last.name} (${last.number})` : last.number;
  const { domain } = await buildPersonaFacts(tenantId);
  const replyText = await composeReplyText(text, last, tenantId, domain);
  if (!replyText) return { text: 'Je n\'ai pas compris quel message envoyer — dicte-moi la réponse exacte.', isPlanningQuestion: true, intent: 'reply' };
  const to = last.chatId || last.party;
  const out = await deps.runtime.sendMessageVerified({ channel, to, text: replyText, tenantId });
  return sendReport({ status: out.status, label, who, replyText, confirmationId: out.confirmationId, error: out.error });
}

// ---------------------------------------------------------------------------
// 'actionsreport' — supervision : ce que l'agent a RÉELLEMENT fait (registre
// d'actions), avec le statut réel de chacune. Empêche le "c'est fait" abstrait.
// ---------------------------------------------------------------------------
async function handleActionsReport(tenantId) {
  const actions = await actionLedger.listRecent(tenantId, 10).catch(() => []);
  if (!actions.length) return { text: 'Je n\'ai encore exécuté aucune action traçable.' };
  const icon = (s) => (s === 'SUCCESS' ? '✅' : s === 'FAILED' ? '❌' : s === 'PENDING' ? '⏳' : '•');
  const lines = actions.map((a) => {
    const when = a.finishedAt || a.startedAt || a.requestedAt;
    const target = a.target || '';
    const ref = a.confirmation && a.confirmation.confirmationId ? ` (réf. ${a.confirmation.confirmationId})` : (a.error ? ` (${a.error})` : '');
    return `${icon(a.status)} ${a.type} ${a.channel || ''} → ${target} : ${a.status}${ref} · ${new Date(when).toLocaleString('fr-FR')}`;
  });
  return { text: ['📊 Mes dernières actions (statut réel) :', ...lines].join('\n'), actionLog: [{ icon: '📊', label: `${actions.length} action(s)`, status: 'done' }] };
}

// ---------------------------------------------------------------------------
// 'groups' — liste réelle des groupes du compte (LIST_GROUPS), avec le rôle
// (admin) et la taille. Sait filtrer "où je suis admin" et par sujet (mot-clé).
// Base concrète pour cibler ensuite une campagne (extraction + envoi), qui
// passe par le moteur de campagne existant sur confirmation.
// ---------------------------------------------------------------------------
// searchMyGroups() — cœur RÉUTILISABLE de la recherche parmi les groupes déjà rejoints (filtre admin + sujet, tri par taille, enrichissement du
// lien WhatsApp réel pour une recherche ciblée). Retourne des données structurées, pas un texte de chat : utilisé à la fois par handleGroups()
// (Self WhatsApp/Telegram, Chat Intelligent) et par la route HTTP /api/communities/my-groups (recherche visible dans l'onglet Communautés du
// dashboard — avant, cette recherche n'existait qu'en discutant avec l'IA, invisible pour qui ne pense pas à le demander par chat).
async function searchMyGroups(channel, { adminOnly, subject } = {}, tenantId, deps) {
  if (!deps.runtime || !deps.runtime.actionExecutor) return { ok: false, error: 'ENGINE_UNAVAILABLE' };
  const out = await deps.runtime.actionExecutor.execute('LIST_GROUPS', { channel, tenantId }, { tenantId });
  if (!out.ok) return { ok: false, error: out.error || 'LIST_GROUPS_FAILED' };
  const r = out.result || {};
  if (r.connected === false) return { ok: true, connected: false, paired: !!r.paired, groups: [], total: 0 };
  let groups = Array.isArray(r.groups) ? r.groups : [];
  const total = groups.length;
  if (adminOnly) groups = groups.filter((g) => g.isAdmin);
  const subjName = subject && String(subject).trim();
  if (subjName) {
    const kw = subjName.toLowerCase();
    groups = groups.filter((g) => (g.name || '').toLowerCase().includes(kw));
  }
  const matched = groups.length;
  const sorted = groups.slice().sort((a, b) => (b.size || 0) - (a.size || 0));
  const top = sorted.slice(0, 20);
  // Recherche CIBLÉE (nom précis, peu de résultats) : le lien réel est joint quand la plateforme le fournit — jamais fabriqué. WhatsApp seul l'expose
  // aujourd'hui (Baileys) ; Telegram n'a pas d'équivalent générique côté adaptateur → simplement omis, jamais inventé.
  if (subjName && channel === 'WHATSAPP' && top.length <= 5) {
    try {
      const session = require('../adapters/whatsappManager').getOrCreate(tenantId).session;
      if (session && typeof session.getGroupInviteLink === 'function') {
        for (const g of top) { try { g.link = await session.getGroupInviteLink(g.id); } catch (e) { /* lien indisponible pour ce groupe (droits/erreur réseau) : omis, jamais fabriqué */ } }
      }
    } catch (e) { /* moteur non disponible : pas de lien, jamais inventé */ }
  }
  return { ok: true, connected: true, total, matched, groups: top, truncated: matched > top.length };
}

async function handleGroups(text, tenantId, deps) {
  const channel = /telegram/i.test(text) ? 'TELEGRAM' : 'WHATSAPP';
  const label = channel === 'TELEGRAM' ? 'Telegram' : 'WhatsApp';
  const adminOnly = /(admin|administre|dont\s+je\s+suis|o[ùu]\s+je\s+suis)/i.test(text);
  // Nom recherché : soit un lien explicite (sur/contenant/thème/à propos de/parlant de X), soit directement après « groupe(s) » (« cherche le
  // groupe Épicerie ») — en excluant les mots qui ne sont pas un nom (telegram/whatsapp/dont/où/que/admin/publics).
  const subjLinked = text.match(/(?:sur|contenant|th[èe]me|[àa]\s+propos\s+de|parlant\s+de)\s+["']?(?!whatsapp\b|telegram\b)([\p{L}\d][\p{L}\d \-]{1,40})/iu);
  // NOTE : \b ne fonctionne pas de façon fiable après une lettre accentuée (où/privé/thème…) en JS — (?=\s|$|[.,;:!?]) le remplace partout ici.
  const subjBare = !subjLinked && text.match(/groupes?\s+(?!telegram(?=\s|$|[.,;:!?])|whatsapp(?=\s|$|[.,;:!?])|dont(?=\s|$|[.,;:!?])|o[ùu](?=\s|$|[.,;:!?])|que(?=\s|$|[.,;:!?])|admin\w*(?=\s|$|[.,;:!?])|publics?(?=\s|$|[.,;:!?])|priv[ée]s?(?=\s|$|[.,;:!?])|sur(?=\s|$|[.,;:!?])|contenant(?=\s|$|[.,;:!?])|th[èe]me(?=\s|$|[.,;:!?])|[àa]\s+propos(?=\s|$|[.,;:!?])|parlant(?=\s|$|[.,;:!?]))["']?([\p{L}\d][\p{L}\d \-]{1,40})/iu);
  const subjName = (subjLinked && subjLinked[1]) || (subjBare && subjBare[1]);
  const call = await toolRegistry.execute(tenantId, 'listMyCommunityGroups', { channel, query: subjName, limit: 500 }, { permissions: deps && deps.toolPermissions });
  if (call.state !== 'SUCCESS') {
    const code = call.error && call.error.code;
    return {
      text: code === `${channel}_NOT_CONNECTED`
        ? `Je ne suis pas connecté à ${label} — vérifie la session dans l'onglet ${label}.`
        : `Je n'ai pas pu récupérer tes groupes ${label} (${(call.error && call.error.message) || code || call.state}).`,
      toolCall: { name: 'listMyCommunityGroups', state: call.state, error: call.error || null },
      actionLog: [{ icon: '⚠️', label: `${label} : liste des groupes indisponible`, status: 'warning' }],
    };
  }
  const allGroups = (call.result && call.result.groups) || [];
  const selected = adminOnly ? allGroups.filter((g) => g.isAdmin) : allGroups;
  const res = {
    ok: true, connected: true, total: (call.result && call.result.total) || allGroups.length,
    matched: selected.length,
    groups: selected.slice().sort((a, b) => (b.size || 0) - (a.size || 0)).slice(0, 20),
    truncated: !!(call.result && call.result.truncated) || selected.length > 20,
  };
  if (!res.matched) {
    return {
      text: adminOnly
        ? `Je ne trouve aucun groupe ${label} dont tu es admin (sur ${res.total} groupe(s) au total).`
        : (subjName ? `Aucun groupe ${label} ne correspond à « ${subjName.trim()} » (sur ${res.total} groupe(s) au total) — vérifie le nom, ou dis-moi « liste mes groupes ${label} » pour voir la liste complète.` : `Aucun groupe ${label} trouvé (${res.total} au total).`),
      actionLog: [{ icon: '👥', label: `0 groupe ${label}`, status: 'done' }],
    };
  }
  const lines = res.groups.map((g) => `• ${g.name}${g.isAdmin ? ' 👑 (admin)' : ''} — ${g.size || 0} membre(s)${g.link ? ` — ${g.link}` : ''}`);
  const header = adminOnly
    ? `Tes groupes ${label} où tu es admin (${res.matched}) :`
    : `Tes groupes ${label} (${res.matched}${subjName ? ` correspondant à « ${subjName.trim()} »` : ''}) :`;
  const more = res.truncated ? `\n… et ${res.matched - res.groups.length} autre(s).` : '';
  return {
    text: [header, ...lines].join('\n') + more,
    toolCall: { name: 'listMyCommunityGroups', state: call.state, result: call.result },
    actionLog: [{ icon: '👥', label: `${res.matched} groupe(s) ${label}`, status: 'done' }],
  };
}

// ---------------------------------------------------------------------------
// 'grouppost' — publie (partage) un message + éventuel visuel généré DANS les
// groupes ciblés (par nom, sujet, "admin", ou tous). Confirmation OBLIGATOIRE
// avant tout envoi de masse (même prudence que 'goal'). Exécute via
// deps.runtime.sendToGroups (appel direct, média en mémoire) — jamais un envoi
// sans le "oui" du vendeur.
// ---------------------------------------------------------------------------
function targetLabel(t) {
  const k = (t && t.kind) || 'all';
  if (k === 'admin') return 'tous tes groupes où tu es admin';
  if ((k === 'named' || k === 'subject') && t.value) return `les groupes « ${t.value} »`;
  return 'tous tes groupes';
}

const groupPostSessions = new Map();

async function planGroupPost(text, history, domain) {
  const prompt = [
    personaManager.personaSystemPrompt(domain || 'default'),
    `Message de l'administrateur : "${text}"`,
    'Il veut publier un message (et éventuellement un visuel/affiche généré) DANS un ou plusieurs de ses groupes WhatsApp/Telegram.',
    "Cible : {kind:'named'|'subject'|'admin'|'all', value:'nom exact du groupe OU mot-clé de sujet, sinon chaîne vide'}.",
    'wantsVisual : true seulement s\'il demande de GÉNÉRER une affiche/image à joindre, sinon false. visualPrompt : courte description du visuel si wantsVisual.',
    "message : le texte à publier (rédige-le proprement si l'ordre est vague mais l'intention claire).",
    'Réponds UNIQUEMENT avec cet objet JSON (aucun texte autour) : {"target":{"kind":"...","value":"..."},"message":"...","wantsVisual":false,"visualPrompt":""}',
  ].join('\n');
  const { text: raw } = await generateInteractive(prompt, history);
  const parsed = extractJsonBlock(String(raw || '').trim());
  return parsed || { raw: String(raw || '').trim() };
}

async function handleGroupPost(text, history, sessionKey, tenantId, deps) {
  const channel = /telegram/i.test(text) ? 'TELEGRAM' : 'WHATSAPP';
  const label = channel === 'TELEGRAM' ? 'Telegram' : 'WhatsApp';
  const { domain } = await buildPersonaFacts(tenantId);
  const state = groupPostSessions.get(sessionKey);

  if (state && state.phase === 'ready') {
    if (personaManager.detectDecline(text)) {
      groupPostSessions.delete(sessionKey);
      return { text: 'Ok, j\'annule la publication.' };
    }
    if (!personaManager.detectAffirmative(text)) {
      state.plan.message = text; // le vendeur redicte le texte
      return { text: `Compris. Je publie ceci dans ${targetLabel(state.plan.target)} (${state.groupsCount} groupe(s)) ? Réponds « oui » pour lancer.`, isPlanningQuestion: true, intent: 'grouppost' };
    }
    if (!deps.runtime || typeof deps.runtime.sendToGroups !== 'function') {
      groupPostSessions.delete(sessionKey);
      return { text: 'Publication indisponible pour le moment (moteur non injecté).' };
    }
    let media = null;
    if (state.plan.wantsVisual && typeof deps.generateImage === 'function') {
      try {
        const img = await deps.generateImage(state.plan.visualPrompt || state.plan.message);
        if (img && img.buffer) media = { buffer: img.buffer, mimetype: img.mimetype || 'image/jpeg', filename: 'affiche.jpg', caption: state.plan.message };
      } catch (err) { /* repli texte seul */ }
    }
    const out = await deps.runtime.sendToGroups({ channel: state.plan.channel || channel, target: state.plan.target, text: state.plan.message, media, tenantId });
    groupPostSessions.delete(sessionKey);
    if (!out.ok) {
      const hint = out.error === 'NO_MATCHING_GROUP'
        ? ' Aucun groupe ne correspond à la cible.'
        : (/RUNTIME_MISSING|whatsapp|telegram|getGroupsSummary/i.test(out.error || '') ? ' Vérifie que le compte est bien connecté.' : '');
      return { text: `Je n'ai pas pu publier (${out.error}).${hint}` };
    }
    return {
      text: `✅ Publié dans ${out.sent}/${out.total} groupe(s) ${label}${media ? ' (avec le visuel)' : ''}.`,
      actionLog: [{ icon: '📢', label: `Publié dans ${out.sent} groupe(s)`, status: 'done' }],
    };
  }

  const parsed = await planGroupPost(text, history, domain);
  if (!parsed || !parsed.message) {
    return { text: (parsed && parsed.raw) || 'Que veux-tu publier, et dans quel(s) groupe(s) — un nom précis, un sujet, ou « tous mes groupes admin » ?', isPlanningQuestion: true, intent: 'grouppost' };
  }
  const target = parsed.target && parsed.target.kind ? parsed.target : { kind: 'all', value: '' };
  let groupsCount = null;
  let names = [];
  if (deps.runtime && typeof deps.runtime.resolveGroups === 'function') {
    const r = await deps.runtime.resolveGroups({ channel, target, tenantId }).catch(() => null);
    if (r && r.ok) { groupsCount = r.groups.length; names = r.groups.slice(0, 5).map((g) => g.name); }
  }
  groupPostSessions.set(sessionKey, {
    phase: 'ready',
    plan: { channel, target, message: parsed.message, wantsVisual: !!parsed.wantsVisual, visualPrompt: parsed.visualPrompt || '' },
    groupsCount: groupsCount || 0,
  });
  const where = groupsCount != null
    ? `${groupsCount} groupe(s)${names.length ? ` (${names.join(', ')}${groupsCount > names.length ? '…' : ''})` : ''}`
    : targetLabel(target);
  const visualNote = parsed.wantsVisual ? ' avec un visuel généré' : '';
  return {
    text: `Je vais publier${visualNote} dans ${where} sur ${label} :\n« ${parsed.message} »\n\nJe lance ? (réponds « oui », ou redicte un autre texte)`,
    isPlanningQuestion: true,
    intent: 'grouppost',
  };
}

// ---------------------------------------------------------------------------
// 'recurring' — tâches quotidiennes récurrentes ("chaque matin envoie X au
// groupe Y") + gestion (liste, arrêt). Persisté (queues/recurringTasks.js),
// exécuté par le tick d'index.js. La création ne fait aucun envoi immédiat.
// ---------------------------------------------------------------------------
async function planRecurring(text, history, tenantId) {
  const { domain } = await buildPersonaFacts(tenantId);
  const prompt = [
    personaManager.personaSystemPrompt(domain || 'default'),
    `Ordre de l'administrateur : "${text}"`,
    'Il veut programmer un message QUOTIDIEN récurrent dans un ou des groupes.',
    "Extrais : channel ('WHATSAPP' ou 'TELEGRAM', défaut WHATSAPP), target {kind:'named'|'subject'|'admin'|'all', value}, message (le texte à envoyer — rédige-le si l'intention est claire, ex. message de motivation/prière), hour (0-23) et minute (0-59).",
    "Si l'heure OU le message OU la cible manque vraiment, réponds UNIQUEMENT par une question courte (texte, jamais de JSON).",
    'Sinon réponds UNIQUEMENT avec cet objet JSON : {"ready":true,"channel":"WHATSAPP","target":{"kind":"...","value":"..."},"message":"...","hour":7,"minute":0}',
  ].join('\n');
  const { text: raw } = await generateInteractive(prompt, history);
  const parsed = extractJsonBlock(String(raw || '').trim());
  return parsed || { ready: false, raw: String(raw || '').trim() };
}

async function handleRecurring(text, history, tenantId, deps) {
  const channel = /telegram/i.test(text) ? 'TELEGRAM' : 'WHATSAPP';
  // Liste
  if (/(liste|montre|voir|quelles?)\b/i.test(text) && /(t[âa]ches?|r[ée]curren|programm)/i.test(text)) {
    const tasks = await recurringTasks.list(tenantId);
    const active = tasks.filter((t) => t.active);
    if (!active.length) return { text: 'Aucune tâche récurrente active pour le moment.' };
    const lines = active.map((t, i) => `${i + 1}. ${String(t.hour).padStart(2, '0')}h${String(t.minute).padStart(2, '0')} → ${targetLabel(t.target)} (${t.channel}) : « ${String(t.message).slice(0, 60)} »`);
    return { text: ['⏰ Tes tâches récurrentes :', ...lines].join('\n'), actionLog: [{ icon: '⏰', label: `${active.length} tâche(s) récurrente(s)`, status: 'done' }] };
  }
  // Arrêt
  if (/(arr[êe]te|stop|supprime|annule|d[ée]sactive)/i.test(text)) {
    const n = await recurringTasks.stopAll(tenantId);
    return { text: n ? `🛑 ${n} tâche(s) récurrente(s) arrêtée(s).` : 'Aucune tâche récurrente à arrêter.', actionLog: n ? [{ icon: '🛑', label: 'Tâches récurrentes arrêtées', status: 'done' }] : null };
  }
  // Création
  const parsed = await planRecurring(text, history, tenantId);
  if (!parsed || parsed.ready === false || !parsed.message || parsed.hour == null) {
    return { text: (parsed && parsed.raw) || 'À quelle heure, dans quel groupe, et quel message veux-tu envoyer chaque jour ?', isPlanningQuestion: true, intent: 'recurring' };
  }
  const target = parsed.target && parsed.target.kind ? parsed.target : { kind: 'all', value: '' };
  const task = await recurringTasks.create(tenantId, { channel: parsed.channel || channel, target, message: parsed.message, hour: parsed.hour, minute: parsed.minute || 0 });
  const label = (parsed.channel || channel) === 'TELEGRAM' ? 'Telegram' : 'WhatsApp';
  return {
    text: `✅ C'est programmé : chaque jour à ${String(task.hour).padStart(2, '0')}h${String(task.minute).padStart(2, '0')}, j'enverrai dans ${targetLabel(target)} (${label}) :\n« ${task.message} »\n\nDis « liste mes tâches récurrentes » ou « arrête mes tâches récurrentes » quand tu veux.`,
    actionLog: [{ icon: '⏰', label: 'Tâche récurrente créée', status: 'done' }],
  };
}

// ---------------------------------------------------------------------------
// 'crm' — consultation du CRM de contacts (ai-engine/contactCrm.js) : liste par
// étiquette (prospect/client/personnalisée) + comptages. Lecture pure
// (stockage), fonctionne même WhatsApp/Telegram déconnecté.
// ---------------------------------------------------------------------------
async function handleCrm(text, tenantId) {
  let tag = null;
  if (/\bclients?\b/i.test(text)) tag = 'client';
  else if (/\bprospects?\b/i.test(text)) tag = 'prospect';
  else if (/nouveau|nouvelle|nouveaux/i.test(text)) tag = 'nouveau_contact';
  const m = text.match(/(?:tagg?[ée]s?|[ée]tiquet[ée]s?)\s+["']?([\p{L}\d_-]{2,30})/iu);
  if (m) tag = m[1].trim().toLowerCase();
  const channel = /telegram/i.test(text) ? 'TELEGRAM' : (/whatsapp/i.test(text) ? 'WHATSAPP' : null);

  const c = await contactCrm.counts(tenantId);
  const items = await contactCrm.list(tenantId, { tag, channel });
  const recap = Object.entries(c.byTag || {}).map(([t, n]) => `${t}: ${n}`).join(', ');

  if (!items.length) {
    return {
      text: tag
        ? `Aucun contact avec l'étiquette « ${tag} »${channel ? ' sur ' + channel : ''}.${recap ? `\n(Récap : ${recap})` : ''}`
        : `Aucun contact enregistré pour l'instant. Dès qu'une personne t'écrit, je l'ajoute et l'étiquette automatiquement.`,
    };
  }
  const top = items.slice(0, 20);
  const lines = top.map((x) => {
    const who = x.name || x.from;
    const tags = (x.tags || []).length ? ` — ${x.tags.join(', ')}` : '';
    const buys = (x.purchases || []).length ? ` · ${x.purchases.length} achat(s)` : '';
    return `• ${who}${tags}${buys}`;
  });
  const header = tag ? `Contacts « ${tag} » (${items.length}) :` : `Tes contacts (${items.length}) :`;
  const more = items.length > top.length ? `\n… et ${items.length - top.length} autre(s).` : '';
  return {
    text: [header, ...lines].join('\n') + more,
    actionLog: [{ icon: '🏷️', label: `${items.length} contact(s)${tag ? ' « ' + tag + ' »' : ''}`, status: 'done' }],
  };
}

// ---------------------------------------------------------------------------
// 'payment' — extraction LLM ciblée (montant, destinataire, produit, remise
// demandée) puis instructions de paiement manuelles / NEGOTIATE_DISCOUNT.
// Même patron qu'index.js#planOrAsk (planImage/planVideo/planBook) : un seul
// appel LLM par tour, JSON "ready" ou question courte.
// ---------------------------------------------------------------------------
async function planPayment(text, history, domain) {
  const prompt = [
    personaManager.personaSystemPrompt(domain || 'default'),
    `Nouveau message du vendeur : "${text}"`,
    'Le vendeur veut soit générer une instruction de paiement pour un client, soit négocier/accorder une remise. Détermine lequel.',
    'Informations nécessaires si paiement : le montant exact et la devise, le produit/offre concerné (facultatif, texte libre).',
    'Informations nécessaires si remise : le prix de départ et le pourcentage de remise demandé (si le client n\'a pas précisé de pourcentage, mets requestedPercent à null — le système appliquera le plafond autorisé).',
    'Base-toi sur l\'historique de la discussion pour ne jamais reposer une question déjà répondue.',
    'Si des informations manquent, réponds UNIQUEMENT par 1 à 2 questions courtes (texte simple, jamais de JSON).',
    'Si tu as assez d\'informations, réponds UNIQUEMENT avec cet objet JSON (aucun texte avant/après) : {"ready":true,"kind":"payment"|"discount","amount":15000,"currency":"FCFA","product":"nom du produit ou chaîne vide","price":15000,"requestedPercent":10}',
  ].join('\n');
  const { text: raw } = await generateInteractive(prompt, history);
  const trimmed = raw.trim();
  return { raw: trimmed, parsed: extractJsonBlock(trimmed) };
}

async function handlePayment(text, history, tenantId, deps) {
  const { domain } = await buildPersonaFacts(tenantId);
  const { raw, parsed } = await planPayment(text, history, domain);
  if (!parsed || !parsed.ready) {
    return { text: raw, isPlanningQuestion: true, intent: 'payment' };
  }
  if (!deps.runtime || !deps.runtime.actionExecutor) {
    return { text: 'Impossible de traiter cette demande de paiement pour le moment (moteur non injecté).' };
  }

  if (parsed.kind === 'discount') {
    const out = await deps.runtime.actionExecutor.execute('NEGOTIATE_DISCOUNT', {
      price: parsed.price, requestedPercent: parsed.requestedPercent, tenantId,
    }, { tenantId });
    if (!out.ok) return { text: `Impossible de calculer la remise (${out.error}).` };
    const r = out.result;
    const cappedNote = r.capped ? ` (plafonnée à ${r.appliedPercent}% — remise maximale autorisée)` : '';
    return {
      text: `🤝 Remise accordée : ${r.appliedPercent}%${cappedNote}. Prix final : ${r.finalPrice} ${r.currency} (au lieu de ${r.originalPrice} ${r.currency}).`,
      actionLog: [{ icon: '🤝', label: `Remise ${r.appliedPercent}% accordée`, status: 'done' }],
    };
  }

  const out = await deps.runtime.actionExecutor.execute('PROVIDE_PAYMENT_INSTRUCTIONS', {
    amount: parsed.amount, currency: parsed.currency, product: parsed.product, tenantId,
  }, { tenantId });
  if (!out.ok) {
    const hint = out.error === 'NO_PAYMENT_METHOD_CONFIGURED' || out.error === 'NO_MOBILE_MONEY_NUMBER_CONFIGURED'
      ? ' Aucun moyen de paiement n\'est configuré dans vos Services métiers : ajoutez-en un (numéro Mobile Money, etc.) dans l\'onglet « Services Métiers », je ne peux pas en inventer un.'
      : '';
    return { text: `Impossible de générer l'instruction de paiement (${out.error}).${hint}` };
  }
  return { text: out.result.message, actionLog: [{ icon: '💳', label: `Instruction de paiement générée (réf. ${out.result.reference})`, status: 'done' }] };
}

// ---------------------------------------------------------------------------
// 'account' — extraction LLM ciblée (contact, produit/formation, type d'accès)
// puis CREATE_USER_ACCOUNT / GENERATE_ACCESS_KEY / GRANT_MODULE_ACCESS.
// ---------------------------------------------------------------------------
async function planAccount(text, history, domain) {
  const prompt = [
    personaManager.personaSystemPrompt(domain || 'default'),
    `Nouveau message du vendeur : "${text}"`,
    'Le vendeur veut créer/débloquer l\'accès d\'un client à une formation déjà vendue.',
    'Informations nécessaires : le contact du client (téléphone ou email), et soit "action":"create_account" (nouveau client, génère aussi une clé d\'accès), soit "action":"grant_module" (client déjà créé, ajoute juste un module précis — nécessite moduleKey).',
    'Base-toi sur l\'historique de la discussion pour ne jamais reposer une question déjà répondue.',
    'Si des informations manquent, réponds UNIQUEMENT par 1 à 2 questions courtes (texte simple, jamais de JSON).',
    'Si tu as assez d\'informations, réponds UNIQUEMENT avec cet objet JSON (aucun texte avant/après) : {"ready":true,"action":"create_account"|"grant_module","phone":"+225...","email":"","studentName":"","sku":"nom de la formation ou chaîne vide","moduleKey":"identifiant du module ou chaîne vide (grant_module uniquement)"}',
  ].join('\n');
  const { text: raw } = await generateInteractive(prompt, history);
  const trimmed = raw.trim();
  return { raw: trimmed, parsed: extractJsonBlock(trimmed) };
}

async function handleAccount(text, history, tenantId, deps) {
  const { domain } = await buildPersonaFacts(tenantId);
  const { raw, parsed } = await planAccount(text, history, domain);
  if (!parsed || !parsed.ready) {
    return { text: raw, isPlanningQuestion: true, intent: 'account' };
  }
  if (!deps.runtime || !deps.runtime.actionExecutor) {
    return { text: 'Impossible de traiter cette demande pour le moment (moteur non injecté).' };
  }

  if (parsed.action === 'grant_module') {
    const out = await deps.runtime.actionExecutor.execute('GRANT_MODULE_ACCESS', {
      phone: parsed.phone, email: parsed.email, moduleKey: parsed.moduleKey, tenantId,
    }, { tenantId });
    if (!out.ok) return { text: `Impossible d'accorder l'accès (${out.error}).` };
    return {
      text: `🔓 Accès au module "${parsed.moduleKey}" accordé à ${parsed.phone || parsed.email}.`,
      actionLog: [{ icon: '🔓', label: `Module "${parsed.moduleKey}" débloqué pour ${parsed.phone || parsed.email}`, status: 'done' }],
    };
  }

  const out = await deps.runtime.actionExecutor.execute('CREATE_USER_ACCOUNT', {
    phone: parsed.phone, email: parsed.email, studentName: parsed.studentName, sku: parsed.sku, tenantId,
  }, { tenantId });
  if (!out.ok) return { text: `Impossible de créer le compte (${out.error}).` };
  const r = out.result;
  return {
    text: `🎓 Compte élève créé pour ${parsed.phone || parsed.email}.\n🔑 Clé d'accès : ${r.accessKey}`,
    actionLog: [{ icon: '🎓', label: `Compte élève créé — clé ${r.accessKey}`, status: 'done' }],
  };
}

// ---------------------------------------------------------------------------
// 'connector' — action d'administration sur une plateforme. CYRUS n'est PAS
// limité à une plateforme : `connectorManager.getToolsForTenant` ne renvoie
// que les outils des connecteurs ACTIVÉS par CE vendeur et dont la PERMISSION
// est accordée (voir ai-engine/connectors/). Le LLM choisit l'outil pertinent
// et extrait ses arguments parmi CETTE liste seulement ; s'il n'y a aucun
// connecteur externe (ou aucun outil applicable), on retombe sur le flux de
// compte interne classique (handleAccount, Cloud Function cyrus_students).
// ---------------------------------------------------------------------------
function describeToolsForPrompt(tools) {
  return tools.map((t) => {
    const params = Object.keys(t.parameters || {}).map((k) => {
      const p = t.parameters[k];
      return `${k}${p && p.required ? ' (requis)' : ''}: ${(p && p.description) || ''}`;
    }).join(' ; ');
    return `- ${t.name} [${t.connectorLabel}] : ${t.description}\n  Paramètres : ${params || '(aucun)'}`;
  }).join('\n');
}

function formatConnectorResult(toolName, result) {
  const r = result || {};
  if (toolName === 'creer_compte_eleve') {
    const link = r.passwordResetLink ? `\n🔗 Lien de définition du mot de passe : ${r.passwordResetLink}` : '';
    return {
      text: `🎓 Accès créé sur la plateforme pour ${r.email} (formation « ${r.courseId} »).${link}`,
      actionLog: [{ icon: '🎓', label: `Compte plateforme — ${r.email}`, status: 'done' }],
    };
  }
  if (toolName === 'suspendre_compte_eleve') {
    return { text: `⛔ Accès suspendu pour ${r.email} (réversible).`, actionLog: [{ icon: '⛔', label: `Accès suspendu — ${r.email}`, status: 'done' }] };
  }
  if (toolName === 'ajouter_contact') {
    return { text: `📇 Contact ${r.created ? 'créé' : 'retrouvé'} sur ${r.provider || 'la plateforme'} : ${r.email}.`, actionLog: [{ icon: '📇', label: `Contact — ${r.email}`, status: 'done' }] };
  }
  if (toolName === 'attribuer_tag') {
    return { text: `🏷️ Tag « ${r.tag} » attribué au contact.`, actionLog: [{ icon: '🏷️', label: `Tag « ${r.tag} » attribué`, status: 'done' }] };
  }
  if (toolName === 'enregistrer_vente') {
    const e = r.entry || {};
    return { text: `📒 Vente enregistrée : ${e.amount} ${e.currency}${e.product ? ` — ${e.product}` : ''}.`, actionLog: [{ icon: '📒', label: 'Vente enregistrée', status: 'done' }] };
  }
  if (toolName === 'generer_facture') {
    const inv = r.invoice || {};
    return { text: `🧾 Facture ${inv.number} générée : ${inv.amount} ${inv.currency}${inv.customer ? ` — ${inv.customer}` : ''}.`, actionLog: [{ icon: '🧾', label: `Facture ${inv.number}`, status: 'done' }] };
  }
  return { text: '✅ Action effectuée sur la plateforme.', actionLog: [{ icon: '✅', label: `Action « ${toolName} » effectuée`, status: 'done' }] };
}

async function handleConnector(text, history, tenantId, deps, sessionId) {
  const central = await agentLoop.runAgentLoop({ text, history, tenantId, sessionId }, {
    rawText: text, returnGap: false, runtime: deps.runtime || null,
    permissions: deps.toolPermissions || undefined, toolContext: deps.toolContext || undefined,
    llm: deps.llm || undefined,
  }).catch((err) => { console.warn('connector registry route:', err.message); return null; });
  if (central) return central;
  return handleAccount(text, history, tenantId, deps);

  // Legacy connector-specific planner retained below for migration reference;
  // all live connector execution now goes through Tool Registry authorization.
  const tools = await connectorManager.getToolsForTenant(tenantId).catch(() => []);
  // Aucun connecteur externe autorisé -> flux compte interne classique.
  if (!tools.length) return handleAccount(text, history, tenantId, deps);

  const { domain } = await buildPersonaFacts(tenantId);
  const prompt = [
    personaManager.personaSystemPrompt(domain || 'default'),
    'Tu disposes des OUTILS d\'administration suivants (et AUCUN autre — n\'invente jamais un outil ni un accès) :',
    describeToolsForPrompt(tools),
    `Message de l'administrateur : "${text}"`,
    'Choisis AU PLUS un outil réellement pertinent et extrais ses arguments depuis le message et l\'historique. N\'exécute jamais d\'action de suppression.',
    'Si un argument requis manque, réponds UNIQUEMENT par 1 à 2 questions courtes (texte simple, jamais de JSON).',
    'Si aucun outil ne correspond, réponds UNIQUEMENT {"tool":null}.',
    'Sinon réponds UNIQUEMENT avec cet objet JSON (aucun texte avant/après) : {"tool":"nom_exact_de_l_outil","args":{ ... }}',
  ].join('\n');

  const { text: raw } = await generateInteractive(prompt, history);
  const trimmed = String(raw || '').trim();
  const parsed = extractJsonBlock(trimmed);

  // Pas de JSON exploitable : le LLM a (probablement) posé une question de
  // clarification — on la renvoie telle quelle en gardant l'intention active.
  if (!parsed || !('tool' in parsed)) {
    return { text: trimmed, isPlanningQuestion: true, intent: 'connector' };
  }
  // Aucun outil applicable -> repli sur le flux compte interne classique.
  if (!parsed.tool) return handleAccount(text, history, tenantId, deps);

  const available = tools.some((t) => t.name === parsed.tool);
  if (!available) return handleAccount(text, history, tenantId, deps);

  const out = await connectorManager.executeTool(tenantId, parsed.tool, parsed.args || {}, deps.executeOptions || {});
  if (!out.ok) {
    return { text: `Impossible d'exécuter « ${parsed.tool} » (${out.error}).${out.detail ? ' ' + out.detail : ''}` };
  }
  return formatConnectorResult(parsed.tool, out.result);
}

// ---------------------------------------------------------------------------
// 'businessinfo' — répond à une question FACTUELLE du vendeur sur son activité
// (prix, produits, formations, règles, objectifs, capacités) en s'appuyant
// EXCLUSIVEMENT sur ce qu'il a réellement configuré dans l'onglet Services
// Métiers (businessServices.getEngineContextText). C'est le maillon
// "DONNÉES → INTELLIGENCE" : le chat lit la vraie donnée au lieu de l'inventer.
// Si rien n'est configuré, il le dit franchement (jamais un prix fictif).
// ---------------------------------------------------------------------------
async function handleBusinessInfo(text, history, tenantId, deps) {
  const prioritized = await businessServices.getPrioritizedContext(tenantId, { currentHint: text }).catch(() => ({ text: '' }));
  const ctxText = prioritized.text || await businessServices.getEngineContextText(tenantId).catch(() => '');
  if (!ctxText) {
    return {
      text: "Je n'ai encore aucune information sur tes produits ou services. Ajoute-les dans l'onglet « Services Métiers » (activité, produits, prix, règles, objectifs) et je pourrai répondre précisément à ce genre de question.",
      actionLog: [{ icon: '📋', label: 'Aucun Service Métier configuré', status: 'warning' }],
    };
  }
  const { domain } = await buildPersonaFacts(tenantId);
  const prompt = [
    personaManager.personaSystemPrompt(domain || 'default'),
    "Voici les informations RÉELLES et à jour de l'activité du vendeur, telles qu'il les a configurées (source de vérité) :",
    ctxText,
    `Question du vendeur : "${text}"`,
    "Réponds à sa question en t'appuyant UNIQUEMENT sur ces données. Cite le chiffre / le fait EXACT (ex. le prix précis). N'invente JAMAIS un prix, un produit, une règle ou un objectif absent de ces données — si l'information demandée n'y figure pas, dis-le franchement et invite-le à la renseigner dans l'onglet Services Métiers.",
  ].join('\n');
  try {
    const raw = deps && typeof deps.llm === 'function'
      ? await deps.llm(prompt, history || [])
      : (await generateInteractive(prompt, history || [])).text;
    const answer = String(raw || '').trim();
    return {
      text: answer || "Je n'ai pas trouvé cette information dans ta configuration actuelle.",
      actionLog: [{ icon: '📋', label: 'Réponse basée sur tes Services Métiers', status: 'done' }],
    };
  } catch (err) {
    // Repli honnête si toute la cascade LLM est indisponible : on renvoie le
    // contexte brut plutôt que rien (jamais une valeur inventée).
    return { text: `Voici ce que j'ai sur ton activité :\n${ctxText}` };
  }
}

// ---------------------------------------------------------------------------
function serviceMemoFromCommand(text) {
  const value = String(text || '').trim();
  const m = value.match(/(?:service\s+m[ée]tier|mon\s+activit[ée])[^:\n]{0,100}:\s*([\s\S]+)$/i);
  return m ? m[1].trim() : value;
}

function serviceNameFromCommand(text, memo) {
  const m = String(text || '').match(/(?:service(?:\s+m[ée]tier)?\s+(?:nomm[ée]|appel[ée]|intitul[ée])|nom\s+du\s+service)\s+[«"']?([^»"'\n,:.]+)/i);
  return (m && m[1] || businessServices.suggestName(memo)).trim().slice(0, 120);
}

// 'configsvc' — la mémoire libre est le parcours normal. Les API restent une
// option secondaire et conservent le connecteur/vérification existants.
// ---------------------------------------------------------------------------
async function handleConfigSvc(text, history, tenantId, deps, lastAssistantMessage) {
  const services = await businessServices.list(tenantId).catch(() => []);
  const awaitingChoice = !!(lastAssistantMessage && lastAssistantMessage.intent === 'configsvc' && lastAssistantMessage.isPlanningQuestion);
  const previousRequest = awaitingChoice && Array.isArray(history)
    ? [...history].reverse().find((m) => m && m.role === 'user' && m.text)
    : null;
  const request = previousRequest ? String(previousRequest.text) : String(text || '');
  const updating = SERVICE_UPDATE_RE.test(request);

  if (updating) {
    if (!services.length) return { text: 'Je n’ai aucun Service métier à modifier. Dis-moi « Crée un Service métier pour mon activité : … » et j’enregistre les informations en mémoire.', isPlanningQuestion: true, intent: 'configsvc' };
    let selected = awaitingChoice ? businessServices.matchService(services, text) : null;
    if (!selected) selected = businessServices.matchService(services, request);
    if (!selected && services.length === 1) selected = services[0];
    if (!selected) {
      return { text: `À quel Service métier rattacher cette modification ? ${services.map((s) => `« ${s.name} »`).join(', ')}.`, isPlanningQuestion: true, intent: 'configsvc' };
    }
    const call = await toolRegistry.execute(tenantId, 'updateBusinessService', { service: selected.name, memoAppend: request }, {});
    if (call.state !== 'SUCCESS') return { text: `Je n’ai pas pu mettre à jour « ${selected.name} » (${(call.error && (call.error.message || call.error.code)) || call.state}).`, actionLog: [{ icon: '⚠️', label: 'Mise à jour du Service métier échouée', status: 'error' }] };
    const result = call.result || {};
    return { text: `✅ C’est enregistré dans la mémoire de « ${result.name || selected.name} ». Les informations précédentes sont conservées et l’index métier a été actualisé.`, toolCall: { name: 'updateBusinessService', state: call.state, result }, actionLog: [{ icon: '🏢', label: `Mémoire de « ${result.name || selected.name} » mise à jour`, status: 'done' }] };
  }

  const memo = serviceMemoFromCommand(text);
  const name = serviceNameFromCommand(text, memo);
  // Le parsing LLM n’est utilisé que si l’utilisateur demande une intégration API.
  // La création par texte libre ne pose pas de question de formulaire et ne coûte
  // pas un appel de sélection de champs avant l’indexation de la mémoire.
  if (/(?:api|plateforme|passerelle|system\.?io)/i.test(text)) {
    const prompt = [
      personaManager.personaSystemPrompt('default'),
      'Le propriétaire demande une intégration API facultative pour son Service métier. N’extrais que les paramètres d’intégration réellement écrits; la mémoire métier reste le texte brut transmis.',
      `Instruction : "${text}"`,
      'Réponds en JSON strict : {"name":"nom fourni ou vide","baseUrl":"URL fournie ou vide","apiKey":"clé explicitement fournie ou vide","authHeader":"X-API-Key","connectorType":"platform_gateway|systemio|generic","scopes":"permissions explicitement demandées"}. Aucun champ métier ne doit être inventé.',
    ].join('\n');
    let raw;
    try { raw = deps && typeof deps.llm === 'function' ? await deps.llm(prompt, history || []) : (await generateInteractive(prompt, history || [])).text; }
    catch (e) { raw = ''; }
    const parsed = extractJsonBlock(String(raw || '').trim()) || {};
    const apiArgs = Object.assign({}, parsed, { name: parsed.name || name, memo });
    const call = await toolRegistry.execute(tenantId, 'configureBusinessService', apiArgs, {});
    if (call.state !== 'SUCCESS') return { text: `Je n’ai pas pu configurer le service (${(call.error && (call.error.code || call.error.message)) || call.state}).`, actionLog: [{ icon: '⚠️', label: 'Échec configuration service', status: 'error' }] };
    const r = call.result;
    return { text: `✅ La mémoire de « ${r.name} » est enregistrée.${r.test ? (r.connected ? ' L’intégration API répond au test.' : ' Le test API a échoué; la mémoire métier reste enregistrée.') : ''}`, toolCall: { name: 'configureBusinessService', state: call.state, result: r }, actionLog: [{ icon: '🏢', label: `Service « ${r.name} » configuré`, status: r.connected || !r.test ? 'done' : 'warning' }] };
  }

  const call = await toolRegistry.execute(tenantId, 'configureBusinessService', { name, memo }, {});
  if (call.state !== 'SUCCESS') {
    return { text: `Je n'ai pas pu configurer le service (${(call.error && call.error.code) || call.state}).`, actionLog: [{ icon: '⚠️', label: 'Échec configuration service', status: 'error' }] };
  }
  const r = call.result;
  return { text: `✅ La mémoire métier de « ${r.name} » est enregistrée. Tu peux ajouter ou corriger les informations directement dans le Chat intelligent ou Self WhatsApp.`, toolCall: { name: 'configureBusinessService', state: call.state, result: r }, actionLog: [{ icon: '🏢', label: `Mémoire de « ${r.name} » enregistrée`, status: 'done' }] };
}

// ---------------------------------------------------------------------------
// 'importcontacts' — importe en masse les contacts d'un fichier JOINT (le
// fileId est présent dans le contexte des pièces jointes injecté par la route).
// ---------------------------------------------------------------------------
async function handleImportContacts(text, tenantId) {
  const m = String(text || '').match(/\[id:\s*(f_[A-Za-z0-9]+)\]/);
  if (!m) {
    return { text: 'Joins-moi le fichier de contacts (CSV ou Excel) via le trombone 📎, puis redis « importe ces contacts » — je m\'occupe du reste.', isPlanningQuestion: true, intent: 'importcontacts' };
  }
  const call = await toolRegistry.execute(tenantId, 'importContactsFromFile', { fileId: m[1] }, {});
  if (call.state !== 'SUCCESS') {
    return { text: `Je n'ai pas pu importer le fichier (${(call.error && call.error.code) || call.state}). Vérifie qu'il contient une colonne « telephone ».`, actionLog: [{ icon: '⚠️', label: 'Import échoué', status: 'error' }] };
  }
  const r = call.result;
  return {
    text: `📇 Import terminé : ${r.imported} contact(s) ajouté(s), ${r.updated} mis à jour, ${r.duplicates} doublon(s), ${r.invalid} rejeté(s). Tu peux maintenant me demander de les filtrer, les analyser ou lancer une campagne.`,
    toolCall: { name: 'importContactsFromFile', state: call.state, result: r },
    actionLog: [{ icon: '📇', label: `${r.imported} contact(s) importé(s)`, status: 'done' }],
  };
}

// ---------------------------------------------------------------------------
// 'genmedia' — génère un visuel (affiche/image) et le renvoie téléchargeable.
// ---------------------------------------------------------------------------
// 'community' — délègue à l'AGENT À OUTILS (boucle plan → outil → confirmation → vérification) : createCommunityGroup, discoverCommunities,
// getCommunityGroupStatus, listCommunities, prepareContactsFromSource. Aucune logique d'envoi ici : tout passe par le Tool Registry.
async function handleCommunity(text, history, tenantId, sessionId, deps) {
  const agent = await agentLoop.runAgentLoop({ text, history, tenantId, sessionId }, { runtime: deps.runtime || null, permissions: deps.toolPermissions || undefined, generateImage: deps.generateImage || null, toolContext: deps.toolContext || undefined, llm: deps.llm || undefined }).catch(() => null);
  if (agent) return Object.assign(agent, { intent: 'community' });
  return { text: "Je n'ai pas pu préparer cette action de groupe/communauté. Dites-moi le canal (WhatsApp ou Telegram), le nom du groupe et la liste de contacts (fichier joint ou texte), ou les mots-clés à explorer.", isPlanningQuestion: true, intent: 'community' };
}

// 'selfknow' — Cyrus parle de LUI à la première personne, à partir des registres réels (ai-engine/cyrusSelf.js).
async function handleSelfKnow(text, tenantId) {
  const out = await require('./cyrusSelf').answer(tenantId, text);
  return { text: out.text, intent: 'selfknow', actionLog: [{ icon: '🧭', label: 'Réponse construite sur mes registres réels', status: 'done' }] };
}

// 'guide' — GUIDED_SETUP / TUTORIAL_MODE : EXPLIQUE-MOI (explication) / GUIDE-MOI (pas à pas vérifié) / FAIS-LE (les outils font l'action).
async function handleGuide(text, tenantId, lastAssistantMessage) {
  const g = require('./guidedSetup'); const self = require('./cyrusSelf');
  const mode = self.detectMode(text); const cont = lastAssistantMessage && lastAssistantMessage.intent === 'guide' && GUIDE_STEP_RE.test(text);
  const planId = g.planForText(text);
  if (cont) {
    const ev = await g.status(tenantId);
    if (!ev) return { text: g.render(null), intent: 'guide', isPlanningQuestion: true };
    const before = ev.finished ? null : ev.steps[ev.current];
    const prefix = before && /^\s*(?:c['’]est fait|fait|termin[ée]|j['’]ai fini)/i.test(text) ? `Je viens de vérifier dans votre compte : l'étape « ${before.title} » n'est pas encore en place. ` : '';
    return { text: prefix + g.render(ev), intent: 'guide', isPlanningQuestion: !ev.finished };
  }
  if (!planId) return { text: 'Volontiers. Que voulez-vous mettre en place : votre Service métier, votre catalogue, vos contacts, une campagne, le SAV, les relances, vos groupes, ou la connexion de WhatsApp/Telegram ?', intent: 'guide', isPlanningQuestion: true };
  if (mode === 'EXPLAIN' || (!mode && /\bexplique/i.test(text))) { const e = g.explain(planId); return { text: `${e.text}\n\nÉtapes : ${e.steps.map((s, i) => `${i + 1}. ${s}`).join(' · ')}.\nVoulez-vous que je vous guide pas à pas, ou que je le fasse pour vous ?`, intent: 'guide', isPlanningQuestion: true }; }
  const ev = await g.start(tenantId, planId);
  const plan = g.explain(planId);
  return { text: `Objectif : ${plan.title}.\nPlan : ${plan.steps.map((s, i) => `${i + 1}. ${s}`).join(' · ')}.\n\n${g.render(ev)}`, intent: 'guide', isPlanningQuestion: !ev.finished, actionLog: [{ icon: '🧭', label: `Guidage : ${plan.title}`, status: 'done' }] };
}

// 'lifecycle' — questions du propriétaire sur les relances, le SAV et les dossiers : réponses FACTUELLES sur les données réelles (customerLifecycle).
async function handleLifecycle(text, tenantId) {
  const lc = require('./customerLifecycle'); const { explainReason } = require('./toolsLifecycle');
  const who = (c) => c.name || c.id;
  if (LIFE_WHY_RE.test(text)) {
    const m = String(text).match(/(?:pour|à|a|de)\s+([A-ZÀ-Ý][\p{L}'-]+(?:\s+[A-ZÀ-Ý][\p{L}'-]+)?|\+?\d[\d\s]{5,})/u);
    const q = m ? String(m[1]).trim().toLowerCase() : '';
    const all = await lc.listFollowUps(tenantId);
    const hit = (q ? all.filter((f) => String(f.contact.name || '').toLowerCase().includes(q) || String(f.contact.id).includes(q.replace(/\D/g, '') || '§')) : all.filter((f) => f.status !== 'SENT')).slice(0, 5);
    if (!hit.length) return { text: "Je n'ai aucune relance planifiée qui corresponde : elle n'a donc jamais été prévue (aucun dossier livré ni paiement en attente pour ce contact). Voulez-vous que j'en planifie une ?", intent: 'lifecycle' };
    return { text: hit.map((f) => `• ${f.kind} pour ${who(f.contact)} — statut ${f.status}. ${f.status === 'SENT' ? 'Elle a bien été envoyée.' : 'Motif : ' + explainReason(f.cancelReason || f.ownerReason || (f.decisions.length ? f.decisions[f.decisions.length - 1].reasons.slice(-1)[0] : 'PLANNED')) + '.'}`).join('\n'), intent: 'lifecycle' };
  }
  if (LIFE_SAV_RE.test(text)) {
    const open = await lc.listCases(tenantId, { status: 'OPEN' });
    return { text: open.length ? `Dossiers SAV ouverts (${open.length}) :\n` + open.slice(0, 10).map((c) => `• ${who(c.contact)} — ${c.category} : ${c.summary || 'sans détail'} (${Math.max(0, Math.round((Date.now() - c.openedAt) / 3600000))} h)`).join('\n') : "Aucun dossier SAV ouvert pour le moment.", intent: 'lifecycle' };
  }
  if (LIFE_ORDERS_RE.test(text) && !LIFE_CANDIDATES_RE.test(text)) {
    const st = /pay[ée]/i.test(text) && /non|en attente/i.test(text) ? 'PAYMENT_PENDING' : (/livr/i.test(text) ? 'DELIVERED' : undefined);
    const list = await lc.listOrders(tenantId, { status: st });
    return { text: list.length ? `Dossiers${st ? ' ' + st : ''} (${list.length}) :\n` + list.slice(0, 10).map((o) => `• ${who(o.contact)} — ${o.serviceName || o.kind} : ${o.status}${o.total != null ? `, ${o.total} ${o.currency}` : ''}`).join('\n') : "Je n'ai aucun dossier correspondant.", intent: 'lifecycle' };
  }
  const c = await lc.candidates(tenantId); const lines = [];
  if (c.idleProspects.length) lines.push(`Prospects intéressés restés sans suite (${c.idleProspects.length}) : ` + c.idleProspects.slice(0, 8).map((p) => `${p.contactId} (${p.state}, ${p.idleHours} h)`).join(', '));
  if (c.due.length) lines.push(`Relances dues maintenant (${c.due.length}) : ` + c.due.slice(0, 8).map((d) => `${who(d.contact)} [${d.kind}]`).join(', '));
  if (c.pendingPayments.length) lines.push(`Paiements en attente (${c.pendingPayments.length}) : ` + c.pendingPayments.slice(0, 8).map((p) => who(p.contact)).join(', '));
  if (c.deliveredWithoutFollowUp.length) lines.push(`Commandes livrées sans suivi (${c.deliveredWithoutFollowUp.length}) : ` + c.deliveredWithoutFollowUp.slice(0, 8).map((d) => who(d.contact)).join(', '));
  if (c.needsOwner.length) lines.push(`Relances qui attendent votre décision (${c.needsOwner.length}) : ` + c.needsOwner.slice(0, 8).map((n) => `${who(n.contact)} (${explainReason(n.reason)})`).join(', '));
  return { text: lines.length ? lines.join('\n') + '\nAvant chaque envoi, je revérifie que la relance a encore lieu d\'être.' : "Rien à relancer ou à suivre pour le moment d'après vos données réelles.", intent: 'lifecycle' };
}

// 'activityreport' — Rapport & Activité : fait / pas fait / bloqué / à améliorer / amélioré, sur les données réelles ; lance aussi le diagnostic.
async function handleActivityReport(text, tenantId) {
  const ai = require('./activityIntelligence');
  const period = (String(text).match(/\b(\d{1,3})\s*(jours?|j|heures?|h)\b/i) || []); const f = period[1] ? { period: `${period[1]}${/^h/i.test(period[2]) ? 'h' : 'd'}` } : (/aujourd/i.test(text) ? { period: '24h' } : {});
  const r = await ai.buildReport(tenantId, f); const rec = await ai.refresh(tenantId);
  const t = (l) => l.slice(0, 5).map((i) => `  – ${i.title}${i.reason ? ' (' + i.reason + ')' : ''}${i.result && i.result.message ? ' → ' + i.result.message : ''}`).join('\n');
  const parts = [`Voici l'état réel de votre activité (${r.total} élément(s)) :`, `✅ Fait : ${r.totals.DONE}`, r.sections.done.length ? t(r.sections.done) : null, `⏳ Pas encore fait : ${r.totals.NOT_DONE}`, r.sections.notDone.length ? t(r.sections.notDone) : null, `⛔ Bloqué : ${r.totals.BLOCKED}`, r.sections.blocked.length ? t(r.sections.blocked) : null, `🔧 À améliorer : ${rec.open.length}`, rec.open.length ? rec.open.slice(0, 5).map((i) => `  – ${i.recommendation} (${i.kind === 'AUTO_SAFE' ? 'action sûre : je peux l\'appliquer si vous me le dites' : i.kind === 'TECHNICAL' ? 'technique : proposée, jamais appliquée seule' : 'attend votre validation'})`).join('\n') : null, `📈 Amélioré : ${r.totals.IMPROVED}`, r.sections.improved.length ? t(r.sections.improved) : null, r.note].filter(Boolean);
  return { text: parts.join('\n'), intent: 'activityreport', actionLog: [{ icon: '📊', label: 'Rapport construit sur données réelles', status: 'done' }] };
}

// 'convpolicy' — « pourquoi as-tu répondu / pas répondu à X ? » (explication factuelle) ; lecture du comportement ; réglages → agent à outils (setConversationPolicy, avec vérification).
async function handleConvPolicy(text, history, tenantId, sessionId, deps) {
  if (WHY_REPLY_RE.test(text)) {
    const clean = String(text).replace(/[?.!\s]+$/, ''); const m = clean.match(/(?:dans|au|le)\s+groupe\s+(.+)$/i) || clean.match(/\b(?:à|avec)\s+(.+)$/i) || clean.match(/\bpour\s+(.+)$/i);
    const call = await toolRegistry.execute(tenantId, 'explainReply', m ? { conversation: m[1].trim() } : {}, {});
    if (call.state !== 'SUCCESS') return { text: (call.error && call.error.message) || 'Je ne retrouve pas cette discussion dans les 7 derniers jours.', intent: 'convpolicy', actionLog: [{ icon: '⚠️', label: 'Explication indisponible', status: 'error' }] };
    const r = call.result;
    if (!r.count) return { text: r.note || 'Aucune décision enregistrée pour cette discussion sur les derniers jours.', intent: 'convpolicy', actionLog: [{ icon: '🔎', label: 'Aucune décision trouvée', status: 'done' }] };
    const lines = r.decisions.slice(0, 5).map((d) => `• ${d.decision}${d.why ? ' — ' + d.why : ''}`);
    return { text: `${r.conversation ? 'Pour « ' + r.conversation + ' » : ' : 'Mes dernières décisions : '}\n${lines.join('\n')}`, intent: 'convpolicy', toolCall: { name: 'explainReply', state: call.state, result: r }, actionLog: [{ icon: '🔎', label: 'Décisions relues dans mon journal', status: 'done' }] };
  }
  if (/(?:quel(?:le)?s?|montre|affiche|donne)[^.?!]{0,40}(?:comportement|politique|r[èe]glages?)/i.test(text) && !/(?:mets?|change|r[ée]gle|passe|d[ée]sactive|active)/i.test(text)) {
    const call = await toolRegistry.execute(tenantId, 'getConversationPolicy', {}, {});
    if (call.state === 'SUCCESS') return { text: `Voici comment je me comporte :\n- ${call.result.resume.join('\n- ')}\nDites-moi ce que vous voulez changer (par ex. « dans le groupe X, réponds seulement si on me mentionne »).`, intent: 'convpolicy', toolCall: { name: 'getConversationPolicy', state: call.state, result: call.result }, actionLog: [{ icon: '🎛️', label: 'Comportement relu', status: 'done' }] };
  }
  const agent = await agentLoop.runAgentLoop({ text, history, tenantId, sessionId }, { runtime: deps.runtime || null, permissions: deps.toolPermissions || undefined, toolContext: deps.toolContext || undefined, llm: deps.llm || undefined }).catch(() => null);
  if (agent) return Object.assign(agent, { intent: 'convpolicy' });
  return { text: "Je n'ai pas pu régler cela. Dites-moi par exemple : « dans le groupe X, réponds seulement si on me mentionne » ou « ne parle jamais business à Awa ».", intent: 'convpolicy', isPlanningQuestion: true };
}

async function handleGenMedia(text, tenantId, deps) {
  const call = await toolRegistry.execute(tenantId, 'generateImage', { prompt: text }, { generateImage: deps.generateImage || null });
  if (call.state !== 'SUCCESS') {
    const why = (call.error && call.error.code) === 'IMAGE_ENGINE_UNAVAILABLE'
      ? 'le générateur d\'image n\'est pas disponible ici'
      : ((call.error && call.error.code) || call.state);
    return { text: `Je n'ai pas pu générer le visuel (${why}).`, actionLog: [{ icon: '⚠️', label: 'Génération échouée', status: 'error' }] };
  }
  return {
    text: 'Voilà ton visuel ! Tu peux le télécharger juste en dessous. 👇',
    toolCall: { name: 'generateImage', state: call.state, result: call.result },
    actionLog: [{ icon: '🎨', label: 'Visuel généré', status: 'done' }],
  };
}

// ---------------------------------------------------------------------------
// Point d'entrée unique — appelé par index.js AVANT le pipeline chat/média
// existant (image/vidéo/livre, réponse générique). `deps` = { runtime,
// engineFor, humanContext } injectés depuis la même instance que
// lib/intelligence/vps-bridge.js (voir index.js, zéro moteur dupliqué).
// ---------------------------------------------------------------------------
// POINT D'ENTRÉE UNIQUE du Chat intelligent (Web, WhatsApp, Telegram passent tous ici). Sécurité côté backend, jamais confiée au
// texte ni au LLM : l'appelant doit avoir été AUTHENTIFIÉ par le canal (principal émis par du code serveur de confiance), son
// compte doit être celui visé, et seuls les rôles OWNER/ADMIN accèdent à ce moteur (un client, un contact privé ou un groupe
// n'ont jamais accès au back-office, quoi qu'ils écrivent). Le principal est ensuite porté par le contexte d'exécution : chaque
// outil refait SES PROPRES vérifications (rôle, compte, paramètres, propriété de la ressource) — deny-by-default.
// `tainted` : le tour contient du contenu externe (fichier, média, transcription) : les actions d'écriture externes exigeront
// alors une confirmation explicite (voir toolRegistry).
async function handle(input, deps) {
  // Principal transmis par le canal, sinon celui déjà établi par une couche de confiance en amont (contexte d'exécution).
  const p = (input && input.principal) || authz.currentPrincipal();
  const allowed = authz.isPrincipal(p) && (p.role === authz.ROLES.OWNER || p.role === authz.ROLES.ADMIN)
    && (p.role === authz.ROLES.ADMIN || p.tenant === String(input && input.tenantId));
  if (!allowed) {
    return { text: "Je ne peux pas traiter cette demande : votre identité n'a pas pu être vérifiée pour ce compte.", blocked: true, actionLog: [{ icon: '🔒', label: 'Accès refusé', status: 'error' }] };
  }
  return authz.runAs(p, () => handleInner(input, deps), { tainted: !!input.tainted });
}

// Demande d'AVIS / d'ANALYSE / de STRATÉGIE du propriétaire (et non un ordre d'exécution) : les spécialistes peuvent y répondre même quand une
// intention d'action (« goal ») a été détectée. Un ordre d'exécution (envoyer, lancer, programmer…) ne passe jamais par eux.
const ADVISORY_RE = /(analys|strat[ée]gie|comprend\w*\s+pourquoi|conseill|que penses|[ée]value|diagnostic|optimis|am[ée]lior|d[ée]cortiqu)/i;
const OBJECTIVE_RE = /(?:\bobjectif\b|\bmission\b|organise\s+(?:tout|la\s+mission)|prends?\s+en\s+charge|fais\s+(?:tout|le\s+nécessaire)|je\s+veux\s+(?:vendre|atteindre|obtenir|réaliser)|aujourd['’]hui[^.]{0,60}\b(?:vendre|atteindre|obtenir)\b|(?:vendre|convertir|inscrire)[^.]{0,35}\b\d+\b)/i;

function isComplexObjective(text) {
  const value = String(text || '');
  if (/je\s+veux\s+(?:vendre|atteindre|obtenir|r[eé]aliser)|aujourd['’]hui[^.]{0,60}\b(?:vendre|atteindre|obtenir)\b/i.test(value)
    && !/\b\d+\b/.test(value) && !/\b(?:objectif|mission)\b|organise\s+(?:tout|la\s+mission)|prends?\s+en\s+charge|fais\s+le\s+n[eé]cessaire/i.test(value)) return false;
  return OBJECTIVE_RE.test(value);
}

function isCompositeAction(text) {
  const value = String(text || '');
  const hasAction = (part) => ACTION_RE.test(part) || ADDITIONAL_ACTION_RE.test(part);
  const connectors = new RegExp(COMPOSITE_RE.source, 'gi');
  for (const match of value.matchAll(connectors)) {
    const left = value.slice(0, match.index);
    const right = value.slice(match.index + match[0].length);
    if (hasAction(left) && hasAction(right)) return true;
  }
  return false;
}

function missionDeps(d) {
  return {
    runtime: d.runtime || null, permissions: d.toolPermissions || undefined,
    toolContext: d.toolContext || undefined, generateImage: d.generateImage || null,
    llm: d.objectiveLlm || d.llm || undefined, notifyMission: d.notifyMission || undefined,
    background: true,
  };
}

async function handleInner({ text, history, tenantId, sessionId, lastAssistantMessage }, deps) {
  const d = deps || {};

  // Secrets d'authentification des canaux doivent être traités avant toute
  // résolution de confirmation en attente (même si un mot de passe ressemble
  // à « oui »/« non »). Ils ne passent jamais dans l'agent ni dans le LLM.
  const loginResult = await handleDirectLogin(text, tenantId, d);
  if (loginResult) return loginResult;

  // Décision de validation de paiement manuel (Human-in-the-Loop) — un
  // "VALIDER"/"REFUSER" tapé par l'admin dans SON tchat ne correspond à aucune
  // intention ci-dessous ; il est traité en priorité. resolveAdminDecision
  // renvoie null (2 tests regex) si ce n'est pas une décision, sans jamais lire
  // le disque — aucun surcoût sur un message normal.
  const decision = await manualPaymentValidator.resolveAdminDecision(tenantId, text, {
    deliverToClient: d.deliverToClient || null,
    executeOptions: d.executeOptions || {},
  }).catch((err) => {
    console.warn('chatOrchestrator — échec resolveAdminDecision, repli :', err.message);
    return null;
  });
  if (decision) return { text: decision.text, actionLog: decision.actionLog || null };

  // Un « oui » doit désigner une seule action parmi tous les mécanismes de
  // confirmation persistants du même compte et de la même conversation.
  const decisionRef = String(text || '').match(/\b(?:ACT-[A-F0-9]{12}|mis_[a-z0-9_]+)\b/i);
  if (!decisionRef && (require('./personaManager').detectAffirmative(text) || require('./personaManager').detectDecline(text))) {
    const principal = authz.currentPrincipal();
    if (authz.isPrincipal(principal) && principal.tenant === String(tenantId)) {
      const identity = { tenant: tenantId, userId: principal.userId, role: principal.role, sessionId, conversationId: sessionId };
      const [toolActions, missions] = await Promise.all([
        require('./pendingToolActions').listForIdentity(tenantId, identity).catch(() => []),
        missionOrchestrator.list(tenantId).catch(() => []),
      ]);
      const openActions = toolActions.filter((item) => ['PENDING', 'EXECUTING'].includes(item.status));
      const openMissions = missions.filter((item) => String(item.sessionId || '') === String(sessionId || '')
        && String(item.userId || '') === String(principal.userId || '')
        && ['waiting_input', 'needs_confirmation'].includes(item.state));
      if (openActions.length + openMissions.length > 1) {
        return { text: 'Plusieurs actions ou missions attendent une réponse. Indique la référence ACT-… ou l’identifiant de la mission à reprendre.',
          pendingActions: openActions.map((item) => ({ pendingActionId: item.pendingActionId, tool: item.tool, status: item.status })),
          pendingMissions: openMissions.map((item) => ({ missionId: item.id, pendingActionId: item.pendingActionId, state: item.state })) };
      }
    }
  }

  // Confirmation d'une action sensible préparée (PREPARE -> oui -> EXECUTE -> VERIFY).
  const confirmed = await agentLoop.resolvePending({ tenantId, sessionId, conversationId: sessionId, history, text }, {
    ctx: Object.assign({}, d.toolContext || {}, {
      runtime: d.runtime || null,
      permissions: d.toolPermissions || ['messages:send'],
      generateImage: d.generateImage || null,
      confirmFrom: d.confirmFrom || null,
      principal: authz.currentPrincipal(),
    }),
    llm: d.llm || undefined,
  }).catch((err) => { console.warn('tool confirmation recovery:', err.message); return null; });
  if (confirmed) return confirmed;

  // Une réponse à une question de mission reprend l'état persistant, aussi
  // depuis un autre canal Self rattaché au même compte.
  try {
    const pendingMissions = await missionOrchestrator.list(tenantId);
    const principal = authz.currentPrincipal();
    const activeMissions = pendingMissions.filter((m) => String(m.sessionId || '') === String(sessionId || '')
      && (!principal || String(m.userId || '') === String(principal.userId || ''))
      && ['waiting_input', 'needs_confirmation'].includes(m.state));
    const missionRef = String(text || '').match(/\b(?:ACT-[A-F0-9]{12}|mis_[a-z0-9_]+)\b/i);
    const pending = missionRef
      ? activeMissions.find((m) => m.pendingActionId === missionRef[0] || m.id === missionRef[0])
      : activeMissions.length === 1 ? activeMissions[0] : null;
    if (!pending && activeMissions.length > 1 && !missionRef
      && (require('./personaManager').detectAffirmative(text) || require('./personaManager').detectDecline(text))) {
      return { text: 'Plusieurs missions attendent une réponse. Indique la référence de la mission ou de l’action à reprendre.', pendingMissions: activeMissions.map((m) => ({ missionId: m.id, pendingActionId: m.pendingActionId, state: m.state })) };
    }
    if (pending) {
      const freshCommand = isComplexObjective(text) && !/^(?:oui|non|ok|d'accord)\b/i.test(String(text).trim());
      if (!freshCommand && (pending.state === 'needs_confirmation'
        ? require('./personaManager').detectAffirmative(text) || require('./personaManager').detectDecline(text)
        : (lastAssistantMessage && lastAssistantMessage.isPlanningQuestion || !detectIntent(text, null) || detectIntent(text, null) === 'goal'))) {
        return missionOrchestrator.resume({ tenantId, id: pending.id, answer: text, sessionId }, missionDeps(d));
      }
    }
  } catch (err) { console.warn('missionOrchestrator continuation:', err.message); }

  // Reprend explicitement la fiche de collecte d'une campagne en attente. La
  // réponse peut être un texte exact (sans verbe d'action ni mot-clé métier).
  if (lastAssistantMessage && lastAssistantMessage.isPlanningQuestion && lastAssistantMessage.intent === 'groupcampaign') {
    return handleGroupCampaign(text, history, tenantId, d, lastAssistantMessage);
  }

  // « Objectif du mois : 1 000 000 FCFA » : rattaché à la campagne de groupes s'il en existe une (sinon comportement historique).
  if (GROUPGOAL_RE.test(text) && !(lastAssistantMessage && lastAssistantMessage.isPlanningQuestion)) {
    try { if ((await require('./groupCampaigns').list(tenantId)).length) return handleGroupCampaign(text, history, tenantId, d, lastAssistantMessage); } catch (e) { /* repli */ }
  }

  const intent = detectIntent(text, lastAssistantMessage);
  const contextualToolRequest = isContextualToolRequest(text, history);
  if (!intent && isQuickChat(text) && !contextualToolRequest) return null; // conversation courante : réponse directe (voir isQuickChat)
  if (intent === 'goal' && isComplexObjective(text) && !ADVISORY_RE.test(String(text))) {
    return missionOrchestrator.start({ text, tenantId, sessionId, channel: (authz.currentPrincipal() || {}).channel, history }, missionDeps(d));
  }
  if (isCompositeAction(text)) {
    return missionOrchestrator.start({ text, tenantId, sessionId, channel: (authz.currentPrincipal() || {}).channel, history }, missionDeps(d));
  }
  if (intent && intent !== 'groupcampaign' && intent !== 'groups' && (ACTION_RE.test(text) || ADDITIONAL_ACTION_RE.test(text) || REGISTRY_READ_INTENTS.has(intent))) {
    const genericAgent = await agentLoop.runAgentLoop(
      { text, history, tenantId, sessionId },
      { rawText: text, returnGap: false, runtime: d.runtime || null, permissions: d.toolPermissions || undefined, generateImage: d.generateImage || null, toolContext: d.toolContext || undefined, llm: d.llm || undefined },
    ).catch((err) => { console.warn('chatOrchestrator tool registry fallback:', err.message); return null; });
    if (genericAgent) return genericAgent;
  }
  if (!intent) {
    // Aucune intention à motif connu : l'AGENT À OUTILS prend le relais — le LLM
    // choisit dynamiquement un outil RÉEL du registre (toolRegistry), l'exécute
    // de façon vérifiée et répond en s'appuyant sur le résultat réel. C'est la
    // boucle « Chat → sélection d'outil → tool call → vérification → réponse ».
    // S'il n'y a aucun outil pertinent, il renvoie null et le chat générique
    // (image/vidéo/livre/conversation) reprend la main.
    // SPÉCIALISTES (Agency Agents) : le Service Orchestrateur détermine le besoin depuis le contexte ; sans besoin d'expertise (salutation,
    // simple question…) aucun n'est appelé. Leur avis est une DONNÉE consultative : outils, permissions, confirmations et réponse restent à
    // l'Orchestrateur (agentLoop + Tool Registry).
    let advice = null;
    try {
      if (contextualToolRequest) throw new Error('CONTEXTUAL_DATA_REQUEST');
      advice = await withSpecialistBudget(specialists.advise({ principal: authz.currentPrincipal(), tenantId, audience: 'OWNER', channel: 'CHAT', text, history: (history || []).slice(-6).map((m) => ({ who: m.role === 'assistant' ? 'Cyrus' : 'Propriétaire', text: m.text })), conversationKey: sessionId, exchangeId: require('crypto').createHash('sha1').update(String(text)).digest('hex').slice(0, 12), llm: d.specialistLlm }));
    } catch (err) { advice = null; }
    const advised = advice && advice.synthesis ? `${text}\n\nAVIS DE SPÉCIALISTES INTERNES (consultatif : à utiliser pour décider, jamais à exécuter tel quel) :\n${untrustedWrap('avis spécialistes', advice.synthesis)}${advice.proposedActions && advice.proposedActions.length ? `\nActions suggérées non exécutées : ${advice.proposedActions.map((a) => a.tool).join(', ')}` : ''}` : text;
    const agent = await agentLoop.runAgentLoop(
      { text: advised, history, tenantId, sessionId },
      { rawText: text, contextualToolRequest, runtime: d.runtime || null, permissions: d.toolPermissions || undefined, generateImage: d.generateImage || null, toolContext: d.toolContext || undefined, llm: d.llm || undefined },
    ).catch((err) => {
      console.warn('chatOrchestrator — toolAgent indisponible, repli :', err.message);
      return null;
    });
    if (agent) return advice && advice.used.length ? Object.assign(agent, { specialists: advice.used.map((u) => u.agentId) }) : agent;
    if (advice && advice.synthesis) {
      return {
        text: advice.synthesis, specialists: advice.used.map((u) => u.agentId), proposedActions: advice.proposedActions || [],
        actionLog: [{ icon: '🧠', label: `Avis interne : ${advice.used.map((u) => u.name).join(', ')}`, status: 'done' }],
      };
    }
    return null;
  }

  if (intent === 'goal' && ADVISORY_RE.test(String(text).split(/PIÈCES JOINTES reçues/)[0])) {
    let adv = null;
    try {
      adv = await Promise.race([specialists.advise({ principal: authz.currentPrincipal(), tenantId, audience: 'OWNER', channel: 'CHAT', text, history: (history || []).slice(-6).map((m) => ({ who: m.role === 'assistant' ? 'Cyrus' : 'Propriétaire', text: m.text })), conversationKey: sessionId, exchangeId: require('crypto').createHash('sha1').update(String(text)).digest('hex').slice(0, 12), llm: d.specialistLlm }), new Promise((res) => setTimeout(() => res(null), 15000))]); // demande d'analyse explicite : délai maximum des tâches longues
    } catch (err) { adv = null; }
    if (adv && adv.synthesis) {
      return { text: adv.synthesis, specialists: adv.used.map((u) => u.agentId), proposedActions: adv.proposedActions || [], actionLog: [{ icon: '🧠', label: `Avis interne : ${adv.used.map((u) => u.name).join(', ')}`, status: 'done' }] };
    }
  }

  const sessionKey = `${tenantId || 'default'}:${sessionId || 'default'}`;
  switch (intent) {
    case 'offer': return handleOffer(text, history, tenantId);
    case 'goal': return handleGoal(text, sessionKey, tenantId, d);
    case 'report': return handleReport(text, tenantId, d);
    case 'inbox': return handleInbox(text, tenantId, d);
    case 'groupcampaign': return handleGroupCampaign(text, history, tenantId, d, lastAssistantMessage);
    case 'adcampaign': return handleAdCampaign(text, history, tenantId, d, lastAssistantMessage);
    case 'ownerqueue': return handleOwnerQueue(text, tenantId);
    case 'memory': return handleMemory(text, tenantId, d);
    case 'reply': return handleReply(text, tenantId, d);
    case 'actionsreport': return handleActionsReport(tenantId);
    case 'groups': return handleGroups(text, tenantId, d);
    case 'grouppost': return handleGroupPost(text, history, sessionKey, tenantId, d);
    case 'recurring': return handleRecurring(text, history, tenantId, d);
    case 'crm': return handleCrm(text, tenantId);
    case 'payment': return handlePayment(text, history, tenantId, d);
    case 'connector': return handleConnector(text, history, tenantId, d, sessionId);
    case 'businessinfo': return handleBusinessInfo(text, history, tenantId, d);
    case 'configsvc': return handleConfigSvc(text, history, tenantId, d, lastAssistantMessage);
    case 'importcontacts': return handleImportContacts(text, tenantId);
    case 'genmedia': return handleGenMedia(text, tenantId, d);
    case 'community': return handleCommunity(text, history, tenantId, sessionId, d);
    case 'selfknow': return handleSelfKnow(text, tenantId);
    case 'convpolicy': return handleConvPolicy(text, history, tenantId, sessionId, d);
    case 'svccmd': return require('./serviceCommands').run(tenantId, text);
    case 'guide': return handleGuide(text, tenantId, lastAssistantMessage);
    case 'lifecycle': return handleLifecycle(text, tenantId);
    case 'activityreport': return handleActivityReport(text, tenantId);
    default: return null;
  }
}

// Les codes Telegram et le code d’appairage WhatsApp sont des secrets
// d’authentification : ils passent par un routage direct (sans agent/LLM).
async function handleDirectLogin(text, tenantId, deps) {
  const value = String(text || '').trim();
  const p = authz.currentPrincipal();
  const ctx = Object.assign({}, deps.toolContext || {}, { tenant: tenantId, principal: p,
    runtime: deps.runtime || null, permissions: deps.toolPermissions || ['messages:send'], confirmed: true, direct: true });
  const pairRequested = /whats?app/i.test(value) && /(?:connect|reconnect|appair|associe|lier)/i.test(value);
  if (pairRequested) {
    const digits = (value.match(/\+?\d[\d\s().-]{7,}/) || [])[0];
    if (!digits) return { text: 'Indiquez le numéro international à appairer, par exemple +226…', isPlanningQuestion: true, intent: 'channel_login' };
    const call = await toolRegistry.execute(tenantId, 'startWhatsAppPairing', { phoneNumber: digits }, ctx);
    if (call.state !== 'SUCCESS') return { text: 'Je n’ai pas pu demander le code WhatsApp (' + ((call.error && call.error.code) || call.state) + '). ' + ((call.error && call.error.message) || ''), intent: 'channel_login', toolCall: { name: 'startWhatsAppPairing', state: call.state } };
    const code = call.result.pairingCode;
    return { text: 'Code d’appairage WhatsApp pour le numéro indiqué : ' + code + '. Saisissez-le dans WhatsApp sur le téléphone à lier.', intent: 'channel_login', toolCall: { name: 'startWhatsAppPairing', state: call.state, result: { state: call.result.state, phoneNumber: call.result.phoneNumber } }, actionLog: [{ icon: '📲', label: 'Code d’appairage généré par la session WhatsApp', status: 'done' }] };
  }

  const codeMatch = value.match(/^(?:\/telegram-code|(?:code|otp)\s*(?:telegram)?)[\s:=_-]*(\d{4,8})$/i);
  const passMatch = value.match(/^\/telegram-password\s+([\s\S]{1,200})$/i);
  if (!codeMatch && !passMatch) return null;
  const manager = require('../adapters/telegramManager');
  const entry = manager.peek(tenantId);
  const session = entry && entry.session;
  const state = session && typeof session.getLoginStep === 'function' ? session.getLoginStep() : 'missing';
  if (!session || state === 'missing' || state === 'pending' || state === 'connected') {
    return { text: 'Aucune authentification Telegram n’attend ce code. Je ne l’ai transmis à aucun outil ni modèle.', intent: 'channel_login', actionLog: [{ icon: '🔒', label: 'Code non utilisé', status: 'warning' }] };
  }
  if (codeMatch) {
    if (state !== 'code_required') return { text: 'Telegram n’attend pas un code à cette étape (' + state + '). Utilisez le mot de passe 2FA seulement si Cyrus le demande.', intent: 'channel_login' };
    const call = await toolRegistry.execute(tenantId, 'submitTelegramLoginCode', { code: codeMatch[1] }, ctx);
    return { text: call.state === 'SUCCESS' ? (call.result.step === 'connected' ? 'Telegram est connecté.' : call.result.step === 'password_required' ? 'Telegram demande le mot de passe 2FA. Envoyez /telegram-password suivi du mot de passe.' : 'Code Telegram accepté; étape suivante : ' + call.result.step + '.') : 'Telegram n’a pas accepté le code (' + ((call.error && call.error.code) || call.state) + ').', intent: 'channel_login', toolCall: { name: 'submitTelegramLoginCode', state: call.state, result: call.result || null, error: call.error || null }, actionLog: [{ icon: call.state === 'SUCCESS' ? '🔐' : '⚠️', label: 'Code Telegram traité sans appel IA', status: call.state === 'SUCCESS' ? 'done' : 'error' }] };
  }
  if (state !== 'password_required') return { text: 'Telegram n’attend pas de mot de passe 2FA à cette étape (' + state + ').', intent: 'channel_login' };
  const call = await toolRegistry.execute(tenantId, 'submitTelegramLoginPassword', { password: passMatch[1] }, ctx);
  return { text: call.state === 'SUCCESS' && call.result.step === 'connected' ? 'Telegram est connecté.' : call.state === 'SUCCESS' ? 'Mot de passe accepté; état de connexion : ' + call.result.step + '.' : 'Telegram n’a pas accepté le mot de passe (' + ((call.error && call.error.code) || call.state) + ').', intent: 'channel_login', toolCall: { name: 'submitTelegramLoginPassword', state: call.state, result: call.result || null, error: call.error || null }, actionLog: [{ icon: call.state === 'SUCCESS' ? '🔐' : '⚠️', label: '2FA Telegram traité sans appel IA', status: call.state === 'SUCCESS' ? 'done' : 'error' }] };
}

module.exports = { detectIntent, isQuickChat, isContextualToolRequest, handle, handleOwnerQueue, searchMyGroups };
