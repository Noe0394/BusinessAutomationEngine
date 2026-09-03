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

function apiRequest(method, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: `/repos/${REPO}/contents/${encodeURIComponent(FILE_PATH)}`,
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

  const { status, body } = await apiRequest('GET', null);

  if (status === 404) {
    return null;
  }
  if (status !== 200 || !body || !body.content) {
    throw new Error(`Lecture GitHub échouée (statut ${status})`);
  }

  cachedSha = body.sha;
  const content = Buffer.from(body.content, 'base64').toString('utf8');
  return { content, sha: body.sha };
}

// Écrit licenses.json sur GitHub (crée ou met à jour). Un seul retry en cas
// de conflit de sha (ex: sha en cache périmé après un redémarrage).
async function pushRemote(contentString, isRetry = false) {
  if (!enabled) return;

  const payload = {
    message: 'Mise à jour automatique des licences',
    content: Buffer.from(contentString, 'utf8').toString('base64'),
    branch: BRANCH,
  };
  if (cachedSha) {
    payload.sha = cachedSha;
  }

  const { status, body } = await apiRequest('PUT', payload);

  if (status === 200 || status === 201) {
    cachedSha = body && body.content ? body.content.sha : cachedSha;
    return;
  }

  if (status === 409 && !isRetry) {
    // Conflit de sha : on relit la version distante et on retente une fois.
    cachedSha = null;
    const remote = await fetchRemote();
    cachedSha = remote ? remote.sha : null;
    return pushRemote(contentString, true);
  }

  throw new Error(`Écriture GitHub échouée (statut ${status}) : ${body && body.message}`);
}

module.exports = {
  enabled,
  fetchRemote,
  pushRemote,
};
