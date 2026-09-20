const llmFallbackEngine = require('../lib/ai/llmFallbackEngine');
const storageAdapter = require('./storageAdapter');
const personaManager = require('./personaManager');

// MODULE DE CLARIFICATION D'OFFRE — ai-engine/offerClarifier.js
// ---------------------------------------------------------------------------
// Quand le vendeur annonce un nouveau produit/service/formation dans le
// tchat (Copywriter Studio IA), l'Agent NE DOIT PAS deviner les détails
// commerciaux : il suspend l'exécution et pose un jeu de questions précis et
// structuré (Phase 1), jusqu'à obtenir les informations clés, puis affiche
// une fiche récapitulative de confirmation (Phase 2) et sauvegarde l'offre
// dans le profil business du tenant (Phase 3 — "bascule en mode autonome").
//
// Réutilise EXACTEMENT le patron déjà éprouvé de index.js#planOrAsk
// (planImage/planVideo/planBook) : un seul appel LLM par tour, qui répond
// SOIT par 2-3 questions courtes (brief incomplet), SOIT par un objet JSON
// "ready" (brief complet) — jamais un état de machine séparé à maintenir à
// la main, c'est le LLM lui-même, guidé par les jeux de questions ci-dessous,
// qui juge la progression à partir de l'historique complet de la discussion.

