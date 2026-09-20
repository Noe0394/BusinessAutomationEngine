const storageAdapter = require('./storageAdapter');
const platformOrchestrator = require('./platformOrchestrator');
const connectorManager = require('./connectors/connectorManager');
const contactCrm = require('./contactCrm');
const pendingActions = require('./pendingActions');
const alertCenter = require('./alertCenter');
const contactIdentity = require('./contactIdentity');
const { norm } = require('./jarvis/intentClassifier');

// VALIDATION DE PAIEMENT MANUEL (HUMAN-IN-THE-LOOP) — ai-engine/manualPaymentValidator.js
// ---------------------------------------------------------------------------
// Gère les paiements manuels (Mobile Money, virement, espèces) où AUCUNE API
// de paiement ne confirme l'encaissement automatiquement : c'est
// l'administrateur (le vendeur) qui valide, jamais l'agent seul, jamais le
// client. Trois phases :
//
//   1. Côté client (WhatsApp/Telegram) : dès qu'un prospect envoie son email +
//      une preuve de paiement (reçu image/texte), on enregistre une demande en
//      état PENDING_ADMIN_APPROVAL, liée à une ACTION EN ATTENTE précise
//      (pendingActionId, voir ai-engine/pendingActions.js), et on répond au
//      client une confirmation de prise en charge — SANS jamais débloquer d'accès.
//   2. Notification du propriétaire : alerte (WhatsApp du propriétaire + tchat) portant l'identifiant de l'action.
//   3. Exécution : quand le propriétaire répond OUI / NON (WhatsApp, reliée à l'action précise) ou VALIDER / REFUSER
//      (tchat du tableau de bord), on exécute l'outil `creer_compte_eleve` du connecteur de plateforme actif, puis on
//      VÉRIFIE la confirmation de l'API : EXECUTE ≠ SUCCESS. Le client n'est prévenu que d'une activation confirmée.
//
// ÉTANCHÉITÉ ANTI-INJECTION : le déblocage n'est déclenché QUE par une décision du propriétaire (chat authentifié ou
// self-chat). Un client qui tente de manipuler l'agent ne fait jamais rien d'autre que rester en attente.
// IDEMPOTENCE : une preuve dupliquée (même message, reconnexion, retry) ne crée ni deuxième demande ni deuxième
// notification ; un « OUI » répété n'exécute jamais deux fois l'API. Une NOUVELLE preuve après un refus = nouvelle
// tentative (nouvelle action, nouveau pendingActionId).

const NAMESPACE = 'payment_validations';
const PA_TYPE = 'PAYMENT_VALIDATION';

