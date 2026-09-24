'use strict';

// Registre relationnel D1 des contacts Cyrus. Toutes les requêtes à ce module
// sont déjà protégées par adminGate dans le Worker. Les clés de licence sont
// hashées avant d'être stockées; les identifiants techniques sont hashés et
// restent limités à leur tenant.

const COUNTRY_CODES = [
  ['225', 'CI', 'Côte d’Ivoire'], ['229', 'BJ', 'Bénin'], ['221', 'SN', 'Sénégal'], ['228', 'TG', 'Togo'],
  ['226', 'BF', 'Burkina Faso'], ['223', 'ML', 'Mali'], ['224', 'GN', 'Guinée'], ['222', 'MR', 'Mauritanie'],
  ['220', 'GM', 'Gambie'], ['227', 'NE', 'Niger'], ['234', 'NG', 'Nigeria'], ['233', 'GH', 'Ghana'],
  ['237', 'CM', 'Cameroun'], ['241', 'GA', 'Gabon'], ['242', 'CG', 'Congo'], ['243', 'CD', 'RD Congo'],
  ['244', 'AO', 'Angola'], ['235', 'TD', 'Tchad'], ['236', 'CF', 'République centrafricaine'], ['240', 'GQ', 'Guinée équatoriale'],
  ['212', 'MA', 'Maroc'], ['213', 'DZ', 'Algérie'], ['216', 'TN', 'Tunisie'], ['218', 'LY', 'Libye'],
  ['20', 'EG', 'Égypte'], ['27', 'ZA', 'Afrique du Sud'], ['251', 'ET', 'Éthiopie'], ['254', 'KE', 'Kenya'],
  ['255', 'TZ', 'Tanzanie'], ['256', 'UG', 'Ouganda'], ['257', 'BI', 'Burundi'], ['250', 'RW', 'Rwanda'],
  ['1', 'US', 'États-Unis/Canada'], ['7', 'RU', 'Russie/Kazakhstan'], ['33', 'FR', 'France'], ['32', 'BE', 'Belgique'],
  ['41', 'CH', 'Suisse'], ['44', 'GB', 'Royaume-Uni'], ['49', 'DE', 'Allemagne'], ['34', 'ES', 'Espagne'],
  ['39', 'IT', 'Italie'], ['351', 'PT', 'Portugal'], ['31', 'NL', 'Pays-Bas'], ['91', 'IN', 'Inde'],
  ['86', 'CN', 'Chine'], ['81', 'JP', 'Japon'], ['82', 'KR', 'Corée du Sud'], ['971', 'AE', 'Émirats arabes unis'],
  ['966', 'SA', 'Arabie saoudite'], ['55', 'BR', 'Brésil'], ['52', 'MX', 'Mexique'], ['61', 'AU', 'Australie'],
  ['62', 'ID', 'Indonésie'], ['63', 'PH', 'Philippines'], ['64', 'NZ', 'Nouvelle-Zélande'], ['65', 'SG', 'Singapour'],
];
COUNTRY_CODES.sort((a, b) => b[0].length - a[0].length);

const TOPICS = [
  ['pâtisserie', /p[aâ]tiss|gateau|gâteau|cake/i], ['cuisine', /cuisine|culinaire|recette/i],
  ['marketing', /marketing|publicit|communication/i], ['commerce', /commerce|vente|boutique|entrepreneur/i],
  ['formation', /formation|cours|apprentissage/i], ['restaurant', /restaurant|restauration|traiteur/i],
  ['cosmétique', /cosm[eé]t|beaut[eé]|soin du corps/i], ['conférence', /conf[eé]rence|webinaire|s[eé]minaire/i],
  ['agriculture', /agricultur|[eé]levage|ferme/i], ['immobilier', /immobilier|logement|maison/i],
  ['mode', /mode|v[eê]tement|couture/i], ['technologie', /technolog|informatique|num[eé]rique/i],
];
const STOP_WORDS = new Set(['avec', 'pour', 'dans', 'chez', 'depuis', 'contact', 'contacts', 'formation', 'service', 'services', 'groupe', 'campagne', 'client', 'clients', 'nouveau', 'nouveaux', 'cyrus']);
const KNOWN_STATUS = new Set(['active', 'prospect', 'client', 'opted_out', 'inactive', 'unknown']);

