// Pont Firestore pour les licences — Firestore est désormais LA base de
// vérité PARTAGÉE (voir décision du 2026-09-09) : le VPS (licenses.js) et
// les Cloud Functions de secours (firebase-functions/) lisent et écrivent
// la MÊME collection "licenses", chacun capable de fonctionner seul si
// l'autre est indisponible — plus un simple miroir à sens unique VPS ->
// Firestore comme dans la version précédente de ce fichier.
//
// Ancien modèle (abandonné) : le VPS était l'unique autorité, Firestore une
// copie en lecture pour verifyLicenseOffline. Limite constatée : si le VPS
// disparaît durablement (impayé, résiliation...), plus aucune NOUVELLE
// licence ne peut être créée ni aucun nouvel appareil activé, puisque ça
// n'existait que côté VPS. Nouveau modèle : n'importe quel côté peut créer/
// activer une licence ; l'autre s'aligne automatiquement via l'écoute
// temps réel ci-dessous (watchLicenses) dès qu'il redevient joignable.
//
// Compromis de sécurité ASSUMÉ (demande explicite) : firebase-functions/
// index.js#verifyLicenseOffline peut désormais lier un tout NOUVEAU
// appareil à une clé (pas seulement continuer un appareil déjà lié) — une
// clé compromise/partagée pourrait donc être activée sur un nouvel appareil
// même si le VPS est down et ne peut pas s'y opposer.
//
// No-op tant que FIREBASE_SERVICE_ACCOUNT_PATH n'est pas défini — même
// pattern que githubStore.js (sauvegarde optionnelle, jamais bloquante).
const path = require('path');

let firestore = null;
const SERVICE_ACCOUNT_PATH = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '';
const enabled = Boolean(SERVICE_ACCOUNT_PATH);

if (enabled) {
  try {
    // require() paresseux : évite d'imposer firebase-admin comme dépendance
    // dure tant que ce mode n'est pas activé.
    const admin = require('firebase-admin');
    const serviceAccount = require(path.resolve(SERVICE_ACCOUNT_PATH));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    firestore = admin.firestore();
    console.log('Firestore activé comme base de licences partagée (VPS <-> Firebase).');
  } catch (err) {
    console.error(
      'FIREBASE_SERVICE_ACCOUNT_PATH défini mais initialisation Firestore échouée ' +
      '(firebase-admin installé ? chemin correct ?) :', err.message,
    );
  }
}

// Appelé depuis licenses.js#saveLicenses à chaque écriture (création,
// activation/désactivation, liage d'appareil, suppression...). Synchronisation
// COMPLÈTE (pas un simple upsert) : `licenses` est toujours la liste ENTIÈRE
// et actuelle — tout document Firestore absent de cette liste est supprimé
// aussi, sinon une clé supprimée resterait valide indéfiniment côté Firebase.
async function syncLicensesToFirestore(licenses) {
  if (!firestore) return;
  try {
    const collection = firestore.collection('licenses');
    const currentKeys = new Set(licenses.map((l) => l.key));

    const existing = await collection.listDocuments();
    const batch = firestore.batch();

    for (const license of licenses) {
      batch.set(collection.doc(license.key), license);
    }
    for (const docRef of existing) {
      if (!currentKeys.has(docRef.id)) {
        batch.delete(docRef);
      }
    }

    await batch.commit();
  } catch (err) {
    console.error('Échec de synchronisation Firestore des licences :', err.message);
  }
}

// Écoute temps réel de la collection "licenses" — c'est ce qui ferme la
// boucle dans l'AUTRE sens (Firestore -> VPS) : si une Cloud Function crée
// ou lie une licence pendant que ce VPS était down (ou simplement pendant
// qu'un autre processus écrit), `onChange` est appelé avec la liste
// complète et à jour dès que ce process Node redevient joignable — sans
// polling, Firestore notifie activement. `onChange` est aussi appelé pour
// les écritures faites PAR ce process lui-même (Firestore notifie tous les
// listeners, y compris l'auteur) : idempotent côté appelant (réécrire le
// même contenu localement ne casse rien).
function watchLicenses(onChange) {
  if (!firestore) return () => {};
  const unsubscribe = firestore.collection('licenses').onSnapshot(
    (snapshot) => {
      const licenses = snapshot.docs.map((doc) => doc.data());
      onChange(licenses);
    },
    (err) => {
      console.error('Écoute Firestore des licences interrompue (le cache local reste celui déjà connu) :', err.message);
    },
  );
  return unsubscribe;
}

module.exports = { enabled, syncLicensesToFirestore, watchLicenses };
