const API_VERSION = (env) => {
  const value = String(env.FACEBOOK_GRAPH_API_VERSION || 'v26.0');
  return value.startsWith('v') ? value : `v${value}`;
};
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-license-key, x-device-id',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS } });
const isoNow = () => new Date().toISOString();
const b64 = (bytes) => {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
};
const unb64 = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

function randomState() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function licenseGate(request, env) {
  const key = String(request.headers.get('x-license-key') || '').trim().toUpperCase();
  const deviceId = String(request.headers.get('x-device-id') || '').trim();
  if (!key || !deviceId) return { response: json({ error: 'Licence et identifiant appareil requis.' }, 401) };
  const row = await env.DB.prepare('SELECT active, expires_at, allowed_modules, bound_device_id FROM licenses WHERE key = ?').bind(key).first();
  if (!row || !row.active || (row.expires_at && new Date(row.expires_at).getTime() < Date.now())) return { response: json({ error: 'Licence invalide ou expiree.' }, 401) };
  if (!row.bound_device_id || row.bound_device_id !== deviceId) return { response: json({ error: 'La licence doit etre liee a cet appareil avant la connexion Facebook.' }, 403) };
  let modules = [];
  try { modules = JSON.parse(row.allowed_modules || '[]'); } catch {}
  if (!modules.includes('facebook')) return { response: json({ error: 'Le module Facebook n’est pas autorise pour cette licence.' }, 403) };
  return { key, deviceId };
}

async function tokenKey(env) {
  const raw = String(env.FACEBOOK_TOKEN_ENCRYPTION_KEY || '');
  if (!raw) throw new Error('FACEBOOK_TOKEN_ENCRYPTION_KEY manquant dans les secrets Worker.');
  let bytes;
  try { bytes = unb64(raw); } catch { throw new Error('FACEBOOK_TOKEN_ENCRYPTION_KEY doit etre une cle AES-256 en base64.'); }
  if (bytes.length !== 32) throw new Error('FACEBOOK_TOKEN_ENCRYPTION_KEY doit decoder exactement 32 octets.');
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptToken(value, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await tokenKey(env);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value));
  return b64(iv) + '.' + b64(new Uint8Array(ciphertext));
}

async function decryptToken(value, env) {
  if (!value) return null;
  const [ivText, ciphertextText] = String(value).split('.');
  if (!ivText || !ciphertextText) throw new Error('Jeton Facebook chiffre illisible.');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivText) }, await tokenKey(env), unb64(ciphertextText));
  return new TextDecoder().decode(plaintext);
}

function requiredConfig(env) {
  const appId = String(env.FACEBOOK_APP_ID || '').trim();
  const appSecret = String(env.FACEBOOK_APP_SECRET || '').trim();
  const redirectUri = String(env.FACEBOOK_REDIRECT_URI || '').trim();
  if (!appId || !appSecret || !redirectUri.startsWith('https://')) throw new Error('Configure FACEBOOK_APP_ID, FACEBOOK_APP_SECRET et FACEBOOK_REDIRECT_URI (HTTPS).');
  return { appId, appSecret, redirectUri };
}

async function graph(env, path, { method = 'GET', params = {}, token, body } = {}) {
  const url = new URL(`https://graph.facebook.com/${API_VERSION(env)}/${String(path).replace(/^\//, '')}`);
  if (token) params.access_token = token;
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    method,
    headers: body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : undefined,
    body: body && !(body instanceof FormData) ? JSON.stringify(body) : body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    const error = data.error?.message || `Meta a repondu HTTP ${response.status}.`;
    throw Object.assign(new Error(error), { status: response.status >= 400 && response.status < 600 ? response.status : 502 });
  }
  return data;
}

async function accountFor(key, env, deviceId) {
  const account = await env.DB.prepare('SELECT * FROM facebook_accounts WHERE license_key = ?').bind(key).first();
  return deviceId && account?.device_id !== deviceId ? null : account;
}

async function pageTokenFor(auth, env) {
  const account = await accountFor(auth.key, env, auth.deviceId);
  if (!account?.page_token_cipher || !account.page_id) throw Object.assign(new Error('Connecte une Page Facebook avant cette operation.'), { status: 409 });
  return { account, token: await decryptToken(account.page_token_cipher, env) };
}

async function oauthStart(request, env, auth) {
  const config = requiredConfig(env);
  const state = randomState();
  const expiresAt = Date.now() + 10 * 60 * 1000;
  await env.DB.prepare('DELETE FROM facebook_oauth_states WHERE expires_at < ?').bind(Date.now()).run();
  await env.DB.prepare('INSERT INTO facebook_oauth_states (state, license_key, device_id, expires_at) VALUES (?, ?, ?, ?)')
    .bind(state, auth.key, auth.deviceId, expiresAt).run();
  const url = new URL(`https://www.facebook.com/${API_VERSION(env)}/dialog/oauth`);
  url.search = new URLSearchParams({
    client_id: config.appId,
    redirect_uri: config.redirectUri,
    state,
    response_type: 'code',
    auth_type: 'rerequest',
    scope: 'public_profile,email,pages_show_list,pages_manage_posts,pages_read_engagement,pages_read_user_content,pages_messaging,pages_manage_engagement',
  }).toString();
  return json({ authUrl: url.toString(), expiresAt });
}

