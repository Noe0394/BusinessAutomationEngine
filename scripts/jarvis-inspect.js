// Inspecte l'état Jarvis (sans contenu de messages) — utile pendant les tests réels.
//   node scripts/jarvis-inspect.js <tenantId> [numéro/chatId]
// Sur la VM : AI_ENGINE_STORAGE_DIR=/app/data/ai_engine (dans le conteneur).
const fs = require('fs');
const path = require('path');

const root = process.env.AI_ENGINE_STORAGE_DIR || path.join(__dirname, '..', 'ai_engine_data');
const [tenant, contact] = process.argv.slice(2);
if (!tenant) { console.error('usage: node scripts/jarvis-inspect.js <tenantId> [contact]'); process.exit(1); }
const safe = (s) => String(s).trim().replace(/[^A-Za-z0-9_.-]/g, '_');

const dir = path.join(root, 'conversation_state');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(`${safe(tenant)}__`)) : [];
const rows = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
  .filter((d) => !contact || d.chatId.includes(String(contact).replace(/\D/g, '') || contact));
console.log(`${rows.length} conversation(s) pour "${tenant}"`);
for (const d of rows) {
  console.log(`- ${d.platform} ${d.chatId} | état=${d.state} | refus=${d.refusal.active ? d.refusal.kind : 'non'} | optOut=${d.optOut} | tours=${d.turns}`
    + ` | expliqué=[${d.memory.explained}] accepté=[${d.memory.accepted}] refusé=[${d.memory.refused}]`
    + `${d.memory.waiting ? ' | attente=' + d.memory.waiting.kind + (d.memory.waiting.when ? '(' + d.memory.waiting.when + ')' : '') : ''}`
    + ` | dernière activité=${new Date(d.updatedAt).toISOString()}`);
}
const crm = path.join(root, 'crm_contacts', `${safe(tenant)}.json`);
if (fs.existsSync(crm)) {
  const opt = Object.values(JSON.parse(fs.readFileSync(crm, 'utf8')).contacts || {}).filter((c) => c.optOut);
  console.log(`Contacts en opt-out : ${opt.length}${opt.length ? ' -> ' + opt.map((c) => c.from).join(', ') : ''}`);
}
