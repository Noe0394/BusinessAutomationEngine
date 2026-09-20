// TEST RUNNER — l'orchestrateur du Chat Intelligent route CHAQUE formulation réelle vers la bonne intention/outil.
//   node --test test/orchestrator-intents.test.js
// Matrice de phrases françaises réalistes (dont les exemples de la spécification). `null` = pas d'intention à motif connu : c'est
// l'AGENT À OUTILS (IA) qui choisit et exécute l'outil réel (pause/reprise/annulation/statut de campagne, conversation…).
// Toute régression de routage (ex. « \b » après une lettre accentuée qui rendait « Réponds à Jean… » invisible) est détectée ici.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const o = require('../ai-engine/chatOrchestrator');

const MATRIX = [
  ['Je veux vendre des produits aujourd\'hui', 'goal'], ['analyse mes ventes de la semaine', 'goal'], ['relance mes prospects de cette semaine', 'goal'],
  ['lance une campagne pour 100 clients sur WhatsApp', 'goal'],
  ['Cette semaine j\'ai lancé une campagne Facebook Ads pour ma formation, les nouveaux contacts doivent recevoir « Bienvenue »', 'adcampaign'],
  ['Pendant 3 jours cible tous mes groupes administrés dont le nom contient Épicerie, envoie à 8h, 12h et 18h « Promo »', 'groupcampaign'],
  ['Donne-moi le rapport de la campagne des groupes Épicerie', 'groupcampaign'], ['Arrête la campagne des groupes épicerie', 'groupcampaign'],
  ['Donne-moi les conversations qui nécessitent mon intervention', 'ownerqueue'], ['Donne-moi les paiements en attente', 'ownerqueue'],
  ['Est-ce que j\'ai reçu un message important ?', 'ownerqueue'], ['Montre-moi les personnes qui attendent ma réponse', 'ownerqueue'],
  ['Qui m\'a écrit aujourd\'hui ?', 'memory'], ['Qui a demandé des informations aujourd\'hui ?', 'memory'],
  ['Résume-moi ce que Marie m\'a écrit cette semaine', 'memory'], ['Cherche la dernière conversation avec Jean', 'memory'], ['De quoi avons-nous parlé hier avec Awa ?', 'memory'],
  ['Quel est le dernier message reçu ?', 'inbox'], ['Montre-moi mes derniers messages WhatsApp', 'inbox'], ['as-tu reçu des messages ?', 'inbox'],
  ['Réponds à Jean pour lui dire que je serai disponible demain', 'reply'], ['réponds-lui que c\'est d\'accord', 'reply'], ['dis-lui que la formation commence lundi', 'reply'],
  ['Qu\'as-tu fait aujourd\'hui ?', 'actionsreport'], ['Donne-moi le statut de tes actions récentes', 'actionsreport'],
  ['Liste mes groupes WhatsApp', 'groups'], ['Quels sont les groupes où je suis admin ?', 'groups'], ['montre-moi mes groupes contenant épicerie', 'groups'],
  ['Poste cette affiche dans tous mes groupes admin', 'grouppost'], ['Partage ce message dans le groupe Épicerie', 'grouppost'], ['publie une promo dans mes groupes', 'grouppost'],
  ['Chaque matin envoie bonjour au groupe Famille', 'recurring'], ['tous les jours à 8h envoie mon message au groupe Clients', 'recurring'],
  ['Combien de contacts j\'ai dans mon CRM ?', 'crm'], ['liste mes clients', 'crm'], ['montre mes prospects chauds', 'crm'],
  ['Génère un lien de paiement pour ma formation à 15000 FCFA', 'payment'], ['crée un lien de paiement', 'payment'],
  ['Crée un compte élève pour jean@mail.com sur la formation cuisine', 'connector'], ['inscris marie@mail.com à la formation pâtisserie', 'connector'],
  ['Quel est le prix de ma formation ?', 'businessinfo'], ['Combien coûte mon service épicerie ?', 'businessinfo'], ['Liste mes produits', 'businessinfo'],
  ['Crée un service métier pour ma boutique de vêtements', 'configsvc'], ['Configure mon API RIEA', 'configsvc'],
  ['Importe ce fichier de contacts', 'importcontacts'], ['charge ma liste de clients', 'importcontacts'],
  ['Génère une affiche pour ma promo de Noël', 'genmedia'], ['fais-moi un visuel pour ma formation', 'genmedia'],
  ['Je vends de la pâtisserie, aide-moi à définir mon offre', 'offer'],
  ['Rapport des ventes du jour', 'report'], ['Donne-moi le bilan de la journée', 'report'], ['donne-moi le rapport des ventes', 'report'],
  // pilotage / conversation : AGENT À OUTILS (jamais un nouveau plan d'objectif)
  ['Mets la campagne en pause', null], ['Reprends la campagne', null], ['Combien de messages ont été envoyés par ma campagne ?', null],
  ['Annule la campagne en cours', null], ['salut', null], ['merci beaucoup', null], ["peux-tu m'expliquer comment fonctionne la relance ?", null],
];

test(`routage : ${MATRIX.length} formulations réelles -> la bonne intention (ou l'agent à outils)`, () => {
  const wrong = MATRIX.map(([t, want]) => [t, want, o.detectIntent(t, null)]).filter(([, want, got]) => got !== want);
  assert.deepEqual(wrong, [], 'formulations mal routées : ' + JSON.stringify(wrong));
});

test('exemples de la spécification : réponse au contact et résumé de conversation reconnus (accents inclus)', () => {
  assert.equal(o.detectIntent('Réponds à Jean pour lui dire que je serai disponible demain', null), 'reply');
  assert.equal(o.detectIntent('Résume-moi ce que Marie m\'a écrit cette semaine', null), 'memory');
});

test('la continuation d\'une question posée par le Chat garde l\'intention (pas de reclassement par mots-clés)', () => {
  for (const intent of ['adcampaign', 'groupcampaign', 'goal', 'offer', 'payment']) {
    assert.equal(o.detectIntent('50 produits, WhatsApp', { isPlanningQuestion: true, intent }), intent);
  }
});
