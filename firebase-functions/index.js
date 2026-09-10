// Cloud Functions appelées par les clients (VPS, local-client/, futur
// client mobile). Deux régimes différents selon la fonctionnalité — voir
// lib/firebaseSync.js pour le détail :
// - Licences (verifyLicenseOffline, createLicenseOffline, etc.) : Firestore
//   est une base PARTAGÉE avec le VPS (licenses.js), pas un simple secours
//   — les deux côtés peuvent créer/vérifier une licence en autorité, et
//   convergent l'un vers l'autre en temps réel (voir local-client/lib/license.js,
//   qui appelle désormais Firebase en PREMIER, VPS en repli).
// - IA (generateTextFallback, generateImageFallback) : ici bien un mode
//   dégradé au sens strict, UNIQUEMENT quand le VPS central ne répond pas
//   (voir lib/aiGateway.js#failover) — le VPS (lib/ai/llmFallbackEngine.js)
//   reste l'autorité normale, ce dossier ne reproduit qu'un seul fournisseur
//   par type, pas la cascade complète du backend principal.
//
// Déploiement (à faire une fois, depuis ce dossier, avec le CLI Firebase de
// l'utilisateur — jamais depuis une session Claude Code qui n'a pas accès à
// son compte Google) :
//   firebase login
//   firebase use <votre-project-id>
//   firebase functions:secrets:set GROQ_API_KEY
//   firebase functions:secrets:set FAL_KEY
//   firebase functions:secrets:set ADMIN_SECRET
//   firebase deploy --only functions:verifyLicenseOffline,functions:createLicenseOffline,functions:generateTextFallback,functions:generateImageFallback
// JAMAIS "firebase deploy --only functions" (sans noms précis) ni
// ",firestore:rules" — voir README.md : ce projet Firebase est PARTAGÉ avec
// une autre application (RIEA AFRIQUE), un déploiement non scopé a déjà
// causé un incident (règles Firestore écrasées le 2026-09-09).
const crypto = require('crypto');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const axios = require('axios');

admin.initializeApp();
const db = admin.firestore();
// getStorage() utilise l'Admin SDK, qui CONTOURNE les règles Storage (comme
// pour Firestore) — aucune modification de storage.rules n'est donc jamais
// nécessaire ni ne doit être tentée depuis ce dossier (même risque que
// firestore.rules, voir README.md). "cyrus-failover/" préfixe CLAIREMENT
// distinct des chemins déjà utilisés par RIEA AFRIQUE (ex: "videos/{uid}/"
// — voir storage.rules de cette app, gérée ailleurs) pour zéro collision.
const bucket = admin.storage().bucket();
const STORAGE_PREFIX = 'cyrus-failover';

const GROQ_API_KEY = defineSecret('GROQ_API_KEY');
const FAL_KEY = defineSecret('FAL_KEY');
const ADMIN_SECRET = defineSecret('ADMIN_SECRET');

// Même liste que licenses.js#ALL_MODULES (racine) — dupliquée ici
// volontairement : ce fichier tourne dans un runtime séparé (Cloud
// Functions), pas d'import cross-projet possible.
const ALL_MODULES = ['whatsapp', 'telegram', 'studio_video'];
function normalizeModules(allowedModules) {
  if (!Array.isArray(allowedModules)) return ALL_MODULES.slice();
  return allowedModules.filter((m) => ALL_MODULES.includes(m));
}
function generateKeyString() {
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `KEY-${random}-${new Date().getFullYear()}`;
}

