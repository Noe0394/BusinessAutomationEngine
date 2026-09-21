// CRÉATION ET INVITATION DE GROUPES COMMUNAUTAIRES — ai-engine/communityService.js
// ---------------------------------------------------------------------------
// Crée un groupe WhatsApp ou Telegram à partir d'un titre et d'une liste de contacts VALIDÉS (Excel/CSV, OCR d'image, texte collé, ou liste
// déjà préparée par le pipeline contacts), puis y ajoute les participants EN RESPECTANT LEURS PARAMÈTRES DE CONFIDENTIALITÉ :
//   • ajout direct tenté seulement pour les contacts existants sur la plateforme et n'ayant pas demandé l'arrêt (opt-out) ;
//   • si le contact a restreint l'ajout direct (WhatsApp « 403 », Telegram « USER_PRIVACY_RESTRICTED »/missingInvitees) : AUCUN contournement,
//     le lien d'invitation OFFICIEL du groupe lui est envoyé en message privé (DM) ;
//   • cadence lente et aléatoire, pause automatique sur limitation de débit (jamais d'insistance), un seul traitement à la fois par compte/canal.
// Le traitement est un JOB persistant (progression, statut par membre, rapport). La logique est commune aux deux canaux : un « pilote » par
// plateforme fournit seulement les primitives (vérifier, créer, ajouter, lien, DM) — les moteurs WhatsApp/Telegram ne sont pas modifiés au-delà.
const storageAdapter = require('./storageAdapter');
const contactCrm = require('./contactCrm');

