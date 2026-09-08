const https = require('https');

// Persistance optionnelle de fichiers dans un repo GitHub privé dédié
// (séparé du repo de déploiement, pour ne jamais déclencher de redéploiement
// Render). Activé uniquement si GITHUB_TOKEN et GITHUB_DATA_REPO sont
// définis ; sinon chaque fichier reste local uniquement (comportement
// historique, perdu à chaque redéploiement Render sans disque persistant).
//
// createStore(filePath) crée une instance indépendante pointant vers un
// fichier précis du même repo/branche (ex: "licenses.json",
// "whatsapp_auth.json") — chaque appelant gère son propre sha en cache et
// son propre état de dernier push/lecture.
const TOKEN = process.env.GITHUB_TOKEN || '';
const REPO = process.env.GITHUB_DATA_REPO || ''; // format "owner/repo"
const BRANCH = process.env.GITHUB_DATA_BRANCH || 'main';

const enabled = Boolean(TOKEN && REPO);

function createStore(filePath) {
  let cachedSha = null;

  // État exposé au panneau admin (voir getStatus) pour qu'un admin puisse
  // vérifier depuis le dashboard que la persistance fonctionne réellement,
  // plutôt que de le découvrir seulement après un redéploiement qui a perdu
  // des données.
  const status = {
    lastPushAt: null,
    lastPushOk: null,
    lastPushError: null,
    lastFetchAt: null,
    lastFetchOk: null,
    lastFetchError: null,
  };

  function apiRequest(method, body, query) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const qs = query ? `?${query}` : '';
      const req = https.request(
        {
          hostname: 'api.github.com',
          // encodeURIComponent(filePath) échouerait pour un chemin imbriqué
          // (ex: "whatsapp_auth/KEY-XXXX.json", utilisé depuis l'isolation
          // par tenant) : il échapperait aussi le "/" en "%2F", que l'API
          // Contents de GitHub interprète comme un nom de fichier invalide
          // au lieu d'un vrai sous-dossier — d'où un 422 systématique observé
          // en production pour tout chemin à plusieurs segments. Chaque
          // segment doit être encodé séparément, en gardant les "/" intacts.
          path: `/repos/${REPO}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}${qs}`,
          method,
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'BusinessAutomationEngine',
            'Content-Type': 'application/json',
            ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          },
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => {
            raw += chunk;
          });
          res.on('end', () => {
            let parsed = null;
            try {
              parsed = raw ? JSON.parse(raw) : null;
            } catch (err) {
              parsed = null;
            }
            resolve({ status: res.statusCode, body: parsed });
          });
        },
      );
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  // Récupère le fichier depuis GitHub. Retourne null s'il n'existe pas
  // encore là-bas (première utilisation) ou si le store est désactivé.
  async function fetchRemote() {
    if (!enabled) return null;

    try {
      // ref=BRANCH : sans ce paramètre, GitHub lit toujours la branche par
      // défaut du repo, qui peut différer de GITHUB_DATA_BRANCH si celle-ci a
      // été personnalisée — on lirait alors une version périmée des données.
      const { status: httpStatus, body } = await apiRequest('GET', null, `ref=${encodeURIComponent(BRANCH)}`);

      if (httpStatus === 404) {
        status.lastFetchAt = new Date().toISOString();
        status.lastFetchOk = true;
        status.lastFetchError = null;
        return null;
      }
      if (httpStatus !== 200 || !body) {
        throw new Error(`Lecture GitHub échouée (statut ${httpStatus})`);
      }

      // Capturer le sha dès qu'on le connaît, même si le contenu ne peut pas
      // être lu ci-dessous : sans ça, un fichier qui dépasse la limite de
      // 1 Mo de contenu inline de l'API Contents (content absent, mais sha
      // toujours présent) bloquerait pushRemote indéfiniment — chaque essai
      // échouerait faute de sha connu, sans jamais pouvoir se corriger.
      if (body.sha) cachedSha = body.sha;

      if (!body.content) {
        status.lastFetchAt = new Date().toISOString();
        status.lastFetchOk = true;
        status.lastFetchError = 'Contenu non lisible (fichier > 1 Mo, hors limite de l\'API Contents de GitHub) — sha capturé pour permettre une prochaine écriture.';
        return { content: null, sha: body.sha, tooLarge: true };
      }

      const content = Buffer.from(body.content, 'base64').toString('utf8');
      status.lastFetchAt = new Date().toISOString();
      status.lastFetchOk = true;
      status.lastFetchError = null;
      return { content, sha: body.sha };
    } catch (err) {
      status.lastFetchAt = new Date().toISOString();
      status.lastFetchOk = false;
      status.lastFetchError = err.message;
      throw err;
    }
  }

  // Écrit le fichier sur GitHub (crée ou met à jour). Un seul retry en cas
  // de conflit de sha (ex: sha en cache périmé après un redémarrage).
  async function pushRemote(contentString, isRetry = false) {
    if (!enabled) return;

    try {
      const payload = {
        message: 'Mise à jour automatique',
        content: Buffer.from(contentString, 'utf8').toString('base64'),
        branch: BRANCH,
      };
      if (cachedSha) {
        payload.sha = cachedSha;
      }

      const { status: httpStatus, body } = await apiRequest('PUT', payload);

      if (httpStatus === 200 || httpStatus === 201) {
        cachedSha = body && body.content ? body.content.sha : cachedSha;
        status.lastPushAt = new Date().toISOString();
        status.lastPushOk = true;
        status.lastPushError = null;
        return;
      }

      if (httpStatus === 409 && !isRetry) {
        // Conflit de sha : on relit la version distante et on retente une fois.
        cachedSha = null;
        const remote = await fetchRemote();
        cachedSha = remote ? remote.sha : null;
        return pushRemote(contentString, true);
      }

      throw new Error(`Écriture GitHub échouée (statut ${httpStatus}) : ${body && body.message}`);
    } catch (err) {
      status.lastPushAt = new Date().toISOString();
      status.lastPushOk = false;
      status.lastPushError = err.message;
      throw err;
    }
  }

  function getStatus() {
    return {
      enabled,
      repo: REPO || null,
      branch: BRANCH,
      filePath,
      ...status,
    };
  }

  return {
    enabled,
    fetchRemote,
    pushRemote,
    getStatus,
  };
}