// ---------- Vérification de licence en mode dégradé ----------
// Décision du 2026-09-09 (demande explicite, risque assumé) : Firestore est
// désormais une base de vérité PARTAGÉE avec le VPS (voir
// ../lib/firebaseSync.js), pas une simple copie de secours — cette fonction
// peut donc lier un TOUT NOUVEAU appareil (pas seulement continuer un
// appareil déjà lié), pour que l'activation de nouveaux clients reste
// possible même si le VPS a disparu durablement. Le VPS convergera
// automatiquement vers cette liaison dès qu'il redevient joignable (écoute
// temps réel, voir licenses.js#watchLicenses).
//
// Compromis de sécurité ASSUMÉ : une clé compromise/partagée pourrait être
// activée sur un nouvel appareil pendant que le VPS est down et ne peut pas
// s'y opposer. Le verrou "un appareil par clé UNE FOIS lié" reste actif
// (DEVICE_MISMATCH ci-dessous) — seule la PREMIÈRE liaison est désormais
// permise hors-ligne.
exports.verifyLicenseOffline = onRequest(async (req, res) => {
  const { key, deviceId } = req.body || {};
  if (!key) return res.status(400).json({ valid: false, reason: 'MISSING_KEY' });
  if (!deviceId) return res.status(400).json({ valid: false, reason: 'MISSING_DEVICE_ID' });

  const ref = db.collection('licenses').doc(String(key).trim().toUpperCase());
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ valid: false, reason: 'NOT_FOUND' });

  const license = doc.data();
  if (!license.active) return res.status(403).json({ valid: false, reason: 'INACTIVE' });
  if (license.expiresAt && new Date(license.expiresAt).getTime() < Date.now()) {
    return res.status(403).json({ valid: false, reason: 'EXPIRED' });
  }

  if (!license.boundDeviceId) {
    // Première utilisation de cette clé : liaison faite ICI, directement
    // dans Firestore — voir le raisonnement de sécurité ci-dessus.
    const boundAt = new Date().toISOString();
    await ref.update({ boundDeviceId: deviceId, boundAt });
    license.boundDeviceId = deviceId;
    license.boundAt = boundAt;
  } else if (license.boundDeviceId !== deviceId) {
    return res.status(403).json({ valid: false, reason: 'DEVICE_MISMATCH' });
  }

  res.status(200).json({
    valid: true,
    degraded: true, // signale au client qu'il fonctionne en mode secours
    expiresAt: license.expiresAt,
    allowedModules: license.allowedModules,
  });
});

// ---------- Création de licence en mode dégradé ----------
// Pendant du portail admin du VPS (POST /api/admin/licenses côté racine) —
// même rôle, autre porte d'entrée : protégée par un secret ADMIN dédié
// (ADMIN_SECRET, VOLONTAIREMENT distinct de ADMIN_PASSWORD du VPS pour ne
// jamais coupler leur rotation), pas par une licence client.
// cors: true sur les 4 fonctions admin ci-dessous : appelées depuis
// cyrus-license-admin.web.app (page admin, voir admin-ui/), une origine
// DIFFÉRENTE de cloudfunctions.net — sans ça le navigateur bloquerait la
// requête. Sans risque : l'autorisation réelle vient du header
// x-admin-secret vérifié dans chaque fonction, pas de CORS lui-même.
function requireAdminSecret(req, res) {
  const provided = req.get('x-admin-secret');
  if (!provided || provided !== ADMIN_SECRET.value()) {
    res.status(401).json({ error: 'Secret admin invalide.' });
    return false;
  }
  return true;
}

exports.createLicenseOffline = onRequest({ secrets: [ADMIN_SECRET], cors: true }, async (req, res) => {
  if (!requireAdminSecret(req, res)) return;

  const { expiresAt, note, allowedModules } = req.body || {};
  const license = {
    key: generateKeyString(),
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt || null,
    active: true,
    note: note || '',
    allowedModules: normalizeModules(allowedModules),
    boundDeviceId: null,
    boundAt: null,
  };

  await db.collection('licenses').doc(license.key).set(license);
  res.status(201).json(license);
});

// Pendant du GET /api/admin/licenses côté VPS — liste triée par date de
// création (la plus récente d'abord), comme le portail admin du VPS.
exports.listLicensesOffline = onRequest({ secrets: [ADMIN_SECRET], cors: true }, async (req, res) => {
  if (!requireAdminSecret(req, res)) return;

  const snapshot = await db.collection('licenses').orderBy('createdAt', 'desc').get();
  res.json(snapshot.docs.map((doc) => doc.data()));
});

// Pendant de POST /api/admin/licenses/:key/active côté VPS.
exports.setLicenseActiveOffline = onRequest({ secrets: [ADMIN_SECRET], cors: true }, async (req, res) => {
  if (!requireAdminSecret(req, res)) return;

  const { key, active } = req.body || {};
  if (!key) return res.status(400).json({ error: 'Clé manquante.' });

  const ref = db.collection('licenses').doc(String(key).trim().toUpperCase());
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ error: 'Licence introuvable.' });

  await ref.update({ active: Boolean(active) });
  res.json({ ...doc.data(), active: Boolean(active) });
});