const NS = 'community_jobs';
const sanitize = (id) => String(id || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'default';
const uid = () => 'grp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const cfgNum = (name, def) => { const v = parseInt(process.env[name], 10); return Number.isFinite(v) && v >= 0 ? v : def; };
const cfg = () => ({
  maxMembers: cfgNum('COMMUNITY_MAX_MEMBERS', 256),
  waBatch: Math.max(1, cfgNum('COMMUNITY_WA_BATCH', 3)),
  delayMin: cfgNum('COMMUNITY_DELAY_MIN_MS', 4000), delayMax: cfgNum('COMMUNITY_DELAY_MAX_MS', 9000),
});
let sleepFn = (ms) => new Promise((r) => setTimeout(r, ms));
const pause = (min, max) => sleepFn(min + Math.floor(Math.random() * Math.max(1, max - min)));
const running = new Map();   // tenant:channel -> jobId (un seul traitement à la fois)
const promises = new Map();  // jobId -> promesse du traitement (tests / attente)

const DEFAULT_INVITE = 'Bonjour {nom}, vous êtes invité(e) à rejoindre le groupe « {groupe} » : {lien}';
function renderInvite(template, { name, group, link }) {
  let t = String(template || DEFAULT_INVITE).slice(0, 600);
  if (!/\{lien\}/.test(t)) t += ' {lien}';
  return t.replace(/\{nom\}/g, name || '').replace(/\{groupe\}/g, group).replace(/\{lien\}/g, link).replace(/\s{2,}/g, ' ').trim();
}

// ---------------------------------------------------------------------------- pilotes de plateforme
function whatsappDriver(tenant) {
  const session = require('../adapters/whatsappManager').getOrCreate(tenant).session;
  const jidOf = (m) => `${m.identifier}@s.whatsapp.net`;
  return {
    channel: 'WHATSAPP',
    connected: () => !!session && (typeof session.isConnected !== 'function' || session.isConnected()),
    async verify(members) {
      for (let i = 0; i < members.length; i += 50) {
        const chunk = members.slice(i, i + 50);
        const res = await session.checkNumbersOnWhatsApp(chunk.map((m) => m.identifier));
        chunk.forEach((m) => { const r = res.find((x) => x.number === m.identifier); if (!r || !r.exists) { m.status = 'not_on_platform'; m.reason = 'Numéro absent de WhatsApp'; } });
        if (i + 50 < members.length) await pause(600, 1500);
      }
    },
    async create(title, about) { const g = await session.createGroup(title, []); if (about) { try { await session.setGroupDescription(g.id, about); } catch (e) { /* facultatif */ } } return { id: g.id, subject: g.subject }; },
    batchSize: () => cfg().waBatch,
    async add(group, batch) {
      const res = await session.addGroupParticipants(group.id, batch.map((m) => m.identifier));
      return batch.map((m) => {
        const r = res.find((x) => x.number === m.identifier);
        const st = r ? r.status : 'unknown';
        if (st === '200') return { member: m, outcome: 'added' };
        if (st === '409') return { member: m, outcome: 'already' };
        if (st === '403' || st === '408') return { member: m, outcome: 'needs_invite', reason: st === '403' ? 'Confidentialité : ajout direct non autorisé' : 'A quitté le groupe récemment' };
        return { member: m, outcome: 'failed', reason: `Refus WhatsApp (${st})` };
      });
    },
    link: (group) => session.getGroupInviteLink(group.id),
    dm: (member, text) => session.sendMessage(jidOf(member), text),
    isFlood: (err) => /rate-overlimit|429|too many|flood/i.test(String((err && err.message) || err)),
  };
}

function telegramDriver(tenant) {
  const session = require('../adapters/telegramManager').getOrCreate(tenant).session;
  const entities = new Map(); // memberId -> entité utilisateur résolue (mémoire du traitement uniquement, jamais persistée)
  let groupEntity = null;     // entité du groupe (BigInt : jamais sérialisée dans le job)
  const entityOf = async (group) => groupEntity || (groupEntity = await session.getGroupEntity(group.id));
  const userOf = async (m) => entities.get(m.id) || (entities.set(m.id, await session.resolveRecipient(m.identifier)), entities.get(m.id));
  return {
    channel: 'TELEGRAM',
    connected: () => !!session && typeof session.isConnected === 'function' && session.isConnected(),
    async verify(members) {
      for (const m of members) {
        if (m.status !== 'pending') continue;
        try { entities.set(m.id, await session.resolveRecipient(m.identifier)); } catch (e) { m.status = 'not_on_platform'; m.reason = 'Introuvable sur Telegram'; }
        await pause(500, 1200);
      }
    },
    async create(title, about) { const g = await session.createCommunityGroup({ title, about }); groupEntity = g.entity; return { id: g.id, subject: title }; },
    batchSize: () => 1,
    async add(group, batch) {
      const out = [];
      for (const m of batch) {
        try {
          const r = await session.inviteUserToGroup(await entityOf(group), await userOf(m));
          out.push(r.added ? { member: m, outcome: 'added' } : { member: m, outcome: 'needs_invite', reason: 'Confidentialité : ajout direct non autorisé' });
        } catch (err) {
          const msg = String((err && (err.errorMessage || err.message)) || err);
          if (/USER_PRIVACY_RESTRICTED|USER_NOT_MUTUAL_CONTACT|USER_CHANNELS_TOO_MUCH/.test(msg)) out.push({ member: m, outcome: 'needs_invite', reason: 'Confidentialité : ajout direct non autorisé' });
          else if (/USER_ALREADY_PARTICIPANT/.test(msg)) out.push({ member: m, outcome: 'already' });
          else if (/PEER_FLOOD|FLOOD_WAIT|FLOOD/.test(msg)) { out.push({ member: m, outcome: 'flood', reason: 'Limitation Telegram' }); break; }
          else out.push({ member: m, outcome: 'failed', reason: msg.slice(0, 80) });
        }
      }
      return out;
    },
    link: async (group) => session.exportGroupInviteLink(await entityOf(group)),
    dm: async (member, text) => session.sendMessage(await userOf(member), text),
    isFlood: (err) => /PEER_FLOOD|FLOOD/i.test(String((err && (err.errorMessage || err.message)) || err)),
  };
}
const DRIVERS = { WHATSAPP: whatsappDriver, TELEGRAM: telegramDriver };

// ---------------------------------------------------------------------------- persistance
const loadDoc = (tenant) => storageAdapter.get(NS, sanitize(tenant), { tenant: sanitize(tenant), jobs: {} });
async function saveJob(tenant, job) {
  const doc = await loadDoc(tenant);
  doc.jobs[job.id] = job;
  const ids = Object.keys(doc.jobs).sort((a, b) => String(doc.jobs[b].createdAt).localeCompare(String(doc.jobs[a].createdAt)));
  for (const old of ids.slice(50)) delete doc.jobs[old];
  await storageAdapter.set(NS, sanitize(tenant), doc);
}
const count = (job, st) => job.members.filter((m) => m.status === st).length;
function publicJob(job, withMembers) {
  const c = {};
  for (const m of job.members) c[m.status] = (c[m.status] || 0) + 1;
  return {
    id: job.id, channel: job.channel, title: job.title, status: job.status, error: job.error || null,
    group: job.group ? { id: job.group.id, subject: job.group.subject, link: job.group.link || null } : null,
    counts: Object.assign({ total: job.members.length, added: 0, invited_dm: 0, already_member: 0, not_on_platform: 0, opted_out: 0, failed: 0, pending: 0, needs_invite: 0 }, c),
    createdAt: job.createdAt, finishedAt: job.finishedAt || null,
    members: withMembers ? job.members.slice(0, 100).map((m) => ({ identifier: m.identifier, name: m.name, status: m.status, reason: m.reason || null })) : undefined,
  };
}

// ---------------------------------------------------------------------------- destinataires (pipeline contacts existant)
async function resolveMembers(tenant, channel, input) {
  const campaignService = require('./campaignService');
  let recipients = null; let usernames = [];
  if (Array.isArray(input.recipients)) {
    recipients = input.recipients.map((r) => ({ identifier: String(r.identifier || r.number || r.telephone || r.phone || '').replace(channel === 'WHATSAPP' ? /\D/g : /\s/g, ''), name: r.name || r.nom || '' })).filter((r) => r.identifier);
  } else {
    let recipientsId = input.recipientsId;
    if (!recipientsId) {
      const src = {};
      if (input.file) src.file = input.file; else if (input.image) src.image = input.image; else if (input.text) src.text = input.text;
      const prep = await campaignService.prepareRecipients(tenant, src, { defaultCountryCode: input.defaultCountryCode });
      recipientsId = prep.recipientsId; usernames = prep.usernames || [];
    }
    const draftDoc = await storageAdapter.get('campaign_drafts', sanitize(tenant), { drafts: {} });
    const draft = draftDoc.drafts[recipientsId];
    if (!draft || draft.kind !== 'recipients') { const e = new Error('Liste de destinataires introuvable.'); e.code = 'RECIPIENTS_NOT_FOUND'; throw e; }
    recipients = draft.rows.filter((r) => r.state === 'valid').map((r) => ({ identifier: channel === 'TELEGRAM' ? `+${r.number}` : String(r.number), name: r.name || '' }));
    if (channel === 'TELEGRAM') usernames.forEach((u) => recipients.push({ identifier: u.startsWith('@') ? u : `@${u}`, name: '' }));
  }
  const seen = new Set(); const out = [];
  for (const r of recipients) { const k = r.identifier.toLowerCase(); if (seen.has(k)) continue; seen.add(k); out.push(r); }
  return out;
}

// ---------------------------------------------------------------------------- traitement
async function runJob(tenant, job) {
  const c = cfg();
  const key = `${sanitize(tenant)}:${job.channel}`;
  try {
    const driver = DRIVERS[job.channel](tenant);
    job.status = 'RUNNING'; await saveJob(tenant, job);
    if (!driver.connected()) { job.status = 'FAILED'; job.error = `${job.channel}_NOT_CONNECTED`; return; }
    const optedOut = await contactCrm.optedOutSet(tenant, job.channel).catch(() => new Set());
    for (const m of job.members) if (m.status === 'pending' && optedOut.has(contactCrm.identityOf(m.identifier))) { m.status = 'opted_out'; m.reason = 'A demandé à ne plus être sollicité'; }
    if (job.members.some((m) => m.status === 'pending' && !m.verified)) { await driver.verify(job.members.filter((m) => m.status === 'pending')); job.members.forEach((m) => { m.verified = true; }); await saveJob(tenant, job); }

    const todo = () => job.members.filter((m) => m.status === 'pending');
    if (!job.group) {
      if (!todo().length) { job.status = 'DONE'; job.error = 'NO_ELIGIBLE_MEMBER'; return; }
      job.group = await driver.create(job.title, job.description); await saveJob(tenant, job);
    }
    // 1) ajout DIRECT, par petits lots espacés, dans le respect de la confidentialité
    let paused = false;
    while (todo().length && !paused) {
      const batch = todo().slice(0, driver.batchSize());
      let results;
      try { results = await driver.add(job.group, batch); }
      catch (err) {
        if (driver.isFlood(err)) { paused = true; break; }
        batch.forEach((m) => { m.status = 'failed'; m.reason = 'Erreur technique'; });
        await saveJob(tenant, job); await pause(c.delayMin, c.delayMax); continue;
      }
      for (const r of results) {
        if (r.outcome === 'added') r.member.status = 'added';
        else if (r.outcome === 'already') r.member.status = 'already_member';
        else if (r.outcome === 'needs_invite') { r.member.status = 'needs_invite'; r.member.reason = r.reason; }
        else if (r.outcome === 'flood') { paused = true; }
        else { r.member.status = 'failed'; r.member.reason = r.reason; }
      }
      batch.filter((m) => m.status === 'pending' && !paused).forEach((m) => { m.status = 'failed'; m.reason = 'Sans réponse de la plateforme'; });
      await saveJob(tenant, job);
      if (todo().length && !paused) await pause(c.delayMin, c.delayMax);
    }
    if (paused) { job.status = 'PAUSED_RATE_LIMIT'; job.error = 'La plateforme a limité le débit : traitement mis en pause pour protéger le compte (reprise possible plus tard).'; return; }

    // 2) restrictions d'ajout : lien d'invitation OFFICIEL en message privé (jamais de contournement)
    const invitees = job.members.filter((m) => m.status === 'needs_invite');
    if (invitees.length) {
      job.group.link = job.group.link || await driver.link(job.group); await saveJob(tenant, job);
      if (!job.group.link) { invitees.forEach((m) => { m.status = 'failed'; m.reason = 'Lien d\'invitation indisponible'; }); }
      else {
        for (const m of invitees) {
          try { await driver.dm(m, renderInvite(job.inviteMessage, { name: m.name, group: job.group.subject, link: job.group.link })); m.status = 'invited_dm'; m.reason = 'Lien d\'invitation envoyé en message privé'; }
          catch (err) { if (driver.isFlood(err)) { job.status = 'PAUSED_RATE_LIMIT'; job.error = 'Limitation de débit pendant l\'envoi des invitations : reprise possible plus tard.'; return; } m.status = 'failed'; m.reason = 'Envoi de l\'invitation impossible'; }
          await saveJob(tenant, job); await pause(c.delayMin, c.delayMax);
        }
      }
    }
    job.status = job.members.some((m) => m.status === 'failed') ? 'DONE_WITH_ISSUES' : 'DONE';
  } catch (err) {
    console.warn(`communityService — job ${job.id} en échec : ${require('../lib/ai/aiErrors').redact(err && err.message)}`);
    job.status = 'FAILED'; job.error = 'Erreur technique pendant la création du groupe.';
  } finally {
    job.finishedAt = ['RUNNING'].includes(job.status) ? null : new Date().toISOString();
    try { await saveJob(tenant, job); } catch (e) { /* non bloquant */ }
    if (running.get(key) === job.id) running.delete(key);
  }
}

// input : { channel, title, description?, inviteMessage?, recipients? | recipientsId? | text? | file? | image?, defaultCountryCode? }
// Renvoie immédiatement le job (le traitement continue en arrière-plan) — jamais d'attente d'une longue file d'ajouts.
async function startGroup(tenant, input) {
  const channel = String(input.channel || 'WHATSAPP').toUpperCase();
  if (!DRIVERS[channel]) { const e = new Error('Canal inconnu (WHATSAPP ou TELEGRAM).'); e.code = 'INVALID_CHANNEL'; throw e; }
  const title = String(input.title || '').trim().replace(/[\u0000-\u001f]/g, ' ').slice(0, 100);
  if (title.length < 2) { const e = new Error('Un nom de groupe est requis.'); e.code = 'TITLE_REQUIRED'; throw e; }
  const key = `${sanitize(tenant)}:${channel}`;
  if (running.has(key)) { const e = new Error('Un groupe est déjà en cours de création sur ce canal : attendez sa fin.'); e.code = 'JOB_ALREADY_RUNNING'; throw e; }
  const members = (await resolveMembers(tenant, channel, input)).slice(0, cfg().maxMembers + 500);
  if (!members.length) { const e = new Error('Aucun contact valide dans la liste.'); e.code = 'NO_VALID_MEMBER'; throw e; }
  const capped = members.slice(0, cfg().maxMembers);
  const job = {
    id: uid(), tenant: sanitize(tenant), channel, title, description: String(input.description || '').slice(0, 250), inviteMessage: input.inviteMessage ? String(input.inviteMessage) : null,
    status: 'QUEUED', createdAt: new Date().toISOString(), group: null, truncated: members.length > capped.length ? members.length - capped.length : 0,
    members: capped.map((m, i) => ({ id: i, identifier: m.identifier, name: m.name || '', status: 'pending', verified: false })),
  };
  running.set(key, job.id);
  await saveJob(tenant, job);
  const p = runJob(tenant, job); promises.set(job.id, p); p.finally(() => promises.delete(job.id)).catch(() => {});
  return publicJob(job, false);
}

async function resumeJob(tenant, jobId) {
  const doc = await loadDoc(tenant); const job = doc.jobs[jobId];
  if (!job) { const e = new Error('Groupe introuvable.'); e.code = 'NOT_FOUND'; throw e; }
  if (!['PAUSED_RATE_LIMIT', 'DONE_WITH_ISSUES'].includes(job.status)) { const e = new Error('Ce traitement ne peut pas être repris.'); e.code = 'INVALID_STATE'; throw e; }
  const key = `${sanitize(tenant)}:${job.channel}`;
  if (running.has(key)) { const e = new Error('Un traitement est déjà en cours sur ce canal.'); e.code = 'JOB_ALREADY_RUNNING'; throw e; }
  job.members.forEach((m) => { if (m.status === 'failed' && /Sans réponse|Erreur technique/.test(m.reason || '')) { m.status = 'pending'; m.reason = null; } });
  job.error = null; running.set(key, job.id);
  const p = runJob(tenant, job); promises.set(job.id, p); p.finally(() => promises.delete(job.id)).catch(() => {});
  return publicJob(job, false);
}

async function getJob(tenant, jobId) { const j = (await loadDoc(tenant)).jobs[jobId]; return j ? publicJob(j, true) : null; }
async function listJobs(tenant) { return Object.values((await loadDoc(tenant)).jobs).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map((j) => publicJob(j, false)); }
const waitFor = (jobId) => promises.get(jobId) || Promise.resolve();

module.exports = { startGroup, resumeJob, getJob, listJobs, waitFor, renderInvite, DEFAULT_INVITE, DRIVERS, _setSleep: (fn) => { sleepFn = fn; }, _running: running };
