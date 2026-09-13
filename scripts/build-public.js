#!/usr/bin/env node
// build-public.js — pré-build Vercel NON DESTRUCTIF.
// Copie le dossier webapp-core/ vers public/webapp/ pour servir le mode /local.
//
// CONSTRUIRE :
//   - Ne modifie JAMAIS un fichier existant hors public/webapp/.
//   - Supprime puis recrée uniquement public/webapp/ (jamais public/ lui-même).
//   - Whitelist explicite (pas de glob '*' pour éviter d'embarquer des caches).
//
// Aucune dépendance externe : fs.cpSync (Node ≥16.7, dispo sur le runner Vercel).
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'webapp-core');
const DEST = path.join(ROOT, 'public', 'webapp');

// ---- Whitelist des fichiers à copier (chemins relatifs à webapp-core/) ----
const FILES = [
  'index.html',
  'style.css',
  'adapter.js',
  'app-core.js',
  'chat-core.js',
  'campaigns-core.js',
  'relance-core.js',
  'connexions-core.js',
  'README.md',
  'lib/db.js',
  'lib/spintax.js',
  'lib/personalization.js',
  'lib/smartTextGenerator.js',
  'lib/contactsImport.js',
  'lib/manualRelance.js',
  'lib/xlsx.full.min.js',
  'lib/intelligence/human-context-engine.js',
  'lib/intelligence/task-parser.js',
  'lib/intelligence/automation-engine.js',
  'lib/intelligence/action-executor.js',
  'adapters/CONTRACT.md',
  'adapters/browser.js',
];

// ---- Copie ----
fs.rmSync(DEST, { recursive: true, force: true });
for (const f of FILES) {
  const src = path.join(SRC, f);
  const dst = path.join(DEST, f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

console.log('[build-public] ✅ webapp-core → public/webapp (' + FILES.length + ' fichiers copiés)');