// Liste les fichiers d'un DOSSIER du repo (pas un fichier précis) — utilisé
// par queues/campaignEngine.js pour retrouver, au démarrage du process après
// un redéploiement (disque local vidé), quels tenants avaient une campagne
// en cours sans avoir à connaître leurs clés à l'avance. Retourne un tableau
// de noms de fichiers (pas de chemins complets), vide si le dossier n'existe
// pas encore ou si la persistance est désactivée.
async function listDirectory(dirPath) {
  if (!enabled) return [];

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: `/repos/${REPO}/contents/${dirPath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(BRANCH)}`,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'BusinessAutomationEngine',
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          // 404 = dossier pas encore créé (aucun fichier poussé pour l'instant) —
          // pas une erreur, juste "rien à lister".
          if (res.statusCode !== 200) return resolve([]);
          let body;
          try {
            body = JSON.parse(raw);
          } catch (err) {
            return resolve([]);
          }
          if (!Array.isArray(body)) return resolve([]);
          resolve(body.filter((item) => item.type === 'file').map((item) => item.name));
        });
      },
    );
    // Erreur réseau : traitée comme "rien à lister" plutôt que de faire
    // planter l'appelant — le pire cas est de ne pas reprendre une campagne
    // distante, pas un crash au démarrage du serveur.
    req.on('error', () => resolve([]));
    req.end();
  });
}