function oauthResultPage(message, success) {
  const safe = String(message).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>CYRUS - Facebook</title><main style="font:16px system-ui;max-width:34rem;margin:15vh auto;padding:1.5rem"><h1>${success ? 'Facebook relie' : 'Connexion Facebook non terminee'}</h1><p>${safe}</p><p>Retourne dans CYRUS et actualise le statut pour choisir la Page.</p></main>`, { status: success ? 200 : 400, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

async function oauthCallback(request, env) {
  let config;
  try { config = requiredConfig(env); } catch (error) { return oauthResultPage(error.message, false); }
  const url = new URL(request.url);
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  const stateRow = state ? await env.DB.prepare('SELECT * FROM facebook_oauth_states WHERE state = ?').bind(state).first() : null;
  if (state) await env.DB.prepare('DELETE FROM facebook_oauth_states WHERE state = ?').bind(state).run();
  if (!stateRow || stateRow.expires_at < Date.now() || !code || url.searchParams.has('error')) return oauthResultPage('Etat OAuth absent, expire ou annule.', false);
  try {
    const license = await env.DB.prepare('SELECT active, expires_at, allowed_modules, bound_device_id FROM licenses WHERE key = ?').bind(stateRow.license_key).first();
    let modules = [];
    try { modules = JSON.parse(license?.allowed_modules || '[]'); } catch {}
    if (!license || !license.active || (license.expires_at && new Date(license.expires_at).getTime() < Date.now())
        || license.bound_device_id !== stateRow.device_id || !modules.includes('facebook')) {
      return oauthResultPage('Licence non validee ou module Facebook non autorise.', false);
    }
    const short = await graph(env, 'oauth/access_token', { params: { client_id: config.appId, client_secret: config.appSecret, redirect_uri: config.redirectUri, code } });
    const extended = await graph(env, 'oauth/access_token', { params: { grant_type: 'fb_exchange_token', client_id: config.appId, client_secret: config.appSecret, fb_exchange_token: short.access_token } });
    if (!extended.access_token) throw new Error('Meta n’a pas renvoye de jeton utilisateur.');
    const encrypted = await encryptToken(extended.access_token, env);
    const callbackAuth = { key: stateRow.license_key, deviceId: stateRow.device_id };
    await acquireCaptureLock(callbackAuth, env);
    try {
      await cancelPendingProspectReplies(callbackAuth, env);
      await env.DB.batch([
        env.DB.prepare('UPDATE facebook_capture_state SET page_id = NULL, last_scan_at = NULL, scan_started_at = NULL, pending_posts = NULL, post_offset = 0, updated_at = ? WHERE license_key = ? AND device_id = ?').bind(Math.floor(Date.now() / 1000), callbackAuth.key, callbackAuth.deviceId),
        env.DB.prepare('DELETE FROM facebook_capture_cursors WHERE license_key = ? AND device_id = ?').bind(callbackAuth.key, callbackAuth.deviceId),
        env.DB.prepare(`INSERT INTO facebook_accounts (license_key, device_id, user_token_cipher, page_token_cipher, page_id, page_name, connected_at, updated_at)
          VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?) ON CONFLICT(license_key) DO UPDATE SET device_id = excluded.device_id,
          user_token_cipher = excluded.user_token_cipher, page_token_cipher = NULL, page_id = NULL, page_name = NULL,
          connected_at = excluded.connected_at, updated_at = excluded.updated_at`)
          .bind(callbackAuth.key, callbackAuth.deviceId, encrypted, isoNow(), isoNow()),
      ]);
      return oauthResultPage('Autorisation recue. Reviens dans CYRUS pour choisir la Page a connecter.', true);
    } finally {
      await releaseCaptureLock(callbackAuth, env);
    }
  } catch (error) {
    return oauthResultPage(error.message || 'Echange OAuth refuse par Meta.', false);
  }
}

async function listPages(auth, env) {
  const account = await accountFor(auth.key, env, auth.deviceId);
  if (!account?.user_token_cipher) return json({ error: 'Autorise d’abord Facebook.' }, 409);
  const userToken = await decryptToken(account.user_token_cipher, env);
  const result = await graph(env, 'me/accounts', { token: userToken, params: { fields: 'id,name,tasks' } });
  return json({ pages: (result.data || []).map((page) => ({ id: String(page.id), name: String(page.name || ''), tasks: page.tasks || [] })) });
}

async function cancelPendingProspectReplies(auth, env) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare("UPDATE facebook_seen_comments SET status = 'captured', reply_message = NULL, updated_at = ? WHERE license_key = ? AND device_id = ? AND status = 'reply_pending'").bind(now, auth.key, auth.deviceId),
    env.DB.prepare("UPDATE facebook_leads SET reply_status = 'not_sent', updated_at = ? WHERE license_key = ? AND device_id = ? AND reply_status = 'pending'").bind(now, auth.key, auth.deviceId),
  ]);
}

async function acquireCaptureLock(auth, env) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('INSERT OR IGNORE INTO facebook_capture_state (license_key, device_id, updated_at) VALUES (?, ?, ?)').bind(auth.key, auth.deviceId, now).run();
  const result = await env.DB.prepare(`UPDATE facebook_capture_state SET lock_until = ?, updated_at = ?
    WHERE license_key = ? AND device_id = ? AND (lock_until IS NULL OR lock_until < ?)`)
    .bind(now + 120, now, auth.key, auth.deviceId, now).run();
  if (Number(result.meta?.changes || 0) !== 1) throw Object.assign(new Error('Une synchronisation Facebook est deja en cours; reessaie apres sa fin.'), { status: 409 });
}

async function releaseCaptureLock(auth, env) {
  await env.DB.prepare('UPDATE facebook_capture_state SET lock_until = NULL, updated_at = ? WHERE license_key = ? AND device_id = ?')
    .bind(Math.floor(Date.now() / 1000), auth.key, auth.deviceId).run();
}

async function bindCaptureStateToPage(auth, pageId, env) {
  const current = await env.DB.prepare('SELECT page_id FROM facebook_capture_state WHERE license_key = ? AND device_id = ?').bind(auth.key, auth.deviceId).first();
  if (String(current?.page_id || '') !== String(pageId)) {
    await cancelPendingProspectReplies(auth, env);
    await env.DB.prepare('DELETE FROM facebook_capture_cursors WHERE license_key = ? AND device_id = ?').bind(auth.key, auth.deviceId).run();
  }
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO facebook_capture_state (license_key, device_id, page_id, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(license_key, device_id) DO UPDATE SET page_id = excluded.page_id,
    last_scan_at = CASE WHEN facebook_capture_state.page_id IS NOT excluded.page_id THEN NULL ELSE facebook_capture_state.last_scan_at END,
    scan_started_at = CASE WHEN facebook_capture_state.page_id IS NOT excluded.page_id THEN NULL ELSE facebook_capture_state.scan_started_at END,
    pending_posts = CASE WHEN facebook_capture_state.page_id IS NOT excluded.page_id THEN NULL ELSE facebook_capture_state.pending_posts END,
    post_offset = CASE WHEN facebook_capture_state.page_id IS NOT excluded.page_id THEN 0 ELSE facebook_capture_state.post_offset END,
    updated_at = excluded.updated_at`)
    .bind(auth.key, auth.deviceId, String(pageId), now).run();
}

