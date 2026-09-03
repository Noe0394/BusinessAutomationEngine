const https = require('https');

// Persistance optionnelle de licenses.json dans un repo GitHub privé dédié
// (séparé du repo de déploiement, pour ne jamais déclencher de redéploiement
// Render). Activé uniquement si GITHUB_TOKEN et GITHUB_DATA_REPO sont
// définis ; sinon le fichier reste local uniquement (comportement historique,
// perdu à chaque redéploiement Render sans disque persistant).
const TOKEN = process.env.GITHUB_TOKEN || '';
const REPO = process.env.GITHUB_DATA_REPO || ''; // format "owner/repo"
const FILE_PATH = process.env.GITHUB_DATA_PATH || 'licenses.json';
const BRANCH = process.env.GITHUB_DATA_BRANCH || 'main';

const enabled = Boolean(TOKEN && REPO);

let cachedSha = null;

// État exposé au panneau admin (voir getStatus) pour qu'un admin puisse
// vérifier depuis le dashboard que la persistance fonctionne réellement,
// plutôt que de le découvrir seulement après un redéploiement qui a perdu
// des clés.
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
        path: `/repos/${REPO}/contents/${encodeURIComponent(FILE_PATH)}${qs}`,
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

// Récupère licenses.json depuis GitHub. Retourne null si le fichier n'existe
// pas encore là-bas (première utilisation) ou si le store est désactivé.
async function fetchRemote() {
  if (!enabled) return null;

  try {
    // ref=BRANCH : sans ce paramètre, GitHub lit toujours la branche par
    // défaut du repo, qui peut différer de GITHUB_DATA_BRANCH si celle-ci a
    // été personnalisée — on lirait alors une version périmée des licences.
    const { status: httpStatus, body } = await apiRequest('GET', null, `ref=${encodeURIComponent(BRANCH)}`);

    if (httpStatus === 404) {
      status.lastFetchAt = new Date().toISOString();
      status.lastFetchOk = true;
      status.lastFetchError = null;
      return null;
    }
    if (httpStatus !== 200 || !body || !body.content) {
      throw new Error(`Lecture GitHub échouée (statut ${httpStatus})`);
    }

    cachedSha = body.sha;
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

// Écrit licenses.json sur GitHub (crée ou met à jour). Un seul retry en cas
// de conflit de sha (ex: sha en cache périmé après un redémarrage).
async function pushRemote(contentString, isRetry = false) {
  if (!enabled) return;

  try {
    const payload = {
      message: 'Mise à jour automatique des licences',
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
    ...status,
  };
}

module.exports = {
  enabled,
  fetchRemote,
  pushRemote,
  getStatus,
};
