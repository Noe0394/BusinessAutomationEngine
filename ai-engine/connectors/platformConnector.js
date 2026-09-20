// CONNECTEUR PASSERELLE PLATEFORME — ai-engine/connectors/platformConnector.js
// ---------------------------------------------------------------------------
// Connecteur GÉNÉRIQUE d'administration d'une plateforme tierce que POSSÈDE le
// vendeur, via une passerelle API sécurisée par clé (`X-API-Key`). Il n'est PAS
// spécifique à une plateforme donnée : la plateforme de formation du vendeur
// (RIEA AFRIQUE et son endpoint /api/v1/agent-gateway/*) n'est qu'une
// CONFIGURATION par défaut de ce connecteur. N'importe quelle plateforme
// exposant une passerelle du même genre (créer/suspendre un accès derrière une
// clé API) se branche en changeant `baseUrl` / `endpoints` / `apiKeyEnv` dans
// active_connectors.json, sans toucher au code.
//
// RÈGLE DE SÉCURITÉ ABSOLUE (voir connectorManager.js) : ce connecteur ne
// déclare et n'exécute JAMAIS d'action de suppression définitive. Créer et
// suspendre (réversible) uniquement — jamais `delete`. La clé API vit
// exclusivement dans l'environnement (.env, jamais dans la config committée ni
// dans une conversation client), et n'est lue que par `ctx.getSecret(nom)`.

const DEFAULT_ENDPOINTS = {
  enroll: '/api/v1/agent-gateway/enroll-student',
  suspend: '/api/v1/agent-gateway/suspend-student',
};

// Chaque outil déclare la `permission` (scope) qu'il requiert. Le
// connectorManager n'expose au LLM que les outils dont le scope figure dans
// `config.scopes` (les permissions réellement accordées à la clé du vendeur) —
// c'est ce qui fait varier les capacités de l'agent d'un utilisateur à l'autre.
const TOOLS = [
  {
    name: 'creer_compte_eleve',
    description:
      "Crée (ou réactive) l'accès d'un client à une formation/produit sur la plateforme du vendeur, après confirmation de l'administrateur. Paramètres : email du client, identifiant de la formation.",
    parameters: {
      email: { type: 'string', required: true, description: 'Email du client à inscrire.' },
      course_id: { type: 'string', required: true, description: 'Identifiant du cours/produit à débloquer.' },
      validity_months: { type: 'number', required: false, description: "Durée de validité en mois (défaut : côté plateforme)." },
    },
    permission: 'students:create',
  },
  {
    name: 'suspendre_compte_eleve',
    description:
      "Suspend (désactive, réversible) l'accès d'un client — en cas d'impayé ou sur demande de l'administrateur. Paramètre : email du client.",
    parameters: {
      email: { type: 'string', required: true, description: "Email du client dont l'accès est suspendu." },
    },
    permission: 'students:suspend',
  },
];

function trimSlashes(base) {
  return String(base || '').replace(/\/+$/, '');
}

async function callGateway(ctx, endpointPath, body) {
  const cfg = ctx.config || {};
  const base = trimSlashes(cfg.baseUrl);
  if (!base) return { ok: false, error: 'PLATFORM_BASEURL_MISSING' };

  const apiKey = ctx.apiKey || ctx.getSecret(cfg.apiKeyEnv || 'CYRUS_PLATFORM_API_KEY');
  if (!apiKey) return { ok: false, error: 'PLATFORM_API_KEY_MISSING' };

  const authHeader = cfg.authHeader || 'X-API-Key';
  const http = ctx.http;
  if (!http) return { ok: false, error: 'NO_HTTP_TRANSPORT' };

  let res;
  try {
    res = await http(base + endpointPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [authHeader]: apiKey },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: 'TRANSPORT_ERROR', detail: String((err && err.message) || err) };
  }

  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) {
    return { ok: false, status: res.status, error: (data && data.error) || ('HTTP ' + res.status), data };
  }
  return { ok: true, status: res.status, data: data || {} };
}

async function execute(toolName, args, ctx) {
  const cfg = ctx.config || {};
  const endpoints = Object.assign({}, DEFAULT_ENDPOINTS, cfg.endpoints || {});
  const a = args || {};

  if (toolName === 'creer_compte_eleve') {
    if (!a.email || !a.course_id) return { ok: false, error: 'MISSING_EMAIL_OR_COURSE' };
    const body = { email: String(a.email).trim().toLowerCase(), course_id: String(a.course_id).trim() };
    if (a.validity_months) body.validity_months = a.validity_months;
    const res = await callGateway(ctx, endpoints.enroll, body);
    if (!res.ok) return res;
    // La réponse peut porter un lien de définition de mot de passe pour un
    // nouveau compte — jamais un mot de passe en clair (voir agentGateway.js
    // côté plateforme). On le transmet tel quel à l'appelant, qui décidera de
    // l'inclure dans le message d'accès envoyé au client.
    return {
      ok: true,
      result: {
        email: body.email,
        courseId: body.course_id,
        accountCreated: res.data.account_created,
        // VERIFY : confirmation explicite de la passerelle (réponse 2xx portant `ok:true`/`uid` ou `account_created`).
        // Une réponse 2xx vide n'est PAS une confirmation (EXECUTE ≠ SUCCESS) — voir manualPaymentValidator.verifyEnrollment.
        confirmed: (res.data.ok === true && !!res.data.uid) || typeof res.data.account_created === 'boolean',
        userId: res.data.uid || null,
        courseIdConfirmed: res.data.course_id || null,
        passwordResetLink: res.data.password_reset_link || null,
        expiresAt: res.data.expires_at || null,
        provider: 'platform-gateway',
      },
    };
  }

  if (toolName === 'suspendre_compte_eleve') {
    if (!a.email) return { ok: false, error: 'MISSING_EMAIL' };
    const res = await callGateway(ctx, endpoints.suspend, { email: String(a.email).trim().toLowerCase() });
    if (!res.ok) return res;
    return { ok: true, result: { email: String(a.email).trim().toLowerCase(), suspended: true, provider: 'platform-gateway' } };
  }

  return { ok: false, error: 'UNKNOWN_TOOL:' + toolName };
}

module.exports = {
  type: 'platform_gateway',
  label: 'Plateforme (passerelle API)',
  tools: TOOLS,
  execute,
  DEFAULT_ENDPOINTS,
};