async function connectPage(request, auth, env) {
  const pageId = String((await request.json().catch(() => ({}))).pageId || '').trim();
  if (!/^\d{1,40}$/.test(pageId)) return json({ error: 'Identifiant de Page invalide.' }, 400);
  const account = await accountFor(auth.key, env, auth.deviceId);
  if (!account?.user_token_cipher) return json({ error: 'Autorise d’abord Facebook.' }, 409);
  const userToken = await decryptToken(account.user_token_cipher, env);
  const result = await graph(env, 'me/accounts', { token: userToken, params: { fields: 'id,name,tasks,access_token', limit: 100 } });
  const page = (result.data || []).find((item) => String(item.id) === pageId);
  if (!page?.access_token) return json({ error: 'Cette Page ne figure pas dans les Pages autorisees pour ce compte.' }, 403);
  await acquireCaptureLock(auth, env);
  try {
    await bindCaptureStateToPage(auth, pageId, env);
    const encrypted = await encryptToken(page.access_token, env);
    await env.DB.prepare(`UPDATE facebook_accounts SET page_token_cipher = ?, page_id = ?, page_name = ?, user_token_cipher = NULL, updated_at = ?
      WHERE license_key = ? AND device_id = ?`).bind(encrypted, pageId, String(page.name || ''), isoNow(), auth.key, auth.deviceId).run();
    return json({ connected: true, pageId, pageName: String(page.name || '') });
  } finally {
    await releaseCaptureLock(auth, env);
  }
}

async function status(auth, env) {
  const account = await accountFor(auth.key, env, auth.deviceId);
  if (!account) return json({ connected: false, connectAvailable: !!(env.FACEBOOK_APP_ID && env.FACEBOOK_APP_SECRET && env.FACEBOOK_REDIRECT_URI) });
  if (!account.page_token_cipher || !account.page_id) return json({ connected: false, needsPageSelection: !!account.user_token_cipher, connectAvailable: !!(env.FACEBOOK_APP_ID && env.FACEBOOK_APP_SECRET && env.FACEBOOK_REDIRECT_URI) });
  try {
    const token = await decryptToken(account.page_token_cipher, env);
    const page = await graph(env, account.page_id, { token, params: { fields: 'id,name' } });
    return json({ connected: true, pageId: String(page.id), pageName: String(page.name || account.page_name || '') });
  } catch (error) {
    return json({ connected: false, error: error.message, pageName: account.page_name || '' }, error.status || 502);
  }
}

async function decodeMedia(media) {
  if (!media || typeof media.base64 !== 'string' || !media.base64) return null;
  if (media.base64.length > 14 * 1024 * 1024) throw Object.assign(new Error('Le media depasse 10 Mo.'), { status: 413 });
  const bytes = unb64(media.base64);
  if (bytes.length > 10 * 1024 * 1024) throw Object.assign(new Error('Le media depasse 10 Mo.'), { status: 413 });
  if (!/^(image\/|video\/)/i.test(String(media.type || ''))) throw Object.assign(new Error('Seules les images et videos sont prises en charge.'), { status: 400 });
  return { bytes, type: String(media.type), name: String(media.name || 'media').slice(0, 120) };
}

function normalizeKeyword(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr').trim();
}