// Pendant de DELETE /api/admin/licenses/:key côté VPS.
exports.deleteLicenseOffline = onRequest({ secrets: [ADMIN_SECRET], cors: true }, async (req, res) => {
  if (!requireAdminSecret(req, res)) return;

  const { key } = req.body || {};
  if (!key) return res.status(400).json({ error: 'Clé manquante.' });

  const ref = db.collection('licenses').doc(String(key).trim().toUpperCase());
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ error: 'Licence introuvable.' });

  await ref.delete();
  res.json({ ok: true });
});

async function checkLicenseForFallback(req) {
  const key = req.get('x-license-key');
  const deviceId = req.get('x-device-id');
  if (!key || !deviceId) return { ok: false, error: 'Authentification manquante.' };

  const doc = await db.collection('licenses').doc(String(key).trim().toUpperCase()).get();
  if (!doc.exists) return { ok: false, error: 'Clé de licence inconnue.' };
  const license = doc.data();
  if (!license.active || (license.expiresAt && new Date(license.expiresAt).getTime() < Date.now())) {
    return { ok: false, error: 'Licence inactive ou expirée.' };
  }
  if (license.boundDeviceId !== deviceId) {
    return { ok: false, error: 'Appareil non reconnu pour cette clé.' };
  }
  return { ok: true };
}

// ---------- Passerelle IA en mode dégradé (MVP : un seul fournisseur par
// type, PAS la cascade complète de lib/ai/llmFallbackEngine.js) ----------
exports.generateTextFallback = onRequest({ secrets: [GROQ_API_KEY] }, async (req, res) => {
  const auth = await checkLicenseForFallback(req);
  if (!auth.ok) return res.status(401).json({ error: auth.error });

  const prompt = String((req.body || {}).prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'Prompt manquant.' });

  try {
    const { data } = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        // Même modèle que lib/ai/llmFallbackEngine.js (racine, niveau Groq) —
        // vérifié fonctionnel en production ; "llama-3.3-70b-versatile"
        // (essayé initialement) renvoie 404 sur ce compte.
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'user', content: prompt }],
      },
      { headers: { Authorization: `Bearer ${GROQ_API_KEY.value()}` } },
    );
    res.json({ text: data.choices[0].message.content, provider: 'groq (mode dégradé)' });
  } catch (err) {
    console.error('Échec génération texte (mode dégradé) :', err.message);
    res.status(502).json({ error: 'Échec de la génération de texte IA (mode dégradé).' });
  }
});

exports.generateImageFallback = onRequest({ secrets: [FAL_KEY] }, async (req, res) => {
  const auth = await checkLicenseForFallback(req);
  if (!auth.ok) return res.status(401).json({ error: auth.error });

  const prompt = String((req.body || {}).prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'Prompt manquant.' });

  try {
    const { data } = await axios.post(
      'https://fal.run/fal-ai/flux/schnell',
      { prompt },
      { headers: { Authorization: `Key ${FAL_KEY.value()}` } },
    );
    const falUrl = data.images?.[0]?.url;
    if (!falUrl) throw new Error('Réponse fal.ai sans URL d\'image.');

    // Rapatrie l'image chez nous (Firebase Storage) plutôt que de renvoyer
    // l'URL fal.ai brute, dont la durée de rétention n'est pas garantie —
    // voir STORAGE_PREFIX plus haut (chemin dédié, aucune règle Storage à
    // toucher, Admin SDK uniquement).
    const imageRes = await axios.get(falUrl, { responseType: 'arraybuffer' });
    const filePath = `${STORAGE_PREFIX}/${crypto.randomUUID()}.jpg`;
    const file = bucket.file(filePath);
    await file.save(Buffer.from(imageRes.data), { contentType: 'image/jpeg' });
    // URL signée plutôt que makePublic() : fonctionne quel que soit le mode
    // d'accès du bucket (l'"accès uniforme au niveau du bucket", courant sur
    // les buckets récents, désactive les ACL par objet et ferait échouer
    // makePublic()) — et évite de rendre un fichier public dans un bucket
    // partagé sans savoir si son mode d'accès le permet.
    const [url] = await file.getSignedUrl({ action: 'read', expires: Date.now() + 7 * 24 * 60 * 60 * 1000 });

    res.json({ url, provider: 'fal.ai (mode dégradé)' });
  } catch (err) {
    console.error('Échec génération image (mode dégradé) :', err.message);
    res.status(502).json({ error: 'Échec de la génération image IA (mode dégradé).' });
  }
});
