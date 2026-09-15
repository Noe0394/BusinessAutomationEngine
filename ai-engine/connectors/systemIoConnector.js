// CONNECTEUR SYSTEME.IO — ai-engine/connectors/systemIoConnector.js
// ---------------------------------------------------------------------------
// Permet à l'agent d'ajouter un contact et de lui attribuer un tag sur le
// compte System.io du vendeur (cas d'usage : un e-commerçant / formateur qui
// gère ses tunnels de vente sur System.io). API publique officielle :
//   Base   : https://api.systeme.io/api
//   Auth   : en-tête X-API-Key
//   POST /contacts                    -> crée un contact ({ email, fields:[{slug,value}] })
//   GET  /contacts?email=...          -> recherche par email exact (items[])
//   GET  /tags                        -> liste des tags (items[]: {id,name})
//   POST /tags                        -> crée un tag ({ name })
//   POST /contacts/{id}/tags          -> attribue un tag ({ tagId }) -> 204
// (voir https://developer.systeme.io/). Clé jamais en dur : lue via
// ctx.getSecret(config.apiKeyEnv). Aucun outil de suppression (règle absolue).

const DEFAULT_BASE = 'https://api.systeme.io/api';

const TOOLS = [
  {
    name: 'ajouter_contact',
    description:
      "Ajoute (ou retrouve) un contact sur System.io à partir de son email, avec prénom facultatif. Idempotent : si le contact existe déjà, il est réutilisé.",
    parameters: {
      email: { type: 'string', required: true, description: 'Email du contact.' },
      firstName: { type: 'string', required: false, description: 'Prénom du contact (facultatif).' },
    },
    permission: 'contacts:write',
  },
  {
    name: 'attribuer_tag',
    description:
      "Attribue un tag (segment) à un contact System.io identifié par email. Le contact et le tag sont créés automatiquement s'ils n'existent pas encore.",
    parameters: {
      email: { type: 'string', required: true, description: 'Email du contact à taguer.' },
      tag: { type: 'string', required: true, description: 'Nom du tag à attribuer.' },
    },
    permission: 'tags:write',
  },
];

function trimSlashes(base) {
  return String(base || '').replace(/\/+$/, '');
}

function ctxParts(ctx) {
  const cfg = ctx.config || {};
  const base = trimSlashes(cfg.baseUrl) || DEFAULT_BASE;
  const apiKey = ctx.apiKey || ctx.getSecret(cfg.apiKeyEnv || 'SYSTEME_IO_API_KEY');
  const firstNameSlug = cfg.firstNameSlug || 'first_name';
  return { base, apiKey, firstNameSlug, http: ctx.http };
}

async function apiCall(parts, method, path, body) {
  if (!parts.apiKey) return { ok: false, error: 'SYSTEME_IO_API_KEY_MISSING' };
  if (!parts.http) return { ok: false, error: 'NO_HTTP_TRANSPORT' };
  let res;
  try {
    const init = { method, headers: { 'X-API-Key': parts.apiKey } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    res = await parts.http(parts.base + path, init);
  } catch (err) {
    return { ok: false, error: 'TRANSPORT_ERROR', detail: String((err && err.message) || err) };
  }
  // 204 (No Content, ex: attribution de tag) : succès sans corps.
  if (res.status === 204) return { ok: true, status: 204, data: null };
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) return { ok: false, status: res.status, error: (data && (data.message || data.error)) || ('HTTP ' + res.status), data };
  return { ok: true, status: res.status, data };
}

async function findOrCreateContact(parts, email, firstName) {
  const clean = String(email).trim().toLowerCase();
  const found = await apiCall(parts, 'GET', `/contacts?email=${encodeURIComponent(clean)}`);
  if (found.ok && found.data && Array.isArray(found.data.items) && found.data.items.length) {
    return { ok: true, id: found.data.items[0].id, created: false };
  }
  const body = { email: clean };
  if (firstName) body.fields = [{ slug: parts.firstNameSlug, value: String(firstName) }];
  const created = await apiCall(parts, 'POST', '/contacts', body);
  if (!created.ok) return created;
  return { ok: true, id: created.data && created.data.id, created: true };
}

async function findOrCreateTag(parts, tagName) {
  const name = String(tagName).trim();
  const list = await apiCall(parts, 'GET', '/tags');
  if (list.ok && list.data && Array.isArray(list.data.items)) {
    const match = list.data.items.find((t) => (t.name || '').toLowerCase() === name.toLowerCase());
    if (match) return { ok: true, id: match.id, created: false };
  }
  const created = await apiCall(parts, 'POST', '/tags', { name });
  if (!created.ok) return created;
  return { ok: true, id: created.data && created.data.id, created: true };
}

async function execute(toolName, args, ctx) {
  const parts = ctxParts(ctx);
  const a = args || {};

  if (toolName === 'ajouter_contact') {
    if (!a.email) return { ok: false, error: 'MISSING_EMAIL' };
    const contact = await findOrCreateContact(parts, a.email, a.firstName);
    if (!contact.ok) return contact;
    return { ok: true, result: { contactId: contact.id, email: String(a.email).trim().toLowerCase(), created: contact.created, provider: 'systeme.io' } };
  }

  if (toolName === 'attribuer_tag') {
    if (!a.email || !a.tag) return { ok: false, error: 'MISSING_EMAIL_OR_TAG' };
    const contact = await findOrCreateContact(parts, a.email, a.firstName);
    if (!contact.ok) return contact;
    const tag = await findOrCreateTag(parts, a.tag);
    if (!tag.ok) return tag;
    const assigned = await apiCall(parts, 'POST', `/contacts/${contact.id}/tags`, { tagId: tag.id });
    if (!assigned.ok) return assigned;
    return { ok: true, result: { contactId: contact.id, tagId: tag.id, tag: String(a.tag).trim(), provider: 'systeme.io' } };
  }

  return { ok: false, error: 'UNKNOWN_TOOL:' + toolName };
}

module.exports = { type: 'systemio', label: 'System.io', tools: TOOLS, execute, DEFAULT_BASE };