function sanitize(id) {
  return String(id || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'unknown';
}
function legacyDocId(tenantId, channel, from) {
  return `${sanitize(tenantId)}__${sanitize(channel)}__${sanitize(from)}`;
}
function keyOf(record) {
  return record.storageKey || legacyDocId(record.tenantId, record.channel, record.from);
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PROOF_RE = /(re[çc]u|capture|preuve|j.?ai\s+pay[ée]|paiement\s+(effectu[ée]|envoy[ée]|fait)|virement|transaction|d[ée]p[ôo]t|screenshot|voici\s+(le|ma|mon))/i;
const AMOUNT_RE = /(\d[\d\s.,]{0,12}\d|\d)\s*(fcfa|f\s?cfa|xof|cfa|francs?|€|eur|euros?|usd|\$|dollars?)/i;

function extractEmail(text) {
  const m = String(text || '').match(EMAIL_RE);
  return m ? m[0].toLowerCase() : null;
}

// Montant DÉCLARÉ par le client (texte libre) — jamais validé ni deviné : null si absent.
function extractAmount(text) {
  const m = String(text || '').match(AMOUNT_RE);
  return m ? `${m[1].replace(/\s+/g, ' ').trim()} ${m[2].toUpperCase()}` : null;
}

// Un message client vaut "preuve de paiement" s'il contient un email ET (un
// signal textuel de reçu OU une pièce jointe transmise). Prudent : sans email,
// on ne déclenche pas le flux (l'email est indispensable à l'inscription).
function looksLikePaymentProof(text, hasAttachment) {
  const email = extractEmail(text);
  if (!email) return false;
  return hasAttachment === true || PROOF_RE.test(String(text || ''));
}

function saveRecord(record) {
  record.updatedAt = new Date().toISOString();
  return storageAdapter.set(NAMESPACE, keyOf(record), record);
}

async function allRecords(tenantId) {
  const out = [];
  const prefix = sanitize(tenantId) + '__';
  for (const id of storageAdapter.listIds(NAMESPACE)) {
    if (!id.startsWith(prefix)) continue;
    const rec = await storageAdapter.get(NAMESPACE, id, null);
    if (rec) out.push(rec);
  }
  return out;
}

async function listPending(tenantId) {
  const out = (await allRecords(tenantId)).filter((r) => r.status === 'PENDING_ADMIN_APPROVAL');
  out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return out;
}

// Libellé humain du client : nom, sinon vrai numéro, sinon « non identifié » — jamais un JID/LID brut.
async function customerLabel(tenantId, channel, from, identity) {
  if (identity && identity.label) return identity.label;
  try { return await contactIdentity.labelFor(tenantId, channel, from); } catch (e) { return contactIdentity.UNIDENTIFIED[String(channel).toUpperCase()] || contactIdentity.UNIDENTIFIED.WHATSAPP; }
}

// Lie un enregistrement ancien (sans pendingActionId) à une action en attente précise.
async function ensureAction(tenantId, record) {
  if (record.pendingActionId) {
    const a = await pendingActions.get(tenantId, record.pendingActionId);
    if (a) return a;
  }
  const { action } = await pendingActions.create(tenantId, {
    type: PA_TYPE, summary: `Paiement ${record.email}`, idempotencyKey: `pay-legacy:${keyOf(record)}`,
    conversationId: `${record.channel}:${record.from}`, payload: { email: record.email, channel: record.channel, from: record.from },
  });
  record.pendingActionId = action.pendingActionId;
  await saveRecord(record);
  return action;
}

// PHASE 1 + 2. Enregistre une demande en attente et prévient le propriétaire.
// Retourne { ack, record, created, duplicate } ; `ack` = message à renvoyer au client (jamais un accès).
async function registerProof({ tenantId, channel, from, text, hasAttachment, courseId, product, proofMessageId, proofMediaId, identity }) {
  const email = extractEmail(text);
  if (!email) return { ack: null };

  const ackText = 'Bien reçu ! Je transmets ton reçu à l\'équipe pour validation rapide. Tu recevras tes accès ici même dans quelques instants.';
  const records = (await allRecords(tenantId)).filter((r) => r.channel === channel && r.from === from);

  // Une demande est déjà en attente pour ce client : la nouvelle preuve s'y rattache, sans doublon ni nouvelle alerte.
  const open = records.find((r) => r.status === 'PENDING_ADMIN_APPROVAL');
  if (open) {
    open.proofs = (open.proofs || []).concat([{ messageId: proofMessageId || null, at: new Date().toISOString(), excerpt: String(text || '').slice(0, 200) }]).slice(-10);
    await saveRecord(open);
    return { ack: 'Ton reçu est bien enregistré, la vérification est en cours. Tu recevras tes accès ici dès qu\'elle sera terminée.', record: open, created: false, duplicate: true };
  }

  const attempt = records.filter((r) => ['REJECTED', 'FAILED'].includes(r.status) || r.paymentStatus === 'PAYMENT_NOT_CONFIRMED').length + 1;
  const idem = `pay:${sanitize(tenantId)}:${channel}:${sanitize(from)}:${proofMessageId || require('crypto').createHash('sha1').update(String(text || '')).digest('hex').slice(0, 12)}:${attempt}`;
  const label = await customerLabel(tenantId, channel, from, identity);
  const amount = extractAmount(text);
  const { action, created } = await pendingActions.create(tenantId, {
    type: PA_TYPE, summary: `Paiement de ${label} (${email})`, idempotencyKey: idem,
    conversationId: (identity && identity.conversationId) || `${channel}:${from}`,
    payload: { email, channel, from },
  });
  if (!created) {
    // Même preuve déjà traitée (message dupliqué) : aucun nouvel enregistrement, aucune nouvelle notification.
    const rec = records.find((r) => r.pendingActionId === action.pendingActionId) || null;
    return { ack: ackText, record: rec, created: false, duplicate: true };
  }

  const now = new Date().toISOString();
  const record = {
    storageKey: `${legacyDocId(tenantId, channel, from)}__${action.pendingActionId}`,
    tenantId, channel, from,
    pendingActionId: action.pendingActionId,
    paymentId: 'PAY-' + action.pendingActionId.slice(3),
    customerId: (identity && identity.contactId) || null,
    customerPhone: (identity && identity.internationalPhoneNumber) || null, // vrai numéro uniquement, sinon null
    customerName: (identity && identity.displayName) || null,
    customerConversationId: (identity && identity.conversationId) || `${channel}:${from}`,
    email,
    courseId: courseId || null,
    productId: courseId || null,
    productName: product || null,
    product: product || null,
    declaredAmount: amount,
    proofMessageId: proofMessageId || null,
    proofMediaId: proofMediaId || null,
    proofExcerpt: String(text || '').slice(0, 300),
    hasAttachment: hasAttachment === true,
    attempt,
    status: 'PENDING_ADMIN_APPROVAL',
    paymentStatus: 'PENDING',
    createdAt: now,
    expiresAt: new Date(action.expiresAt).toISOString(),
  };
  await saveRecord(record);

  const channelLabel = channel === 'TELEGRAM' ? 'Telegram' : 'WhatsApp';
  const card = [
    '⚠️ NOUVEAU PAIEMENT À VALIDER',
    '──────────────────────────────',
    `• Client : ${label} (${channelLabel})`,
    `• Email fourni : ${email}`,
    `• Produit / Formation : ${record.courseId || record.product || '(à préciser à la validation)'}`,
    `• Montant déclaré : ${amount || 'non précisé'}`,
    `• Preuve : ${record.hasAttachment ? 'reçu joint' : (record.proofExcerpt || 'texte du client')}`,
    `• Référence : ${action.pendingActionId}${attempt > 1 ? ` (tentative ${attempt})` : ''}`,
    '──────────────────────────────',
    `Réponds « OUI » pour valider ou « NON » pour refuser (réf. ${action.pendingActionId}).`,
  ].join('\n');
  // Tableau de bord (historique du Chat Intelligent) — conservé.
  platformOrchestrator.notifyTenantChat(tenantId, card, [
    { icon: '⚠️', label: `Paiement à valider — ${email}`, status: 'warning' },
  ]).catch((err) => console.error('manualPaymentValidator — échec de notification admin :', err.message));

  // Alerte générale (WhatsApp du propriétaire) : reliée à l'action précise, idempotente.
  const raised = await alertCenter.raise(tenantId, {
    type: 'PAYMENT_VALIDATION_REQUIRED',
    title: `Preuve de paiement reçue de ${label}`,
    body: [`Email : ${email}`, `Produit : ${record.courseId || record.product || 'à préciser'}`, `Montant déclaré : ${amount || 'non précisé'}`, record.hasAttachment ? 'Reçu joint.' : ''].filter(Boolean).join('\n'),
    hint: `Réponds « OUI » pour valider ou « NON » pour refuser.`,
    pendingActionId: action.pendingActionId, contact: identity || null, contactLabel: label,
    conversationId: record.customerConversationId, idempotencyKey: `alert:${idem}`, notify: true,
  }).catch((err) => { console.error('manualPaymentValidator — échec d\'alerte propriétaire :', err.message); return null; });
  if (raised && raised.messageId) await pendingActions.patch(tenantId, action.pendingActionId, { notification: { messageId: raised.messageId, at: Date.now() } });

  return { ack: ackText, record, created: true, duplicate: false, pendingActionId: action.pendingActionId };
}

// Compatibilité : retourne seulement le message de confirmation au client.
async function handleClientProof(args) {
  const r = await registerProof(args || {});
  return r.ack || null;
}

// --- Décision du propriétaire -------------------------------------------------------------------------------------
const VALIDATE_RE = /\b(valider?|valid[ée]e?|approuv|j.?accepte|accepte\s+le\s+paiement|ok\s+valid)\b/i;
const REFUSE_RE = /\b(refuser?|refus[ée]e?|rejet|d[ée]clin|non\s+valide)\b/i;

// Extrait un identifiant de cours d'un message admin ("VALIDER cuisine_patisserie"
// ou "VALIDER pour client@mail.com : cuisine_patisserie") — le dernier jeton
// de type slug (lettres/chiffres/_/-) qui n'est pas un email ni le mot-clé.
function extractCourseId(text, email) {
  let cleaned = String(text || '');
  if (email) cleaned = cleaned.replace(email, ' ');
  cleaned = cleaned.replace(/\bPA-[A-Z0-9]{4,8}\b/gi, ' ').replace(VALIDATE_RE, ' ').replace(REFUSE_RE, ' ');
  const tokens = cleaned.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || [];
  const stop = new Set(['pour', 'client', 'paiement', 'compte', 'acces', 'accès', 'le', 'la', 'de', 'du', 'oui', 'non', 'valide', 'refuse']);
  const cand = tokens.reverse().find((t) => !stop.has(t.toLowerCase()));
  return cand || null;
}

// Décision STRICTE (WhatsApp du propriétaire). Les réponses ambiguës (« ok », « d'accord », « attends », « je vais voir »,
// « peut-être »…) ne déclenchent JAMAIS une opération sensible. Retourne { decision: 'YES'|'NO'|null, pendingActionId, ambiguous }.
function parseOwnerDecision(text) {
  const raw = String(text || '');
  const idm = raw.match(/\bPA-[A-Z0-9]{4,8}\b/i);
  const pendingActionId = idm ? idm[0].toUpperCase() : null;
  const email = extractEmail(raw);
  let n = norm(raw.replace(/\bPA-[A-Z0-9]{4,8}\b/gi, ' ').replace(EMAIL_RE, ' '));
  const HEDGE = /(?:^|\s)(?:attends?|attendez|peut etre|je vais voir|je verrai|on verra|pas sur|pas encore|hmm+|euh|je reflechis|je ne sais pas|je sais pas|plus tard|pas maintenant|apres|d accord|dac|ok|okay|entendu)(?=\s|$|[?!])/;
  const YES = /(?:^|\s)(?:oui|ouais|valide|valider|validee?|je valide|confirme|confirmer|je confirme|approuve|j approuve|accepte|j accepte|go)(?=\s|$|[?!])/;
  const NO = /(?:^|\s)(?:non|refuse|refuser|refusee?|je refuse|rejette|rejeter|pas recu|non recu|annule|annuler)(?=\s|$|[?!])/;
  const yes = YES.test(n); const no = NO.test(n);
  const hedged = HEDGE.test(n.replace(YES, ' ').replace(NO, ' ')) || (HEDGE.test(n) && !yes && !no);
  const words = n.split(' ').filter(Boolean);
  if ((yes && no) || (!yes && !no)) return { decision: null, pendingActionId, email, ambiguous: hedged || (yes && no) };
  if (hedged && words.length > 2) return { decision: null, pendingActionId, email, ambiguous: true };
  if (words.length > 8) return { decision: null, pendingActionId, email, ambiguous: false }; // phrase trop longue : pas une décision
  return { decision: yes ? 'YES' : 'NO', pendingActionId, email, courseHint: extractCourseId(raw, email), ambiguous: false };
}

// VERIFY : l'API doit avoir confirmé EXPLICITEMENT (2xx + champ de confirmation). Sinon la tentative n'est pas un succès.
function verifyEnrollment(exec, courseId) {
  if (!exec || !exec.ok) return { verified: false, reason: (exec && exec.error) || 'API_ERROR' };
  const r = exec.result || {};
  if (r.confirmed !== true) return { verified: false, reason: 'API_CONFIRMATION_MISSING' };
  const echoed = r.courseIdConfirmed || null;
  if (echoed && courseId && String(echoed) !== String(courseId)) return { verified: false, reason: 'COURSE_MISMATCH' };
  return { verified: true };
}

// Cœur commun (WhatsApp OUI/NON et tchat VALIDER/REFUSER). `record` = enregistrement de paiement ciblé.
async function applyDecision(tenantId, record, decision, opts) {
  const o = opts || {};
  const d = o.deps || {};
  const action = await ensureAction(tenantId, record);
  const label = await customerLabel(tenantId, record.channel, record.from, null);
  const who = record.customerName || label;
  const tell = async (text) => { if (d.deliverToClient) await d.deliverToClient({ channel: record.channel, from: record.from, text }).catch(() => {}); };

  if (decision === 'NO') {
    const t = await pendingActions.transition(tenantId, action.pendingActionId, ['PENDING', 'FAILED'], 'REJECTED', { by: o.by || 'owner' });
    if (!t.ok) return { kind: 'already_handled', target: record, text: `Cette demande (${action.pendingActionId}) a déjà été traitée (statut ${t.action ? t.action.status : t.reason}).` };
    record.status = 'REJECTED'; record.paymentStatus = 'PAYMENT_NOT_CONFIRMED'; record.rejectedAt = new Date().toISOString();
    await saveRecord(record);
    const clientReply = 'Merci pour ton envoi. Nous n\'avons pas pu confirmer ce paiement pour l\'instant. Vérifie ta transaction et renvoie-nous une preuve correcte (capture du reçu + ton email) : on la regarde tout de suite.';
    await tell(clientReply);
    await alertCenter.raise(tenantId, { type: 'TASK_DONE', title: `Paiement refusé — ${who}`, body: 'Aucune activation. Le client a été invité à renvoyer une preuve.', pendingActionId: action.pendingActionId, notify: false }).catch(() => {});
    return {
      kind: 'rejected', target: record, clientReply, pendingActionId: action.pendingActionId,
      text: `Paiement de ${record.email} marqué comme refusé (réf. ${action.pendingActionId}). Aucun accès créé ; le client a été invité à renvoyer une preuve correcte.`,
      actionLog: [{ icon: '🚫', label: `Paiement refusé — ${record.email}`, status: 'done' }],
    };
  }

  // Validation : il faut un identifiant de cours (celui de la demande, sinon fourni par le propriétaire).
  const courseId = record.courseId || o.courseId || null;
  if (!courseId) {
    return {
      kind: 'need_course', target: record, pendingActionId: action.pendingActionId,
      text: `Pour valider l'accès de ${record.email}, précisez l'identifiant de la formation/produit (ex : « VALIDER ${record.email} identifiant_du_cours »).`,
    };
  }

  // Un seul exécutant : PENDING (ou FAILED = nouvelle tentative voulue) -> APPROVED -> EXECUTING.
  const t1 = await pendingActions.transition(tenantId, action.pendingActionId, ['PENDING', 'FAILED'], 'APPROVED', { by: o.by || 'owner' });
  if (!t1.ok) {
    return { kind: 'already_handled', target: record, pendingActionId: action.pendingActionId, text: `Cette demande (${action.pendingActionId}) est déjà ${t1.action ? ({ APPROVED: 'en cours de traitement', EXECUTING: 'en cours d\'exécution', DONE: 'traitée (accès déjà créé)', REJECTED: 'refusée', EXPIRED: 'expirée' }[t1.action.status] || t1.action.status) : 'introuvable'}. Rien n'a été relancé.` };
  }
  await pendingActions.transition(tenantId, action.pendingActionId, 'APPROVED', 'EXECUTING');

  const exec = await connectorManager.executeTool(tenantId, 'creer_compte_eleve', { email: record.email, course_id: courseId }, d.executeOptions || {});
  const check = verifyEnrollment(exec, courseId);

  if (!check.verified) {
    await pendingActions.transition(tenantId, action.pendingActionId, 'EXECUTING', 'FAILED', { fields: { failure: check.reason } });
    record.paymentStatus = 'ACTIVATION_FAILED'; record.lastError = check.reason; await saveRecord(record);
    await alertCenter.raise(tenantId, {
      type: 'BUSINESS_API_FAILED', title: `Activation non confirmée — ${who}`,
      body: `L'activation de ${record.email} (${courseId}) n'a pas été confirmée par l'API (${check.reason}). Le client n'a rien reçu.`,
      hint: `Réponds « OUI ${action.pendingActionId} » pour réessayer.`, pendingActionId: action.pendingActionId, notify: o.by !== 'owner_whatsapp',
    }).catch(() => {});
    const unconfirmed = exec && exec.ok;
    return {
      kind: 'error', target: record, error: check.reason, pendingActionId: action.pendingActionId, unverified: !!unconfirmed,
      text: unconfirmed
        ? `L'API a répondu mais sans confirmation explicite de l'activation de ${record.email} : je ne la considère pas comme réussie. Aucun message n'a été envoyé au client. Réponds « OUI ${action.pendingActionId} » pour réessayer.`
        : `Impossible de créer l'accès de ${record.email} (${check.reason}). Aucun message n'a été envoyé au client — réessaie (« OUI ${action.pendingActionId} ») ou vérifie la configuration de la plateforme.`,
      actionLog: [{ icon: '⚠️', label: `Échec création accès — ${record.email}`, status: 'error' }],
    };
  }

  await pendingActions.transition(tenantId, action.pendingActionId, 'EXECUTING', 'DONE');
  record.status = 'APPROVED'; record.paymentStatus = 'CONFIRMED'; record.courseId = courseId; record.approvedAt = new Date().toISOString();
  await saveRecord(record);

  // CRM : l'acheteur devient `client` (retire `nouveau_contact`). Best-effort, jamais bloquant.
  contactCrm.markPurchase(tenantId, record.channel, record.from, { sku: courseId, email: record.email })
    .catch((err) => console.error(`contactCrm.markPurchase (tenant "${tenantId}") :`, err.message));

  const link = exec.result && exec.result.passwordResetLink;
  const accessLine = link
    ? `Définis ton mot de passe ici pour accéder à ton contenu : ${link}`
    : 'Connecte-toi avec cet email pour accéder à ton contenu.';
  const clientReply = `C'est validé ! 🎉 Ton compte a été créé (${record.email}). ${accessLine}`;
  await tell(clientReply);
  await alertCenter.raise(tenantId, {
    type: exec.result && exec.result.accountCreated ? 'ACCOUNT_CREATED' : 'TRAINING_ACTIVATED',
    title: `Accès activé — ${who}`, body: `${record.email} · formation « ${courseId} » (confirmé par l'API).`,
    pendingActionId: action.pendingActionId, notify: o.by !== 'owner_whatsapp',
  }).catch(() => {});

  return {
    kind: 'approved', target: record, clientReply, execResult: exec.result, pendingActionId: action.pendingActionId,
    text: `✅ Accès créé et confirmé par l'API pour ${record.email} (formation « ${courseId} », réf. ${action.pendingActionId}). Le client a reçu ses accès sur ${record.channel === 'TELEGRAM' ? 'Telegram' : 'WhatsApp'}.`,
    actionLog: [{ icon: '🎓', label: `Accès validé & créé — ${record.email}`, status: 'done' }],
  };
}

// Décision saisie dans le TCHAT du tableau de bord (VALIDER / REFUSER). Retourne null si ce n'est pas une décision.
async function resolveAdminDecision(tenantId, text, deps) {
  const d = deps || {};
  const isValidate = VALIDATE_RE.test(text);
  const isRefuse = REFUSE_RE.test(text);
  if (!isValidate && !isRefuse) return null;

  const pending = await listPending(tenantId);
  if (!pending.length) {
    return { kind: 'none_pending', text: 'Aucun paiement n\'est en attente de validation pour le moment.' };
  }

  const email = extractEmail(text);
  const idm = String(text || '').match(/\bPA-[A-Z0-9]{4,8}\b/i);
  let target = null;
  if (idm) target = pending.find((p) => p.pendingActionId === idm[0].toUpperCase()) || null;
  if (!target && email) target = pending.find((p) => p.email === email) || null;
  if (!target && pending.length === 1) target = pending[0];
  if (!target) {
    return {
      kind: 'ambiguous',
      text: `Plusieurs paiements sont en attente. Précisez l'email du client ou la référence concernée :\n${pending.map((p) => `• ${p.email} (${p.pendingActionId || 'sans réf.'})`).join('\n')}`,
      pending,
    };
  }
  return applyDecision(tenantId, target, isRefuse ? 'NO' : 'YES', { courseId: extractCourseId(text, email), deps: d, by: 'owner_chat' });
}

// Décision du propriétaire par OUI / NON (WhatsApp), reliée à UNE action précise.
//   input : { decision:'YES'|'NO', pendingActionId?, quotedMessageId?, courseHint? }
async function resolveOwnerDecision(tenantId, input, deps) {
  const i = input || {};
  const t = await pendingActions.resolveTarget(tenantId, { pendingActionId: i.pendingActionId, quotedMessageId: i.quotedMessageId, type: PA_TYPE });
  if (t.notFound) return { kind: 'not_found', text: `Je ne trouve pas la demande ${i.pendingActionId}.` };
  if (t.none) return { kind: 'none_pending', text: 'Aucun paiement n\'est en attente de validation pour le moment.' };
  if (t.ambiguous) {
    const recs = await listPending(tenantId);
    const lines = t.open.map((a) => { const r = recs.find((x) => x.pendingActionId === a.pendingActionId); return `• ${a.pendingActionId} — ${r ? `${r.customerName || r.email}${r.declaredAmount ? ' · ' + r.declaredAmount : ''}` : a.summary}`; });
    return { kind: 'ambiguous', text: `Plusieurs paiements attendent ta décision. Précise laquelle (ex : « ${i.decision === 'NO' ? 'NON' : 'OUI'} ${t.open[0].pendingActionId} ») :\n${lines.join('\n')}` };
  }
  const rec = (await allRecords(tenantId)).find((r) => r.pendingActionId === t.action.pendingActionId)
    || (await listPending(tenantId)).find((r) => r.email === (t.action.payload || {}).email);
  if (!rec) return { kind: 'not_found', text: `L'enregistrement du paiement ${t.action.pendingActionId} est introuvable.` };
  return applyDecision(tenantId, rec, i.decision === 'NO' ? 'NO' : 'YES', { courseId: i.courseHint || null, deps, by: 'owner_whatsapp' });
}

module.exports = {
  handleClientProof,
  registerProof,
  resolveAdminDecision,
  resolveOwnerDecision,
  parseOwnerDecision,
  verifyEnrollment,
  listPending,
  looksLikePaymentProof,
  extractEmail,
  extractAmount,
  NAMESPACE,
};