async function handleProspects(body, auth, account, token, env) {
  if (body.action === 'list') {
    const [rules, leads] = await Promise.all([
      env.DB.prepare('SELECT id, keyword, reply_message AS replyMessage, auto_reply AS autoReply, created_at AS createdAt FROM facebook_keyword_rules WHERE license_key = ? AND device_id = ? AND page_id = ? ORDER BY created_at LIMIT 100').bind(auth.key, auth.deviceId, account.page_id).all(),
      env.DB.prepare('SELECT psid, name, source, last_text AS lastText, post_id AS postId, keyword, reply_status AS replyStatus, created_at AS createdAt, updated_at AS updatedAt FROM facebook_leads WHERE license_key = ? AND device_id = ? AND page_id = ? ORDER BY updated_at DESC LIMIT 1000').bind(auth.key, auth.deviceId, account.page_id).all(),
    ]);
    return json({ rules: (rules.results || []).map(row => ({ ...row, autoReply: !!row.autoReply })), leads: leads.results || [] });
  }
  if (body.action === 'add-rule') {
    const keyword = String(body.keyword || '').trim();
    const replyMessage = String(body.replyMessage || '').trim();
    const autoReply = body.autoReply === true;
    if (keyword.length < 2 || keyword.length > 100) return json({ error: 'Le mot-cle doit contenir de 2 a 100 caracteres.' }, 400);
    if (replyMessage.length > 2000 || (autoReply && !replyMessage)) return json({ error: 'Une reponse de 1 a 2000 caracteres est requise pour activer la reponse automatique.' }, 400);
    await acquireCaptureLock(auth, env);
    try {
      const existing = await env.DB.prepare('SELECT keyword FROM facebook_keyword_rules WHERE license_key = ? AND device_id = ? AND page_id = ?').bind(auth.key, auth.deviceId, account.page_id).all();
      if ((existing.results || []).length >= 100) return json({ error: 'La limite de 100 regles est atteinte.' }, 409);
      const normalized = normalizeKeyword(keyword);
      if ((existing.results || []).some(row => normalizeKeyword(row.keyword) === normalized)) return json({ error: 'Cette regle existe deja.' }, 409);
      const rule = { id: crypto.randomUUID(), keyword, replyMessage, autoReply, createdAt: Math.floor(Date.now() / 1000) };
      await env.DB.prepare('INSERT INTO facebook_keyword_rules (license_key, device_id, page_id, id, keyword, reply_message, auto_reply, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(auth.key, auth.deviceId, account.page_id, rule.id, keyword, replyMessage, autoReply ? 1 : 0, rule.createdAt).run();
      return json({ rule }, 201);
    } finally {
      await releaseCaptureLock(auth, env);
    }
  }
  if (body.action === 'delete-rule') {
    const id = String(body.id || '').trim();
    if (!id) return json({ error: 'Identifiant de regle requis.' }, 400);
    await acquireCaptureLock(auth, env);
    try {
      const changedAt = Math.floor(Date.now() / 1000);
      await env.DB.batch([
        env.DB.prepare("UPDATE facebook_seen_comments SET status = 'captured', reply_message = NULL, updated_at = ? WHERE license_key = ? AND device_id = ? AND page_id = ? AND rule_id = ? AND status = 'reply_pending'")
          .bind(changedAt, auth.key, auth.deviceId, account.page_id, id),
        env.DB.prepare(`UPDATE facebook_leads SET reply_status = 'not_sent', updated_at = ? WHERE license_key = ? AND device_id = ? AND reply_status = 'pending'
          AND page_id = ? AND NOT EXISTS (SELECT 1 FROM facebook_seen_comments AS c WHERE c.license_key = ? AND c.device_id = ? AND c.page_id = facebook_leads.page_id AND c.psid = facebook_leads.psid AND c.status = 'reply_pending')`)
          .bind(changedAt, auth.key, auth.deviceId, account.page_id, auth.key, auth.deviceId),
        env.DB.prepare('DELETE FROM facebook_keyword_rules WHERE license_key = ? AND device_id = ? AND page_id = ? AND id = ?').bind(auth.key, auth.deviceId, account.page_id, id),
      ]);
      return json({ ok: true });
    } finally {
      await releaseCaptureLock(auth, env);
    }
  }
  if (body.action !== 'sync') return json({ error: 'Operation prospects Facebook inconnue.' }, 400);

  const now = Math.floor(Date.now() / 1000);
  await acquireCaptureLock(auth, env);

  let captured = 0;
  let replied = 0;
  let complete = true;
  let remainingPosts = 0;
  try {
    const staleBefore = now - 120;
    await env.DB.batch([
      env.DB.prepare(`UPDATE facebook_seen_comments SET status = 'reply_unknown', reply_error = 'Worker interrompu pendant la transmission; aucun renvoi automatique.', updated_at = ? WHERE license_key = ? AND device_id = ? AND status = 'reply_sending' AND updated_at < ?`).bind(now, auth.key, auth.deviceId, staleBefore),
      env.DB.prepare(`UPDATE facebook_leads SET reply_status = 'reply_unknown', updated_at = ? WHERE license_key = ? AND device_id = ? AND reply_status = 'sending' AND updated_at < ?`).bind(now, auth.key, auth.deviceId, staleBefore),
    ]);

    let state = await env.DB.prepare('SELECT * FROM facebook_capture_state WHERE license_key = ? AND device_id = ?').bind(auth.key, auth.deviceId).first();
    if (!state) throw Object.assign(new Error('Progression de capture Facebook indisponible.'), { status: 503 });
    if (state.page_id && String(state.page_id) !== String(account.page_id)) {
      throw Object.assign(new Error('La Page Facebook a change; reconnecte-la avant de reprendre la capture.'), { status: 409 });
    }
    if (!state.page_id) {
      await env.DB.prepare('UPDATE facebook_capture_state SET page_id = ?, updated_at = ? WHERE license_key = ? AND device_id = ?')
        .bind(String(account.page_id), now, auth.key, auth.deviceId).run();
      state = { ...state, page_id: String(account.page_id) };
    }
    let postIds = [];
    let scanStartedAt = Number(state.scan_started_at) || now;
    if (state.pending_posts) {
      try { postIds = JSON.parse(state.pending_posts); } catch { postIds = null; }
      if (!Array.isArray(postIds) || postIds.length > 20 || postIds.some(id => typeof id !== 'string' || !/^\d+(?:_\d+)?$/.test(id))) {
        postIds = null;
        await env.DB.batch([
          env.DB.prepare('DELETE FROM facebook_capture_cursors WHERE license_key = ? AND device_id = ?').bind(auth.key, auth.deviceId),
          env.DB.prepare('UPDATE facebook_capture_state SET pending_posts = NULL, post_offset = 0, scan_started_at = NULL, updated_at = ? WHERE license_key = ? AND device_id = ?').bind(now, auth.key, auth.deviceId),
        ]);
        state = { ...state, pending_posts: null, post_offset: 0, scan_started_at: null };
        scanStartedAt = now;
      }
    } else {
      postIds = null;
    }
    if (postIds === null) {
      const posts = await graph(env, `${account.page_id}/posts`, { token, params: { fields: 'id', limit: '20' } });
      postIds = (posts.data || []).map(post => String(post.id || '')).filter(id => /^\d+(?:_\d+)?$/.test(id)).slice(0, 20);
      await env.DB.prepare('UPDATE facebook_capture_state SET pending_posts = ?, post_offset = 0, scan_started_at = ?, updated_at = ? WHERE license_key = ? AND device_id = ?')
        .bind(JSON.stringify(postIds), now, now, auth.key, auth.deviceId).run();
      state = { ...state, pending_posts: JSON.stringify(postIds), post_offset: 0, scan_started_at: now };
      scanStartedAt = now;
    }

    if (!postIds.length) {
      await env.DB.prepare('UPDATE facebook_capture_state SET last_scan_at = ?, pending_posts = NULL, post_offset = 0, scan_started_at = NULL, updated_at = ? WHERE license_key = ? AND device_id = ?')
        .bind(scanStartedAt, now, auth.key, auth.deviceId).run();
    } else {
      const rulesResult = await env.DB.prepare('SELECT id, keyword, reply_message, auto_reply FROM facebook_keyword_rules WHERE license_key = ? AND device_id = ? AND page_id = ? ORDER BY created_at LIMIT 100').bind(auth.key, auth.deviceId, account.page_id).all();
      const rules = rulesResult.results || [];
      const cursorResults = await env.DB.prepare('SELECT post_id, after_cursor FROM facebook_capture_cursors WHERE license_key = ? AND device_id = ?').bind(auth.key, auth.deviceId).all();
      const cursors = new Map((cursorResults.results || []).map(row => [String(row.post_id), { after_cursor: row.after_cursor }]));
      const since = Number(state.last_scan_at) || (scanStartedAt - 7 * 24 * 60 * 60);
      let offset = Math.max(0, Number(state.post_offset) || 0);
      const end = Math.min(postIds.length, offset + 5);
      const maxComments = 8;
      let commentsScanned = 0;
      const cursorUpdates = [];
      let nextOffset = offset;
      for (let postIndex = offset; postIndex < end && commentsScanned < maxComments; postIndex += 1) {
        const postId = postIds[postIndex];
        let cursorRow = cursors.get(postId) || null;
        let postComplete = false;
        {
          const commentsResult = await graph(env, `${postId}/comments`, { token, params: {
            fields: 'id,message,from,created_time', limit: String(Math.min(8, maxComments - commentsScanned)), since,
            ...(cursorRow?.after_cursor ? { after: cursorRow.after_cursor } : {}),
          } });
          const rawComments = Array.isArray(commentsResult.data) ? commentsResult.data : [];
          commentsScanned += rawComments.length;
          const comments = rawComments.filter(comment => /^\d{1,80}$/.test(String(comment.from?.id || ''))
            && String(comment.from.id) !== String(account.page_id) && String(comment.id || '').length <= 160 && String(comment.message || '').trim())
            .sort((a, b) => new Date(a.created_time || 0).getTime() - new Date(b.created_time || 0).getTime());
          const candidates = comments.map(comment => {
            const text = String(comment.message || '').trim().slice(0, 8000);
            const normalized = normalizeKeyword(text);
            const rule = rules.find(item => normalized.includes(normalizeKeyword(item.keyword))) || null;
            return { comment, text, rule, psid: String(comment.from.id), commentId: String(comment.id) };
          });
          if (candidates.length) {
            const claimResults = await env.DB.batch(candidates.map(item => env.DB.prepare(`INSERT OR IGNORE INTO facebook_seen_comments
              (license_key, device_id, page_id, comment_id, post_id, psid, name, rule_id, comment_text, keyword, reply_message, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .bind(auth.key, auth.deviceId, String(account.page_id), item.commentId, postId, item.psid, String(item.comment.from?.name || '').slice(0, 300), item.rule?.id || null, item.text,
                item.rule?.keyword || null, item.rule?.auto_reply ? String(item.rule.reply_message || '').slice(0, 2000) : null,
                item.rule?.auto_reply && item.rule.reply_message ? 'reply_pending' : 'captured', now, now)));
            const fresh = candidates.filter((_, index) => Number(claimResults[index]?.meta?.changes || 0) === 1);
            captured += fresh.length;
            if (fresh.length) {
              await env.DB.batch(fresh.map(item => env.DB.prepare(`INSERT INTO facebook_leads
                (license_key, device_id, page_id, psid, name, source, last_text, post_id, keyword, reply_status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'comment', ?, ?, ?, ?, ?, ?)
                ON CONFLICT(license_key, device_id, page_id, psid) DO UPDATE SET name = COALESCE(excluded.name, facebook_leads.name),
                source = 'comment', last_text = excluded.last_text, post_id = excluded.post_id,
                keyword = COALESCE(excluded.keyword, facebook_leads.keyword), reply_status = excluded.reply_status, updated_at = excluded.updated_at`)
                .bind(auth.key, auth.deviceId, String(account.page_id), item.psid, String(item.comment.from?.name || '').slice(0, 300) || null, item.text, postId,
                  item.rule?.keyword || null, item.rule?.auto_reply ? 'pending' : 'not_sent', now, now)));
            }
          }

          const nextCursor = commentsResult.paging?.cursors?.after || null;
          if (nextCursor) {
            cursorUpdates.push(env.DB.prepare(`INSERT INTO facebook_capture_cursors (license_key, device_id, post_id, after_cursor, updated_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(license_key, device_id, post_id) DO UPDATE SET after_cursor = excluded.after_cursor, updated_at = excluded.updated_at`)
              .bind(auth.key, auth.deviceId, postId, nextCursor, now));
            cursorRow = { after_cursor: nextCursor };
            postComplete = false;
          } else {
            cursorUpdates.push(env.DB.prepare('DELETE FROM facebook_capture_cursors WHERE license_key = ? AND device_id = ? AND post_id = ?').bind(auth.key, auth.deviceId, postId));
            postComplete = true;
          }
        }
        if (!postComplete) { complete = false; break; }
        nextOffset = postIndex + 1;
      }
      if (nextOffset >= postIds.length) {
        cursorUpdates.push(env.DB.prepare('UPDATE facebook_capture_state SET last_scan_at = ?, pending_posts = NULL, post_offset = 0, scan_started_at = NULL, updated_at = ? WHERE license_key = ? AND device_id = ?')
          .bind(scanStartedAt, now, auth.key, auth.deviceId));
        if (cursorUpdates.length) await env.DB.batch(cursorUpdates);
        complete = true;
        remainingPosts = 0;
      } else {
        cursorUpdates.push(env.DB.prepare('UPDATE facebook_capture_state SET post_offset = ?, updated_at = ? WHERE license_key = ? AND device_id = ?')
          .bind(nextOffset, now, auth.key, auth.deviceId));
        if (cursorUpdates.length) await env.DB.batch(cursorUpdates);
        complete = false;
        remainingPosts = Math.max(0, postIds.length - nextOffset);
      }
    }

    const pending = await env.DB.prepare(`SELECT comment_id, psid, reply_message FROM facebook_seen_comments
      WHERE license_key = ? AND device_id = ? AND page_id = ? AND status = 'reply_pending' ORDER BY created_at LIMIT 2`).bind(auth.key, auth.deviceId, account.page_id).all();
    const pendingRows = pending.results || [];
    if (pendingRows.length) {
      const claimAt = Math.floor(Date.now() / 1000);
      await env.DB.batch(pendingRows.flatMap(row => [
        env.DB.prepare("UPDATE facebook_seen_comments SET status = 'reply_sending', updated_at = ? WHERE license_key = ? AND device_id = ? AND page_id = ? AND comment_id = ? AND status = 'reply_pending'").bind(claimAt, auth.key, auth.deviceId, account.page_id, row.comment_id),
        env.DB.prepare("UPDATE facebook_leads SET reply_status = 'sending', updated_at = ? WHERE license_key = ? AND device_id = ? AND page_id = ? AND psid = ?").bind(claimAt, auth.key, auth.deviceId, account.page_id, row.psid),
      ]));
      const outcomes = [];
      for (const row of pendingRows) {
        try {
          await graph(env, `${row.comment_id}/private_replies`, { method: 'POST', token, body: { message: row.reply_message } });
          outcomes.push({ row, status: 'reply_sent', error: null }); replied += 1;
        } catch (error) {
          const finalStatus = error.status && error.status < 500 ? 'reply_failed' : 'reply_unknown';
          outcomes.push({ row, status: finalStatus, error: String(error.message || error).slice(0, 400) });
        }
      }
      const completedAt = Math.floor(Date.now() / 1000);
      await env.DB.batch(outcomes.flatMap(item => [
        env.DB.prepare('UPDATE facebook_seen_comments SET status = ?, reply_error = ?, updated_at = ? WHERE license_key = ? AND device_id = ? AND page_id = ? AND comment_id = ?')
          .bind(item.status, item.error, completedAt, auth.key, auth.deviceId, account.page_id, item.row.comment_id),
        env.DB.prepare("UPDATE facebook_leads SET reply_status = ?, updated_at = ? WHERE license_key = ? AND device_id = ? AND page_id = ? AND psid = ?")
          .bind(item.status, completedAt, auth.key, auth.deviceId, account.page_id, item.row.psid),
      ]));
    }
    return json({ captured, replied, complete, remainingPosts, lastScanAt: complete ? scanStartedAt : Number(state.last_scan_at) || null });
  } finally {
    await releaseCaptureLock(auth, env);
  }
}

async function handleOperation(path, request, auth, env) {
  const body = await request.json().catch(() => ({}));
  const { token, account } = await pageTokenFor(auth, env);
  if (path === '/facebook/prospects') return handleProspects(body, auth, account, token, env);
  if (path === '/facebook/conversations' && body.action === 'list') {
    const data = await graph(env, 'me/conversations', { token, params: { fields: 'id,snippet,updated_time,participants', limit: '100' } });
    const conversations = (data.data || []).map((conversation) => {
      const participants = conversation.participants?.data || [];
      const other = participants.find((person) => String(person.id) !== String(account.page_id)) || participants[0] || null;
      return { id: String(conversation.id), name: String(other?.name || conversation.snippet || conversation.id), recipientId: other ? String(other.id) : null, snippet: String(conversation.snippet || ''), updatedTime: conversation.updated_time || null };
    });
    return json({ conversations });
  }
  if (path === '/facebook/conversations' && body.action === 'send') {
    const recipientId = String(body.recipientId || '').trim();
    const message = String(body.message || '').trim();
    if (!/^\d{1,40}$/.test(recipientId) || (!message && !body.media)) return json({ error: 'Destinataire PSID et message ou media requis.' }, 400);
    if (message.length > 2000) return json({ error: 'Le message Messenger depasse 2000 caracteres.' }, 400);
    let result;
    const media = await decodeMedia(body.media);
    if (media) {
      const form = new FormData();
      const kind = media.type.startsWith('video/') ? 'video' : 'image';
      form.append('recipient', JSON.stringify({ id: recipientId }));
      form.append('message', JSON.stringify({ attachment: { type: kind, payload: { is_reusable: false } } }));
      form.append('messaging_type', 'RESPONSE');
      form.append('filedata', new Blob([media.bytes], { type: media.type }), media.name);
      result = await graph(env, 'me/messages', { method: 'POST', params: { access_token: token }, body: form });
      if (message) {
        try { result.textResult = await graph(env, 'me/messages', { method: 'POST', params: { access_token: token }, body: { recipient: { id: recipientId }, message: { text: message }, messaging_type: 'RESPONSE' } }); }
        catch (error) { throw Object.assign(new Error('Le media a ete transmis; la reponse texte n’a pas ete confirmee. ' + error.message), { status: 502 }); }
      }
    } else {
      result = await graph(env, 'me/messages', { method: 'POST', params: { access_token: token }, body: { recipient: { id: recipientId }, message: { text: message }, messaging_type: 'RESPONSE' } });
    }
    return json(result);
  }
  if (path === '/facebook/contacts/resolve') {
    const contacts = Array.isArray(body.contacts) ? body.contacts.slice(0, 2000) : [];
    if (!contacts.length || (Array.isArray(body.contacts) && body.contacts.length > 2000)) return json({ error: 'Importe entre 1 et 2000 contacts.' }, 400);
    const data = await graph(env, 'me/conversations', { token, params: { fields: 'id,snippet,participants', limit: '100' } });
    const conversations = (data.data || []).map((c) => {
      const other = (c.participants?.data || []).find((p) => String(p.id) !== String(account.page_id));
      return other && { id: String(other.id), name: String(other.name || '') };
    }).filter(Boolean);
    const byId = new Map(conversations.map((row) => [row.id, row]));
    const byName = new Map(conversations.filter((row) => row.name).map((row) => [row.name.toLowerCase(), row]));
    return json({ contacts: contacts.map((contact) => {
      const psid = String(contact.psid || contact.recipientId || contact.id || '').trim();
      const name = String(contact.name || '').trim();
      const match = (psid && byId.get(psid)) || (name && byName.get(name.toLowerCase())) || null;
      return { name, psid, recipientId: match?.id || null, matched: !!match };
    }) });
  }
  if (path === '/facebook/posts' && body.action === 'list') {
    const result = await graph(env, `${account.page_id}/posts`, { token, params: { fields: 'id,message,permalink_url,created_time', limit: '20' } });
    return json({ posts: result.data || [] });
  }
  if (path === '/facebook/posts' && body.action === 'publish') {
    const message = String(body.message || '').trim();
    const link = String(body.link || '').trim();
    if (message.length > 5000) return json({ error: 'Le texte de publication depasse 5000 caracteres.' }, 400);
    if (link) {
      try { const parsed = new URL(link); if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error(); }
      catch { return json({ error: 'Le lien de publication doit etre une URL HTTPS valide.' }, 400); }
    }
    const scheduled = body.scheduledPublishTime ? new Date(body.scheduledPublishTime) : null;
    const scheduledUnix = scheduled ? Math.floor(scheduled.getTime() / 1000) : null;
    if (scheduled && (!Number.isFinite(scheduledUnix) || scheduledUnix < Date.now() / 1000 + 600 || scheduledUnix > Date.now() / 1000 + 75 * 86400)) return json({ error: 'La programmation Meta doit etre entre 10 minutes et 75 jours.' }, 400);
    const media = await decodeMedia(body.media);
    if (!message && !link && !media) return json({ error: 'Saisis un texte, un lien ou joins une image/video.' }, 400);
    if (media) {
      const isVideo = media.type.startsWith('video/');
      const form = new FormData();
      form.append(isVideo ? 'description' : 'caption', message);
      form.append('source', new Blob([media.bytes], { type: media.type }), media.name);
      if (scheduledUnix) { form.append('published', 'false'); form.append('scheduled_publish_time', String(scheduledUnix)); }
      return json(await graph(env, `${account.page_id}/${isVideo ? 'videos' : 'photos'}`, { method: 'POST', token, body: form }));
    }
    return json(await graph(env, `${account.page_id}/feed`, { method: 'POST', token, body: { message, ...(link ? { link } : {}), ...(scheduledUnix ? { published: false, scheduled_publish_time: scheduledUnix } : {}) } }));
  }
  if (path === '/facebook/comments' && body.action === 'list') {
    const postId = String(body.postId || '').trim();
    if (!/^\d+_\d+$|^\d+$/.test(postId)) return json({ error: 'Identifiant de publication invalide.' }, 400);
    const result = await graph(env, `${postId}/comments`, { token, params: { fields: 'id,message,from,created_time,like_count,is_hidden', limit: '50' } });
    return json({ comments: result.data || [] });
  }
  if (path === '/facebook/comments' && body.action === 'reply') {
    const commentId = String(body.commentId || '').trim(); const message = String(body.message || '').trim();
    if (!commentId || !message || message.length > 2000) return json({ error: 'Identifiant requis et reponse de 1 a 2000 caracteres.' }, 400);
    return json(await graph(env, `${encodeURIComponent(commentId)}/comments`, { method: 'POST', token, body: { message } }));
  }
  if (path === '/facebook/comments' && body.action === 'moderate') {
    const commentId = String(body.commentId || '').trim();
    if (!commentId) return json({ error: 'Identifiant de commentaire requis.' }, 400);
    return json(await graph(env, encodeURIComponent(commentId), { method: 'POST', token, body: { is_hidden: body.hide !== false } }));
  }
  if (path === '/facebook/comments' && body.action === 'delete') {
    const commentId = String(body.commentId || '').trim();
    if (!commentId) return json({ error: 'Identifiant de commentaire requis.' }, 400);
    return json(await graph(env, encodeURIComponent(commentId), { method: 'DELETE', token }));
  }
  return json({ error: 'Operation Facebook inconnue.' }, 400);
}

export async function handleFacebookRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/facebook/oauth/callback') return request.method === 'GET' ? oauthCallback(request, env) : json({ error: 'GET requis.' }, 405);
  if (request.method !== 'POST') return json({ error: 'POST requis.' }, 405);
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 16 * 1024 * 1024) return json({ error: 'Le corps de la requete depasse 16 Mo.' }, 413);
  const auth = await licenseGate(request, env);
  if (auth.response) return auth.response;
  try {
    if (url.pathname === '/facebook/status') return await status(auth, env);
    if (url.pathname === '/facebook/oauth/start') return await oauthStart(request, env, auth);
    if (url.pathname === '/facebook/pages') return await listPages(auth, env);
    if (url.pathname === '/facebook/connect') return await connectPage(request, auth, env);
    if (url.pathname === '/facebook/disconnect') {
      await acquireCaptureLock(auth, env);
      try {
        await cancelPendingProspectReplies(auth, env);
        await env.DB.batch([
          env.DB.prepare('UPDATE facebook_capture_state SET page_id = NULL, last_scan_at = NULL, scan_started_at = NULL, pending_posts = NULL, post_offset = 0, updated_at = ? WHERE license_key = ? AND device_id = ?').bind(Math.floor(Date.now() / 1000), auth.key, auth.deviceId),
          env.DB.prepare('DELETE FROM facebook_capture_cursors WHERE license_key = ? AND device_id = ?').bind(auth.key, auth.deviceId),
          env.DB.prepare('DELETE FROM facebook_accounts WHERE license_key = ? AND device_id = ?').bind(auth.key, auth.deviceId),
        ]);
        return json({ ok: true });
      } finally {
        await releaseCaptureLock(auth, env);
      }
    }
    if (['/facebook/posts', '/facebook/conversations', '/facebook/contacts/resolve', '/facebook/comments', '/facebook/prospects'].includes(url.pathname)) return await handleOperation(url.pathname, request, auth, env);
    return json({ error: 'Route Facebook introuvable.' }, 404);
  } catch (error) {
    return json({ error: error.message || 'Echec de la passerelle Facebook.' }, error.status || 502);
  }
}