const NEW_OFFER_RE = /\b(nouvel(?:le)?\s+(?:produit|offre|service|formation|activit[ée])|je\s+(?:veux\s+)?lance\s+(?:un|une)|j'ai\s+une\s+nouvelle\s+(?:offre|activit[ée])|je\s+d[ée]marre\s+(?:un|une)\s+nouvelle?)\b/i;

// Détection RAPIDE (zéro appel réseau, zéro coût) — filet de sécurité avant
// même de consulter le LLM. Volontairement étroite : ne doit JAMAIS capturer
// une commande de campagne sur une offre déjà connue (ex: "je veux vendre 10
// formations aujourd'hui" — voir ai-engine/chatOrchestrator.js#detectIntent,
// qui traite ce cas comme 'campaign', pas 'offer').
function detectNewOfferIntent(text) {
  return NEW_OFFER_RE.test(String(text || ''));
}

function extractJsonBlock(rawText) {
  const match = String(rawText || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (err) {
    return null;
  }
}

// Signature structurelle d'une réponse "hors format" (voir
// index.js#looksLikeRunawayTutorial) — même garde-fou programmatique,
// dupliqué ici volontairement (convention déjà en place dans ce dépôt pour
// ce genre de petit utilitaire, voir firebase-functions/index.js).
function looksLikeRunaway(raw) {
  const t = String(raw || '').trim();
  if (t.length > 600) return true;
  if ((t.match(/\n/g) || []).length > 10) return true;
  if (/^#{1,3}\s/m.test(t)) return true;
  return false;
}

const QUESTION_SETS = [
  '— Si c\'est un PRODUIT PHYSIQUE / E-COMMERCE : (1) Nom & Usage : quel est le nom exact du produit et à quel besoin précis il répond ? (2) Tarif & Options : quel est le prix, et y a-t-il des déclinaisons (tailles, couleurs) ? (3) Livraison & Stock : quels sont les frais/délais de livraison et la quantité disponible ?',
  '— Si c\'est un SERVICE / PRESTATION : (1) Description : en quoi consiste la prestation et quelle est sa durée ? (2) Cible & Tarif : à qui s\'adresse-t-elle et quel est le coût/modalité de paiement ? (3) Prise de RDV : comment se fait la réservation (créneau, à l\'avance, acompte) ?',
  '— Si c\'est une FORMATION / CONTENU NUMÉRIQUE : (1) Objectif : que va apprendre l\'élève à la fin du programme ? (2) Format & Délivrance : comment le cours est-il dispensé (vidéos, Telegram, PDF) et quel est le prix ? (3) Accès : faut-il générer une clé d\'accès ou un compte élève automatique ?',
].join('\n');

// domain (facultatif) : voir personaManager.js#inferDomain — ajuste le ton
// des questions posées (chaleureux/dynamique par défaut pour une toute
// nouvelle offre, puisque le domaine n'est souvent pas encore connu).
async function planOffer(text, history, domain) {
  const prompt = [
    personaManager.personaSystemPrompt(domain || 'default'),
    `Nouveau message du vendeur dans cette discussion : "${text}"`,
    'Le vendeur vient d\'annoncer une nouvelle offre (produit, service ou formation) que CYRUS SUPER ASSISTANT doit désormais connaître pour prospecter/vendre/répondre aux clients à sa place. NE DEVINE JAMAIS les détails commerciaux — pose des questions précises tant qu\'il en manque.',
    'D\'ABORD, si la catégorie de l\'offre n\'est pas encore claire depuis l\'historique, demande-la en premier (une seule question courte : "Est-ce un produit physique, un service, ou une formation ?").',
    'UNE FOIS LA CATÉGORIE CONNUE, pose les questions correspondantes ci-dessous (jamais plus de 3 questions par tour, jamais une question déjà répondue dans l\'historique) :',
    QUESTION_SETS,
    'Base-toi sur TOUT l\'historique de cette discussion pour savoir ce qui a déjà été répondu.',
    'Si des informations importantes manquent encore, réponds UNIQUEMENT par 2 à 3 questions courtes (texte simple, jamais de JSON).',
    'Si tu as assez d\'informations (catégorie + les 3 points de la catégorie concernée), réponds UNIQUEMENT avec cet objet JSON (aucun texte avant/après, aucun markdown) : {"ready":true,"category":"physical"|"service"|"training","summary":"résumé en français de l\'offre configurée, à afficher au vendeur","offer":{"name":"nom de l\'offre","description":"description courte","price":"prix ou modalité de paiement (texte libre, ex: 15000 FCFA)","options":"déclinaisons/variantes ou chaîne vide (produit physique)","delivery":"frais/délais de livraison + stock, ou chaîne vide (produit physique)","duration":"durée de la prestation ou chaîne vide (service)","targetAudience":"cible ou chaîne vide (service)","booking":"modalité de réservation/acompte ou chaîne vide (service)","learningOutcome":"ce que l\'élève apprend ou chaîne vide (formation)","format":"format de délivrance (vidéos/Telegram/PDF...) ou chaîne vide (formation)","accessType":"none, access_key ou student_account (formation uniquement, défaut none)"}}',
  ].join('\n');

  const { text: raw } = await llmFallbackEngine.generateAIResponse(prompt, history, null, undefined, 'designDirectorSkill', { purpose: 'offer_clarification', tier: 'reasoning' });
  const trimmed = raw.trim();
  const parsed = extractJsonBlock(trimmed);
  if (!parsed && looksLikeRunaway(trimmed)) {
    return { raw: 'Dites-m\'en plus sur cette offre (catégorie, prix, et les 2-3 détails clés) et je la configure tout de suite.', parsed: null };
  }
  return { raw: trimmed, parsed };
}

// ---------------------------------------------------------------------------
// Persistance du profil business (namespace storageAdapter dédié) — une
// offre confirmée alimente directement le contexte utilisé par
// answer_student_query/deliver_lesson_content et par le filtrage privé/pro
// (voir lib/intelligence/message-triage.js), qui consultent toutes deux
// getBusinessProfile() pour rester factuelles sur les vraies offres du
// vendeur plutôt que d'halluciner un prix/produit.
// ---------------------------------------------------------------------------
const NAMESPACE = 'business_profiles';

async function getBusinessProfile(tenantId) {
  return storageAdapter.get(NAMESPACE, tenantId, { tenantId, offers: [], updatedAt: null });
}

// Phase 3 du cahier des charges : "bascule immédiatement en mode autonome" —
// aucune confirmation supplémentaire requise ici, l'appelant (chatOrchestrator)
// affiche directement la fiche récapitulative retournée par planOffer.
async function saveOffer(tenantId, offer, category) {
  const profile = await getBusinessProfile(tenantId);
  const entry = {
    id: `${Date.now().toString(36)}`,
    category,
    ...offer,
    createdAt: new Date().toISOString(),
  };
  profile.offers = Array.isArray(profile.offers) ? profile.offers : [];
  profile.offers.push(entry);
  profile.updatedAt = new Date().toISOString();
  storageAdapter.set(NAMESPACE, tenantId, profile);
  return entry;
}

module.exports = { detectNewOfferIntent, planOffer, getBusinessProfile, saveOffer };
