#!/usr/bin/env node
// SYNCHRONISATION DU CATALOGUE AGENCY AGENTS — scripts/sync-agency-agents.js
// ---------------------------------------------------------------------------
// Récupère le dépôt OFFICIEL https://github.com/msitarzewski/agency-agents (jamais un fork), valide chaque fichier d'agent
// (frontmatter name/description) et remplace ai-engine/agents/catalog/ de façon ATOMIQUE : le catalogue actuel n'est écrasé que si
// le nouveau est valide (au moins MIN_AGENTS agents) ; sinon l'ancien reste en place (Cyrus ne casse jamais).
// Écrit catalog.lock.json (commit source, date, licence, nombre d'agents par division).
//   node scripts/sync-agency-agents.js                 # clone superficiel du dépôt officiel puis synchronise
//   node scripts/sync-agency-agents.js --from <dossier> # synchronise depuis un clone local déjà présent (aucun réseau)
//   node scripts/sync-agency-agents.js --dry-run       # valide sans rien écrire
// Les agents sont des DONNÉES (prompts de spécialistes) : ils ne s'exécutent jamais, ne touchent aucun outil, et restent sous la tutelle
// du Service Orchestrateur (voir ai-engine/agents/).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const OFFICIAL = 'https://github.com/msitarzewski/agency-agents.git';
const MIN_AGENTS = 100;
const ROOT = path.join(__dirname, '..');
const DEST = path.join(ROOT, 'ai-engine', 'agents', 'catalog');

function frontmatter(text) {
  const m = String(text).replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) { const k = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/); if (k) out[k[1]] = k[2].replace(/^["']|["']$/g, '').trim(); }
  return out;
}

function collect(src) {
  const divisions = JSON.parse(fs.readFileSync(path.join(src, 'divisions.json'), 'utf8')).divisions;
  const agents = []; const rejected = [];
  for (const div of Object.keys(divisions)) {
    const dir = path.join(src, div);
    if (!fs.existsSync(dir)) continue;
    // Récursif : certaines divisions (ex. game-development) rangent leurs agents dans des sous-dossiers.
    const walk = (d, rel) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        if (ent.isDirectory()) { walk(path.join(d, ent.name), path.join(rel, ent.name)); continue; }
        if (!/\.md$/.test(ent.name)) continue;
        const text = fs.readFileSync(path.join(d, ent.name), 'utf8');
        const fm = frontmatter(text);
        if (!fm || !fm.name || !fm.description) { if (fm) rejected.push(path.join(div, rel, ent.name)); continue; } // sans frontmatter d'agent : playbook, ignoré
        agents.push({ division: div, file: path.join(rel, ent.name), text });
      }
    };
    walk(dir, '');
  }
  return { divisions, agents, rejected };
}

function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const fromIdx = args.indexOf('--from');
  let src = fromIdx >= 0 ? path.resolve(args[fromIdx + 1]) : null;
  let tmp = null;
  if (!src) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agency-agents-'));
    execFileSync('git', ['clone', '--depth', '1', OFFICIAL, tmp], { stdio: 'inherit' });
    src = tmp;
  }
  try {
    const { divisions, agents, rejected } = collect(src);
    if (agents.length < MIN_AGENTS) throw new Error(`Catalogue invalide (${agents.length} agents < ${MIN_AGENTS}) : l'ancien catalogue est conservé.`);
    let commit = 'inconnu';
    try { commit = execFileSync('git', ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch (e) { /* pas un dépôt git */ }
    const perDivision = {}; agents.forEach((a) => { perDivision[a.division] = (perDivision[a.division] || 0) + 1; });
    const lock = { source: OFFICIAL.replace(/\.git$/, ''), commit, syncedAt: new Date().toISOString(), license: 'MIT (AgentLand Contributors)', agents: agents.length, perDivision, rejected };
    console.log(`Catalogue valide : ${agents.length} agents, ${Object.keys(perDivision).length} divisions${rejected.length ? `, ${rejected.length} fichier(s) rejeté(s)` : ''} (commit ${commit.slice(0, 10)}).`);
    if (dry) return;
    const staging = `${DEST}.staging`;
    fs.rmSync(staging, { recursive: true, force: true });
    for (const a of agents) { const out = path.join(staging, a.division, a.file); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, a.text); }
    fs.writeFileSync(path.join(staging, 'divisions.json'), JSON.stringify(divisions, null, 2));
    fs.copyFileSync(path.join(src, 'LICENSE'), path.join(staging, 'LICENSE'));
    fs.writeFileSync(path.join(staging, 'catalog.lock.json'), JSON.stringify(lock, null, 2));
    // Bascule atomique : l'ancien catalogue est mis de côté, puis supprimé seulement après le succès du renommage.
    const backup = `${DEST}.previous`;
    fs.rmSync(backup, { recursive: true, force: true });
    if (fs.existsSync(DEST)) fs.renameSync(DEST, backup);
    fs.renameSync(staging, DEST);
    fs.rmSync(backup, { recursive: true, force: true });
    console.log(`Catalogue installé dans ${path.relative(ROOT, DEST)}.`);
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try { main(); } catch (err) { console.error(`Synchronisation annulée : ${err.message}`); process.exit(1); }