// ---------- Stockage de gros fichiers (Git Data API) ----------
// createStore()/pushRemote() ci-dessus passent par l'API "Contents" de
// GitHub, limitée à 1 Mo de contenu inline en LECTURE COMME EN ÉCRITURE
// (déjà observé en production, voir fetchRemote) — inutilisable pour des
// pièces jointes de campagne (images, vidéos compressées à ~15 Mo, voir
// adapters/videoCompressor.js). L'API Git Data (blobs/trees/commits), plus
// bas niveau, n'a pas cette limite (jusqu'à ~100 Mo par fichier, largement
// suffisant ici) : on y accède directement pour les médias plutôt que
// d'exiger un disque persistant payant sur Render.
function gitApiRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: `/repos/${REPO}${apiPath}`,
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'BusinessAutomationEngine',
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch (err) {
            parsed = null;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Un blob créé via l'API Git Data est immédiatement lisible par son sha,
// mais reste un objet "flottant" (non rattaché à l'historique) tant qu'il
// n'est référencé par aucun commit — GitHub peut le garbage-collecter s'il
// reste ainsi trop longtemps. commitBlobToPath() ci-dessous le rattache tout
// de suite à un vrai commit sur BRANCH pour qu'il persiste durablement,
// exactement comme un fichier normal du repo.
async function createBlob(buffer) {
  const { status, body } = await gitApiRequest('POST', '/git/blobs', {
    content: buffer.toString('base64'),
    encoding: 'base64',
  });
  if (status !== 201 || !body || !body.sha) {
    throw new Error(`Échec de la création du blob GitHub (statut ${status})`);
  }
  return body.sha;
}

async function fetchBlobBySha(sha) {
  const { status, body } = await gitApiRequest('GET', `/git/blobs/${sha}`, null);
  if (status !== 200 || !body || !body.content) {
    throw new Error(`Échec de la lecture du blob GitHub (statut ${status})`);
  }
  return Buffer.from(body.content, 'base64');
}

// Ajoute un blob déjà créé à l'arborescence du repo, au chemin donné, via un
// nouveau commit sur BRANCH. Un seul nouvel essai si la branche a avancé
// entre-temps (ex: un autre tenant pousse sa propre pièce jointe en
// parallèle) — reprend alors depuis le nouvel état de la branche.
async function commitBlobToPath(filePath, blobSha, commitMessage, isRetry = false) {
  const refRes = await gitApiRequest('GET', `/git/ref/heads/${encodeURIComponent(BRANCH)}`, null);
  if (refRes.status !== 200 || !refRes.body) {
    throw new Error(`Impossible de lire la référence de branche GitHub (statut ${refRes.status})`);
  }
  const parentCommitSha = refRes.body.object.sha;

  const commitRes = await gitApiRequest('GET', `/git/commits/${parentCommitSha}`, null);
  if (commitRes.status !== 200 || !commitRes.body) {
    throw new Error(`Impossible de lire le commit GitHub ${parentCommitSha} (statut ${commitRes.status})`);
  }
  const baseTreeSha = commitRes.body.tree.sha;

  const treeRes = await gitApiRequest('POST', '/git/trees', {
    base_tree: baseTreeSha,
    tree: [{ path: filePath, mode: '100644', type: 'blob', sha: blobSha }],
  });
  if (treeRes.status !== 201 || !treeRes.body) {
    throw new Error(`Échec de la création de l'arborescence GitHub (statut ${treeRes.status})`);
  }

  const newCommitRes = await gitApiRequest('POST', '/git/commits', {
    message: commitMessage,
    tree: treeRes.body.sha,
    parents: [parentCommitSha],
  });
  if (newCommitRes.status !== 201 || !newCommitRes.body) {
    throw new Error(`Échec de la création du commit GitHub (statut ${newCommitRes.status})`);
  }

  const updateRefRes = await gitApiRequest('PATCH', `/git/refs/heads/${encodeURIComponent(BRANCH)}`, {
    sha: newCommitRes.body.sha,
  });

  if (updateRefRes.status === 200) return;

  if (!isRetry) {
    return commitBlobToPath(filePath, blobSha, commitMessage, true);
  }

  throw new Error(`Échec de la mise à jour de la branche GitHub (statut ${updateRefRes.status})`);
}

// Sauvegarde durablement un gros fichier (pièce jointe de campagne) sur
// GitHub : retourne le sha du blob à conserver (voir
// queues/campaignEngine.js) pour pouvoir le relire plus tard via
// fetchLargeFile(), y compris depuis un conteneur qui n'a jamais vu ce
// fichier localement (redéploiement Render sans disque persistant).
async function pushLargeFile(filePath, buffer) {
  if (!enabled) return null;
  const sha = await createBlob(buffer);
  await commitBlobToPath(filePath, sha, `Ajout média de campagne : ${filePath}`);
  return sha;
}

async function fetchLargeFile(sha) {
  if (!enabled || !sha) return null;
  return fetchBlobBySha(sha);
}

// Instance par défaut : conserve le comportement historique de ce module
// (un seul fichier, "licenses.json" sauf GITHUB_DATA_PATH personnalisé) pour
// ne rien casser chez les appelants existants qui font
// require('./githubStore').fetchRemote() etc. directement.
const defaultStore = createStore(process.env.GITHUB_DATA_PATH || 'licenses.json');

module.exports = {
  ...defaultStore,
  createStore,
  listDirectory,
  pushLargeFile,
  fetchLargeFile,
};
