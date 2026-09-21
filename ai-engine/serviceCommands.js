// COMMANDES DIRECTES SUR LES SERVICES MÉTIERS — ai-engine/serviceCommands.js
// ---------------------------------------------------------------------------
// « Supprime le service X », « mets Y en pause », « réactive Z », « restaure le service X » : ordres CLAIRS exécutés directement, sans passer par la
// planification du modèle (donc instantanés et fiables). L'exécution passe par le Tool Registry (authentification, rôle, vérification par relecture) ; le compte rendu est
// construit UNIQUEMENT à partir de l'état réel relu après l'action.
const toolRegistry = require('./toolRegistry');
const svcTools = require('./toolsServices');

const SVC = '(?:services?(?:\\s+m[ée]tiers?)?)';
const DET = "(?:le|la|les|l['’]|un|une|mon|mes|ce|cet|cette|du|des|au|aux)?\\s*";
const RE = {
  restore: new RegExp(`\\b(?:restaur\\w*|r[ée]cup[èe]r\\w*|remets?|r[ée]tabli\\w*|annul\\w*\\s+la\\s+suppression)\\b[^.?!]{0,40}?\\b(?:${SVC}|suppression)\\b\\s*(?:de\\s+|du\\s+|des\\s+)?${DET}(.*)$`, 'i'),
  remove: new RegExp(`\\b(?:supprim\\w*|effac\\w*|retir\\w*|enl[èe]v\\w*|d[ée]truis\\w*|d[ée]truire)\\b[^.?!]{0,30}?\\b${SVC}\\b\\s*${DET}(.*)$`, 'i'),
  pause: new RegExp(`\\b(?:mets?|met|mettre|passe\\w*|place\\w*)\\b[^.?!]{0,25}?\\b${SVC}\\b\\s*${DET}(.+?)\\s+en\\s+pause\\b`, 'i'),
  disable: new RegExp(`\\b(?:d[ée]sactiv\\w*|suspend\\w*)\\b[^.?!]{0,25}?\\b${SVC}\\b\\s*${DET}(.*)$`, 'i'),
  enable: new RegExp(`\\b(?:activ\\w*|r[ée]activ\\w*|red[ée]marr\\w*|relance\\w*|remets?)\\b[^.?!]{0,25}?\\b${SVC}\\b\\s*${DET}(.*?)(?:\\s+en\\s+ligne)?$`, 'i'),
};
const clean = (s) => String(s || '').replace(/\s+(?:s['’]il\s+(?:te|vous)\s+pla[iî]t|svp|stp|merci|maintenant|tout de suite)\b.*$/i, '').replace(/^(?:nomm[ée]e?|appel[ée]e?|intitul[ée]e?|qui\s+s['’]appelle|:)\s*/i, '').replace(/^[«"'“”‘’\s:]+|[»"'“”‘’\s.!?]+$/g, '').trim();

// Reconnaît un ordre sur les services : { action, ref } ou null. Un simple verbe « supprime » sans le mot « service » n'est PAS reconnu (autre sujet).
function parse(text) {
  const t = String(text || '').trim(); if (!t || t.length > 300) return null;
  let m = t.match(RE.restore); if (m && !/\b(?:supprim|effac)\w*\b[^.?!]{0,30}\bservice/i.test(t)) return { action: 'restore', ref: clean(m[1]) };
  m = t.match(RE.pause); if (m) return { action: 'paused', ref: clean(m[1]) };
  m = t.match(RE.disable); if (m) return { action: 'disabled', ref: clean(m[1]) };
  m = t.match(RE.remove); if (m) return { action: 'delete', ref: /\b(?:tous|toutes)\s+(?:les|mes|vos)\s+services?/i.test(t) ? 'tous' : clean(m[1]) };
  m = t.match(RE.enable); if (m && !/\b(?:supprim|effac|retir)\w*/i.test(t)) return { action: 'active', ref: clean(m[1]) };
  return null;
}
const isCommand = (text) => !!parse(text);

const labelOf = { delete: 'supprimé', paused: 'mis en pause', disabled: 'désactivé', active: 'réactivé', restore: 'restauré' };

async function one(tenantId, action, ref) {
  const name = action === 'restore' ? 'restoreBusinessService' : (action === 'delete' ? 'deleteBusinessService' : 'setBusinessServiceStatus');
  const args = action === 'restore' ? (ref ? { service: ref } : {}) : (action === 'delete' ? { service: ref } : { service: ref, status: action });
  const call = await toolRegistry.execute(tenantId, name, args, {});
  return { name, ref, call };
}

async function run(tenantId, text) {
  const cmd = parse(text); if (!cmd) return null;
  // Référence vide : « supprime le service » sans nom → on demande, on ne devine jamais.
  if (!cmd.ref && cmd.action !== 'restore') {
    const names = (await require('./businessServices').list(tenantId)).map((s) => s.name);
    return { text: names.length ? `Quel service voulez-vous ${cmd.action === 'delete' ? 'supprimer' : 'modifier'} ? Vos services : ${names.join(', ')}.` : "Vous n'avez aucun service métier.", intent: 'svccmd', isPlanningQuestion: true };
  }
  // « tous les services » : action de masse jamais exécutée sur un simple ordre.
  if (/^(?:tous|toutes)\b/i.test(cmd.ref) && cmd.action === 'delete') {
    const names = (await require('./businessServices').list(tenantId)).map((s) => s.name);
    return { text: `Vous demandez de supprimer TOUS vos services (${names.length} : ${names.join(', ')}). Par sécurité je ne le fais pas d'un seul ordre : nommez ceux à supprimer (par exemple « supprime le service ${names[0] || 'X'} »). Chaque suppression reste annulable 30 jours.`, intent: 'svccmd', isPlanningQuestion: true };
  }
  // Plusieurs services dans un ordre (« A et B », « A, B ») : d'abord le nom entier (un nom peut contenir « et »), sinon on découpe.
  let refs = [cmd.ref];
  if (cmd.ref) {
    const list = await require('./businessServices').list(tenantId);
    if (!svcTools.pick(list, cmd.ref).service && /\s+(?:et|,)\s+|,/.test(cmd.ref)) refs = cmd.ref.split(/\s*,\s*|\s+et\s+/i).map((s) => s.trim()).filter(Boolean);
  }
  const results = []; for (const ref of refs) results.push(await one(tenantId, cmd.action, ref));
  const lines = []; const toolCalls = []; let verifiedCount = 0;
  for (const r of results) {
    const c = r.call; toolCalls.push({ name: r.name, state: c.state, risk: c.risk || 'LOW_WRITE' });
    const nm = (c.result && c.result.name) || r.ref || 'le dernier service supprimé';
    if (c.state === 'SUCCESS') {
      verifiedCount += 1;
      const extra = cmd.action === 'delete' ? ` — vérifié : il n'apparaît plus dans vos services. Annulable pendant 30 jours : « restaure le service ${nm} ».${c.result && c.result.hadApiKey ? ' (La clé API liée a été révoquée : à reconnecter après une restauration.)' : ''}`
        : (cmd.action === 'restore' ? ` — vérifié : il est de nouveau dans vos services.${c.result && c.result.needsApiReconnect ? ' Sa connexion API est à refaire (clé révoquée à la suppression).' : ''}` : ' — vérifié dans votre compte.');
      lines.push(`✅ Service « ${nm} » ${labelOf[cmd.action]}${extra}`);
    } else if (c.state === 'UNCONFIRMED') lines.push(`⚠️ « ${nm} » : l'action a été lancée mais je ne peux pas la confirmer par relecture — vérifiez dans l'onglet Services Métiers.`);
    else lines.push(`❌ « ${r.ref} » : ${(c.error && c.error.message) || (c.error && c.error.code) || c.state}`);
  }
  let remaining = ''; try { const names = (await require('./businessServices').list(tenantId)).map((s) => s.name); remaining = `\nVos services actuels (${names.length}) : ${names.length ? names.join(', ') : 'aucun'}.`; } catch (e) { remaining = ''; }
  const last = results[results.length - 1].call;
  return {
    text: lines.join('\n') + remaining, intent: 'svccmd', toolCalls,
    toolCall: { name: results[results.length - 1].name, state: last.state, result: last.result || null, error: last.error || null },
    actionLog: results.map((r) => ({ icon: r.call.state === 'SUCCESS' ? '✅' : (r.call.state === 'UNCONFIRMED' ? '⚠️' : '❌'), label: `${r.name} → ${r.call.state}`, status: r.call.state === 'SUCCESS' ? 'done' : (r.call.state === 'UNCONFIRMED' ? 'warning' : 'error') })),
    verified: verifiedCount === results.length,
  };
}

module.exports = { parse, isCommand, run };