const nowIso = () => new Date().toISOString();
const clean = (v, max = 180) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) || null;
const norm = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

async function digest(value) {
  const bytes = new TextEncoder().encode(String(value));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, (x) => x.toString(16).padStart(2, '0')).join('');
}
function e164(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || /@/.test(s)) return null;
  let digits = s.replace(/[\s().-]/g, '');
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
  if (!digits.startsWith('+') || !/^\+[1-9]\d{7,14}$/.test(digits)) return null;
  return digits;
}
function detectCountry(phone) {
  if (!phone) return null;
  const digits = phone.slice(1);
  const row = COUNTRY_CODES.find(([callingCode]) => digits.startsWith(callingCode));
  return row ? { callingCode: row[0], countryCode: row[1], countryName: row[2], source: 'e164_calling_code', confidence: 1 } : null;
}
function tokens(value) {
  return Array.from(new Set(norm(value).split(/[^a-z0-9+]+/).filter((x) => x.length >= 3 && !STOP_WORDS.has(x))));
}
function knownTopics(values) {
  const found = new Set();
  for (const value of values.filter(Boolean)) for (const [topic, re] of TOPICS) if (re.test(value)) found.add(topic);
  return Array.from(found);
}
function minIso(a, b) { return !a ? b : !b ? a : (a < b ? a : b); }
function maxIso(a, b) { return !a ? b : !b ? a : (a > b ? a : b); }

async function primaryAdminRef(db) {
  const saved = await db.prepare("SELECT value FROM contact_master_settings WHERE key = 'primary_admin_user_ref'").first();
  if (saved && saved.value) return saved.value;
  const first = await db.prepare('SELECT key FROM licenses ORDER BY created_at ASC, key ASC LIMIT 1').first();
  if (!first || !first.key) return null;
  const ref = await digest(`cyrus-contact-user-v1:${String(first.key).trim().toUpperCase()}`);
  await db.prepare("INSERT OR IGNORE INTO contact_master_settings (key, value, updated_at) VALUES ('primary_admin_user_ref', ?, ?)").bind(ref, nowIso()).run();
  const row = await db.prepare("SELECT value FROM contact_master_settings WHERE key = 'primary_admin_user_ref'").first();
  return row && row.value || ref;
}

function metadata(event) {
  return {
    serviceId: clean(event.serviceId), serviceName: clean(event.serviceName),
    groupId: clean(event.groupId), groupName: clean(event.groupName),
    campaignId: clean(event.campaignId), campaignName: clean(event.campaignName),
    conversationId: clean(event.conversationId),
  };
}

async function relationIdFor(contactId, userRef, platform, source, m) {
  return `rel_${(await digest([contactId, userRef, platform, source, m.serviceId, m.groupId, m.campaignId, m.conversationId].join('|'))).slice(0, 40)}`;
}

async function mergeIds(db, masterId, duplicateId) {
  if (!masterId || !duplicateId || masterId === duplicateId) return false;
  const dup = await db.prepare('SELECT * FROM global_contacts WHERE id = ?').bind(duplicateId).first();
  const master = await db.prepare('SELECT * FROM global_contacts WHERE id = ?').bind(masterId).first();
  if (!dup || !master) return false;
  const masterPlatforms = new Set(JSON.parse(master.platforms_json || '[]'));
  JSON.parse(dup.platforms_json || '[]').forEach((x) => masterPlatforms.add(x));
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO global_contact_identifiers (id, contact_id, identifier_type, identifier_hash, masked_value, user_ref, platform, source, confidence, first_seen, last_seen)
      SELECT id, ?, identifier_type, identifier_hash, masked_value, user_ref, platform, source, confidence, first_seen, last_seen FROM global_contact_identifiers WHERE contact_id = ?`).bind(masterId, duplicateId),
    db.prepare(`INSERT OR IGNORE INTO global_contact_search_terms (contact_id, relation_id, field_name, term)
      SELECT ?, relation_id, field_name, term FROM global_contact_search_terms WHERE contact_id = ?`).bind(masterId, duplicateId),
    db.prepare('UPDATE global_contact_relations SET contact_id = ? WHERE contact_id = ?').bind(masterId, duplicateId),
    db.prepare('UPDATE global_contact_facets SET contact_id = ? WHERE contact_id = ?').bind(masterId, duplicateId),
    db.prepare('UPDATE global_contact_events SET contact_id = ? WHERE contact_id = ?').bind(masterId, duplicateId),
    db.prepare('DELETE FROM global_contact_identifiers WHERE contact_id = ?').bind(duplicateId),
    db.prepare('DELETE FROM global_contact_search_terms WHERE contact_id = ?').bind(duplicateId),
    db.prepare(`UPDATE global_contacts SET phone_e164 = COALESCE(phone_e164, ?), name = COALESCE(NULLIF(name, ''), ?), category = COALESCE(category, ?),
      country = COALESCE(country, ?), country_code = COALESCE(country_code, ?), country_name = COALESCE(country_name, ?), platforms_json = ?,
      first_activity = ?, last_activity = ?, updated_at = ? WHERE id = ?`)
      .bind(dup.phone_e164, dup.name, dup.category, dup.country, dup.country_code, dup.country_name, JSON.stringify(Array.from(masterPlatforms)), minIso(master.first_activity, dup.first_activity), maxIso(master.last_activity, dup.last_activity), nowIso(), masterId),
    db.prepare('DELETE FROM global_contacts WHERE id = ?').bind(duplicateId),
  ]);
  return true;
}

async function writeEvent(db, event, adminRef) {
  const tenant = clean(event.tenantId, 240);
  if (!tenant || tenant === '__admin__') return { status: 'missing_tenant' };
  const userRef = await digest(`cyrus-contact-user-v1:${tenant.trim().toUpperCase()}`);
  if (adminRef && userRef === adminRef) return { status: 'excluded_primary_admin' };

  const channel = clean(event.channel, 30);
  const platform = channel ? channel.toUpperCase() : 'UNKNOWN';
  const source = clean(event.source || event.eventType || 'cyrus', 80);
  const occurredAt = event.occurredAt && !Number.isNaN(Date.parse(event.occurredAt)) ? new Date(event.occurredAt).toISOString() : nowIso();
  const phone = e164(event.phone);
  const technicalId = clean(event.technicalId, 240);
  const idempotencyKey = clean(event.idempotencyKey, 180) || `evt_${(await digest(JSON.stringify([tenant, platform, source, event.name, phone, technicalId, occurredAt]))).slice(0, 40)}`;
  const oldEvent = await db.prepare('SELECT idempotency_key FROM global_contact_events WHERE idempotency_key = ?').bind(idempotencyKey).first();
  if (oldEvent) return { status: 'duplicate_event', idempotencyKey };
  if (!phone && !technicalId) {
    await db.prepare('INSERT OR IGNORE INTO global_contact_events (idempotency_key, event_type, contact_id, user_ref, occurred_at, received_at, status, payload_json) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)')
      .bind(idempotencyKey, clean(event.eventType || 'CONTACT_USED_BY_CYRUS', 80), userRef, occurredAt, nowIso(), 'ignored_no_reliable_identity', JSON.stringify({ source, channel: platform })).run();
    return { status: 'ignored_no_reliable_identity', idempotencyKey };
  }

  const phoneHash = phone ? await digest(`phone:${phone}`) : null;
  const technicalHash = technicalId ? await digest(`technical:${userRef}:${platform}:${technicalId}`) : null;
  let phoneMatch = phoneHash ? await db.prepare("SELECT contact_id FROM global_contact_identifiers WHERE identifier_type = 'phone' AND identifier_hash = ?").bind(phoneHash).first() : null;
  let technicalMatch = technicalHash ? await db.prepare('SELECT contact_id FROM global_contact_identifiers WHERE identifier_hash = ?').bind(technicalHash).first() : null;
  let contactId = (phoneMatch && phoneMatch.contact_id) || (technicalMatch && technicalMatch.contact_id) || `gc_${(await digest(phone ? `global-phone:${phone}` : `tenant-contact:${technicalHash}`)).slice(0, 40)}`;
  if (phoneMatch && technicalMatch && phoneMatch.contact_id !== technicalMatch.contact_id) {
    await mergeIds(db, phoneMatch.contact_id, technicalMatch.contact_id);
    contactId = phoneMatch.contact_id;
  }

  const country = detectCountry(phone);
  const before = await db.prepare('SELECT * FROM global_contacts WHERE id = ?').bind(contactId).first();
  const platforms = new Set(JSON.parse((before && before.platforms_json) || '[]'));
  platforms.add(platform);
  const name = clean(event.name, 120);
  const status = KNOWN_STATUS.has(String(event.status || '').toLowerCase()) ? String(event.status).toLowerCase() : ((before && before.status) || 'active');
  const category = clean(event.category, 100);
  const at = nowIso();
  await db.prepare(`INSERT INTO global_contacts (id, phone_e164, name, country, country_code, country_name, country_source, country_confidence, category, status, platforms_json, first_activity, last_activity, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET phone_e164 = COALESCE(global_contacts.phone_e164, excluded.phone_e164),
      name = CASE WHEN global_contacts.name IS NULL OR trim(global_contacts.name) = '' THEN excluded.name ELSE global_contacts.name END,
      country = COALESCE(global_contacts.country, excluded.country), country_code = COALESCE(global_contacts.country_code, excluded.country_code),
      country_name = COALESCE(global_contacts.country_name, excluded.country_name), country_source = COALESCE(global_contacts.country_source, excluded.country_source),
      country_confidence = COALESCE(global_contacts.country_confidence, excluded.country_confidence), category = COALESCE(global_contacts.category, excluded.category),
      status = excluded.status, platforms_json = excluded.platforms_json, first_activity = CASE WHEN global_contacts.first_activity IS NULL OR excluded.first_activity < global_contacts.first_activity THEN excluded.first_activity ELSE global_contacts.first_activity END,
      last_activity = CASE WHEN global_contacts.last_activity IS NULL OR excluded.last_activity > global_contacts.last_activity THEN excluded.last_activity ELSE global_contacts.last_activity END, updated_at = excluded.updated_at`)
    .bind(contactId, phone || null, name, country ? country.callingCode : null, country ? country.countryCode : null, country ? country.countryName : null, country ? country.source : null, country ? country.confidence : null, category, status, JSON.stringify(Array.from(platforms)), occurredAt, occurredAt, at, at).run();

  if (phoneHash) {
    await db.prepare(`INSERT INTO global_contact_identifiers (id, contact_id, identifier_type, identifier_hash, masked_value, user_ref, platform, source, confidence, first_seen, last_seen)
      VALUES (?, ?, 'phone', ?, ?, NULL, ?, ?, 1, ?, ?) ON CONFLICT(identifier_type, identifier_hash) DO UPDATE SET contact_id = excluded.contact_id, last_seen = excluded.last_seen`)
      .bind(`id_${phoneHash.slice(0, 40)}`, contactId, phoneHash, phone.slice(0, 5) + '…' + phone.slice(-3), platform, source, occurredAt, occurredAt).run();
  }
  if (technicalHash) {
    await db.prepare(`INSERT INTO global_contact_identifiers (id, contact_id, identifier_type, identifier_hash, masked_value, user_ref, platform, source, confidence, first_seen, last_seen)
      VALUES (?, ?, 'technical', ?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT(identifier_type, identifier_hash) DO UPDATE SET contact_id = excluded.contact_id, last_seen = excluded.last_seen`)
      .bind(`id_${technicalHash.slice(0, 40)}`, contactId, technicalHash, `${platform}: [identifiant privé]`, userRef, platform, source, occurredAt, occurredAt).run();
  }

  const m = metadata(event);
  const relationId = await relationIdFor(contactId, userRef, platform, source, m);
  const context = { source, category, interests: Array.isArray(event.interests) ? event.interests.slice(0, 20).map((x) => clean(x, 80)).filter(Boolean) : [] };
  await db.prepare(`INSERT INTO global_contact_relations (id, contact_id, user_ref, service_id, service_name, platform, source, group_id, group_name, campaign_id, campaign_name, conversation_id, first_used, last_used, context_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET last_used = CASE WHEN excluded.last_used > global_contact_relations.last_used THEN excluded.last_used ELSE global_contact_relations.last_used END,
      service_name = COALESCE(global_contact_relations.service_name, excluded.service_name), group_name = COALESCE(global_contact_relations.group_name, excluded.group_name),
      campaign_name = COALESCE(global_contact_relations.campaign_name, excluded.campaign_name), context_json = excluded.context_json`)
    .bind(relationId, contactId, userRef, m.serviceId, m.serviceName, platform, source, m.groupId, m.groupName, m.campaignId, m.campaignName, m.conversationId, occurredAt, occurredAt, JSON.stringify(context)).run();

  const facetInputs = [];
  if (category) facetInputs.push({ type: 'category', value: category, evidence: 'explicit_category', confidence: 1 });
  for (const interest of context.interests) facetInputs.push({ type: 'interest', value: interest, evidence: 'explicit_interest', confidence: 1 });
  const topicEvidence = [m.groupName, m.campaignName, m.serviceName].filter(Boolean);
  for (const topic of knownTopics(topicEvidence)) facetInputs.push({ type: 'interest', value: topic, evidence: 'observed_group_campaign_or_service', confidence: 0.8 });
  for (const facet of facetInputs) {
    const facetValue = clean(facet.value, 100);
    if (!facetValue) continue;
    const id = `fac_${(await digest([contactId, relationId, facet.type, norm(facetValue)].join('|'))).slice(0, 40)}`;
    await db.prepare('INSERT OR IGNORE INTO global_contact_facets (id, contact_id, relation_id, facet_type, facet_value, evidence, confidence, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, contactId, relationId, facet.type, facetValue, facet.evidence, facet.confidence, source, occurredAt).run();
    for (const term of tokens(facetValue)) await db.prepare("INSERT OR IGNORE INTO global_contact_search_terms (contact_id, relation_id, field_name, term) VALUES (?, ?, ?, ?)").bind(contactId, relationId, facet.type, term).run();
  }

  const fields = [
    ['name', name, ''], ['phone', phone, ''], ['group', m.groupName, relationId], ['campaign', m.campaignName, relationId],
    ['service', m.serviceName, relationId], ['source', source, relationId],
  ];
  for (const [field, value, rel] of fields) for (const term of tokens(value)) {
    await db.prepare('INSERT OR IGNORE INTO global_contact_search_terms (contact_id, relation_id, field_name, term) VALUES (?, ?, ?, ?)').bind(contactId, rel, field, term).run();
  }

  const safePayload = JSON.stringify({ source, channel: platform, groupName: m.groupName, campaignName: m.campaignName, serviceName: m.serviceName, category, interests: context.interests });
  await db.prepare('INSERT OR IGNORE INTO global_contact_events (idempotency_key, event_type, contact_id, user_ref, occurred_at, received_at, status, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(idempotencyKey, clean(event.eventType || 'CONTACT_USED_BY_CYRUS', 80), contactId, userRef, occurredAt, at, 'processed', safePayload).run();
  return { status: before ? 'updated' : 'created', contactId, relationId, idempotencyKey };
}

function safeFilters(url) {
  const q = url.searchParams;
  return {
    country: clean(q.get('country'), 100), user: clean(q.get('user'), 240), service: clean(q.get('service'), 180),
    platform: clean(q.get('platform'), 30), source: clean(q.get('source'), 80), group: clean(q.get('group'), 180),
    campaign: clean(q.get('campaign'), 180), category: clean(q.get('category'), 100), interest: clean(q.get('interest'), 100),
    status: clean(q.get('status'), 40), firstFrom: clean(q.get('firstFrom'), 40), firstTo: clean(q.get('firstTo'), 40),
    lastFrom: clean(q.get('lastFrom'), 40), lastTo: clean(q.get('lastTo'), 40), createdFrom: clean(q.get('createdFrom'), 40),
    createdTo: clean(q.get('createdTo'), 40), keyword: clean(q.get('keyword'), 180),
    ids: (q.getAll('id').length ? q.getAll('id') : String(q.get('ids') || '').split(',')).map((x) => clean(x, 80)).filter(Boolean).slice(0, 1000),
  };
}
async function compileWhere(db, filters) {
  const clauses = [];
  const args = [];
  const addRel = (field, value, expr = field) => { if (value) { clauses.push(`EXISTS (SELECT 1 FROM global_contact_relations r WHERE r.contact_id = c.id AND r.${expr} = ?)`); args.push(value); } };
  if (filters.country) {
    clauses.push('(c.country_code = ? OR c.country = ? OR lower(c.country_name) = lower(?))');
    args.push(filters.country.toUpperCase(), filters.country.replace(/^\+/, ''), filters.country);
  }
  if (filters.user) { clauses.push('EXISTS (SELECT 1 FROM global_contact_relations r WHERE r.contact_id = c.id AND r.user_ref = ?)'); args.push(await digest(`cyrus-contact-user-v1:${filters.user.trim().toUpperCase()}`)); }
  if (filters.service) { clauses.push('EXISTS (SELECT 1 FROM global_contact_relations r WHERE r.contact_id = c.id AND (r.service_id = ? OR lower(r.service_name) = lower(?)))'); args.push(filters.service, filters.service); }
  addRel('platform', filters.platform && filters.platform.toUpperCase());
  addRel('source', filters.source);
  if (filters.group) { clauses.push('EXISTS (SELECT 1 FROM global_contact_relations r WHERE r.contact_id = c.id AND (r.group_id = ? OR lower(r.group_name) = lower(?)))'); args.push(filters.group, filters.group); }
  if (filters.campaign) { clauses.push('EXISTS (SELECT 1 FROM global_contact_relations r WHERE r.contact_id = c.id AND (r.campaign_id = ? OR lower(r.campaign_name) = lower(?)))'); args.push(filters.campaign, filters.campaign); }
  if (filters.category) { clauses.push("EXISTS (SELECT 1 FROM global_contact_facets f WHERE f.contact_id = c.id AND f.facet_type = 'category' AND lower(f.facet_value) = lower(?))"); args.push(filters.category); }
  if (filters.interest) { clauses.push("EXISTS (SELECT 1 FROM global_contact_facets f WHERE f.contact_id = c.id AND f.facet_type = 'interest' AND lower(f.facet_value) = lower(?))"); args.push(filters.interest); }
  if (filters.status) { clauses.push('c.status = ?'); args.push(filters.status.toLowerCase()); }
  if (filters.ids && filters.ids.length) { clauses.push(`c.id IN (${filters.ids.map(() => '?').join(',')})`); args.push(...filters.ids); }
  for (const [field, op, value] of [
    ['first_activity', '>=', filters.firstFrom], ['first_activity', '<=', filters.firstTo],
    ['last_activity', '>=', filters.lastFrom], ['last_activity', '<=', filters.lastTo],
    ['created_at', '>=', filters.createdFrom], ['created_at', '<=', filters.createdTo],
  ]) if (value) { clauses.push(`c.${field} ${op} ?`); args.push(value.length === 10 ? `${value}${op === '<=' ? 'T23:59:59.999Z' : 'T00:00:00.000Z'}` : value); }
  const words = tokens(filters.keyword);
  for (const word of words) { clauses.push('EXISTS (SELECT 1 FROM global_contact_search_terms s WHERE s.contact_id = c.id AND s.term = ?)'); args.push(word); }
  return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', args };
}

async function search(db, url) {
  const f = safeFilters(url);
  const where = await compileWhere(db, f);
  const count = await db.prepare(`SELECT COUNT(*) AS total FROM global_contacts c${where.sql}`).bind(...where.args).first();
  const total = Number(count && count.total) || 0;
  const from = Math.max(1, Number(url.searchParams.get('from')) || 1);
  const to = Math.max(from, Number(url.searchParams.get('to')) || (from + (Number(url.searchParams.get('limit')) || 200) - 1));
  const range = url.searchParams.has('from') || url.searchParams.has('to');
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const limit = Math.min(1000, Math.max(1, Number(range ? to - from + 1 : url.searchParams.get('limit')) || 200));
  const offset = range ? from - 1 : (page - 1) * limit;
  const orderKey = url.searchParams.get('sort') === 'first' ? 'c.first_activity' : url.searchParams.get('sort') === 'name' ? 'c.name' : 'c.last_activity';
  const direction = url.searchParams.get('order') === 'asc' ? 'ASC' : 'DESC';
  const rows = await db.prepare(`SELECT c.* FROM global_contacts c${where.sql} ORDER BY ${orderKey} ${direction}, c.id ASC LIMIT ? OFFSET ?`).bind(...where.args, limit, offset).all();
  const contacts = rows.results || [];
  if (!contacts.length) return { contacts: [], total, page, limit, from: offset + 1, to: offset, hasMore: false };
  const ids = contacts.map((c) => c.id);
  const marks = ids.map(() => '?').join(',');
  const relations = await db.prepare(`SELECT id, contact_id, substr(user_ref, -8) AS userLabel, service_id, service_name, platform, source, group_id, group_name, campaign_id, campaign_name, conversation_id, first_used, last_used FROM global_contact_relations WHERE contact_id IN (${marks}) ORDER BY last_used DESC`).bind(...ids).all();
  const facets = await db.prepare(`SELECT contact_id, facet_type, facet_value, evidence, confidence FROM global_contact_facets WHERE contact_id IN (${marks}) ORDER BY created_at DESC`).bind(...ids).all();
  const relsById = new Map();
  for (const rel of relations.results || []) { if (!relsById.has(rel.contact_id)) relsById.set(rel.contact_id, []); relsById.get(rel.contact_id).push(rel); }
  const facetsById = new Map();
  for (const facet of facets.results || []) { if (!facetsById.has(facet.contact_id)) facetsById.set(facet.contact_id, []); facetsById.get(facet.contact_id).push(facet); }
  return {
    contacts: contacts.map((c) => {
      const fs = facetsById.get(c.id) || [];
      const rs = relsById.get(c.id) || [];
      return {
        id: c.id, name: c.name, phone: c.phone_e164, country: c.country_code, countryName: c.country_name,
        countrySource: c.country_source, countryConfidence: c.country_confidence, category: c.category,
        interests: Array.from(new Set(fs.filter((x) => x.facet_type === 'interest').map((x) => x.facet_value))),
        categories: Array.from(new Set(fs.filter((x) => x.facet_type === 'category').map((x) => x.facet_value))),
        platforms: JSON.parse(c.platforms_json || '[]'), firstActivity: c.first_activity, lastActivity: c.last_activity,
        createdAt: c.created_at, status: c.status, relations: rs,
      };
    }), total, page, limit, from: offset + 1, to: Math.min(total, offset + contacts.length), hasMore: offset + contacts.length < total,
  };
}

async function summary(db) {
  const total = await db.prepare('SELECT COUNT(*) AS n FROM global_contacts').first();
  const recent = await db.prepare("SELECT COUNT(*) AS n FROM global_contacts WHERE created_at >= ?").bind(new Date(Date.now() - 30 * 86400000).toISOString()).first();
  const incoming = await db.prepare("SELECT COUNT(DISTINCT contact_id) AS n FROM global_contact_relations WHERE source LIKE '%incoming%' OR source LIKE '%auto_reply%' OR source = 'self_whatsapp'").first();
  const imported = await db.prepare("SELECT COUNT(DISTINCT contact_id) AS n FROM global_contact_relations WHERE source LIKE '%import%'").first();
  const rows = await db.prepare("SELECT status, COUNT(*) AS n FROM global_contacts GROUP BY status").all();
  const events = await db.prepare("SELECT COUNT(*) AS n FROM global_contact_events WHERE status = 'processed'").first();
  const countries = await db.prepare('SELECT country_code AS country, COUNT(*) AS n FROM global_contacts WHERE country_code IS NOT NULL GROUP BY country_code ORDER BY n DESC LIMIT 20').all();
  const platforms = await db.prepare('SELECT platform, COUNT(DISTINCT contact_id) AS n FROM global_contact_relations GROUP BY platform ORDER BY n DESC').all();
  const pending = await db.prepare("SELECT COUNT(*) AS n FROM global_contact_events WHERE status LIKE 'pending%'").first();
  return { total: Number(total && total.n) || 0, newLast30Days: Number(recent && recent.n) || 0, incoming: Number(incoming && incoming.n) || 0, imported: Number(imported && imported.n) || 0, processedEvents: Number(events && events.n) || 0, pendingEvents: Number(pending && pending.n) || 0, byStatus: rows.results || [], byCountry: countries.results || [], byPlatform: platforms.results || [] };
}

async function consolidate(db) {
  const now = nowIso();
  // Téléphones fiables dédupliqués à l'écriture par l'identifiant unique.
  // Cette passe répare les références, recalcule les plateformes et efface
  // uniquement les documents réellement orphelins.
  await db.batch([
    db.prepare('DELETE FROM global_contact_relations WHERE contact_id NOT IN (SELECT id FROM global_contacts)'),
    db.prepare('DELETE FROM global_contact_facets WHERE contact_id NOT IN (SELECT id FROM global_contacts) OR relation_id NOT IN (SELECT id FROM global_contact_relations)'),
    db.prepare("DELETE FROM global_contact_search_terms WHERE contact_id NOT IN (SELECT id FROM global_contacts) OR (relation_id <> '' AND relation_id NOT IN (SELECT id FROM global_contact_relations))"),
    db.prepare(`UPDATE global_contacts SET platforms_json = COALESCE((SELECT '[' || group_concat('"' || platform || '"') || ']' FROM (SELECT DISTINCT platform FROM global_contact_relations r WHERE r.contact_id = global_contacts.id)), '[]'), updated_at = ?`).bind(now),
  ]);
  return { ok: true, consolidatedAt: now };
}

async function handleContactsRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/contacts/, '') || '/';
  if (!env.DB) return Response.json({ error: 'D1_UNAVAILABLE' }, { status: 503 });
  if (request.method === 'GET' && path === '/status') {
    const primary = await primaryAdminRef(env.DB);
    return Response.json({ ok: true, configured: !!primary, primaryAdminExcluded: !!primary, summary: await summary(env.DB) });
  }
  if (request.method === 'POST' && path === '/events') {
    const body = await request.json().catch(() => ({}));
    const events = Array.isArray(body.events) ? body.events : [];
    if (!events.length) return Response.json({ ok: true, received: 0, results: [] });
    if (events.length > 100) return Response.json({ error: 'MAX_100_EVENTS_PER_BATCH' }, { status: 413 });
    const adminRef = await primaryAdminRef(env.DB);
    if (!adminRef) return Response.json({ error: 'PRIMARY_ADMIN_NOT_RESOLVED' }, { status: 503 });
    const results = [];
    for (const event of events) {
      try { results.push(await writeEvent(env.DB, event || {}, adminRef)); }
      catch (err) { results.push({ status: 'failed', idempotencyKey: clean(event && event.idempotencyKey, 180), error: String(err && err.message || err).slice(0, 180) }); }
    }
    return Response.json({ ok: results.every((r) => !['failed'].includes(r.status)), received: events.length, results });
  }
  if (request.method === 'POST' && path === '/preview') {
    const body = await request.json().catch(() => ({}));
    const phones = Array.isArray(body.phones) ? Array.from(new Set(body.phones.map(e164).filter(Boolean))).slice(0, 1000) : [];
    const results = [];
    for (const phone of phones) {
      const hash = await digest(`phone:${phone}`);
      const row = await env.DB.prepare("SELECT contact_id FROM global_contact_identifiers WHERE identifier_type = 'phone' AND identifier_hash = ?").bind(hash).first();
      results.push({ phone, exists: !!row, contactId: row && row.contact_id || null, country: detectCountry(phone) });
    }
    return Response.json({ ok: true, checked: results.length, existing: results.filter((x) => x.exists).length, results });
  }
  if (request.method === 'GET' && path === '/') return Response.json(await search(env.DB, url));
  if (request.method === 'GET' && path === '/summary') return Response.json(await summary(env.DB));
  if (request.method === 'POST' && path === '/merge') {
    const body = await request.json().catch(() => ({}));
    const masterId = clean(body.masterId, 80);
    const duplicateIds = Array.isArray(body.duplicateIds) ? Array.from(new Set(body.duplicateIds.map((x) => clean(x, 80)).filter(Boolean))).slice(0, 200) : [];
    if (!masterId || !duplicateIds.length) return Response.json({ error: 'masterId et duplicateIds requis.' }, { status: 400 });
    let merged = 0;
    for (const id of duplicateIds) if (await mergeIds(env.DB, masterId, id)) merged += 1;
    return Response.json({ ok: true, masterId, merged });
  }
  if (request.method === 'POST' && path === '/consolidate') return Response.json(await consolidate(env.DB));
  return Response.json({ error: 'CONTACT_ROUTE_NOT_FOUND' }, { status: 404 });
}

module.exports = { handleContactsRequest, e164, detectCountry, tokens, knownTopics, primaryAdminRef, writeEvent, search, summary, consolidate };
