#!/usr/bin/env node
// build-extension-zip.js — empaquette browser-extension/ en un .zip téléchargeable
// directement depuis le site (public/cyrus-extension.zip), pour que l'utilisateur
// n'ait jamais besoin d'aller cloner/parcourir le dépôt Git pour l'installer.
//
// Écrivain ZIP minimal, MÉTHODE STORED (non compressée) — aucune dépendance
// externe (pas de zlib deflate ici : la compression n'apporte rien pour ~15 Ko
// de JS/PNG et complexifierait l'implémentation pour un gain négligeable).
// Whitelist explicite : ne JAMAIS inclure extension-key.pem (clé privée,
// jamais committée, voir .gitignore) ni extension-id.txt (inutile à l'usager).
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'browser-extension');
const OUT = path.join(ROOT, 'public', 'cyrus-extension.zip');

const FILES = [
  'manifest.json',
  'background.js',
  'content-relay.js',
  'injected-bridge.js',
  'injected-bridge-telegram.js',
  'README.md',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
];

// ---- CRC-32 (table calculée une fois) ----
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ---- Écriture ZIP (STORED) ----
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; }

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const localHeader = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(nameBuf.length), u16(0),
      nameBuf,
    ]);
    localParts.push(localHeader, data);

    const centralHeader = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(offset),
      nameBuf,
    ]);
    centralParts.push(centralHeader);

    offset += localHeader.length + data.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const centralStart = offset;
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0),
    u16(entries.length), u16(entries.length),
    u32(centralDir.length), u32(centralStart),
    u16(0),
  ]);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

const entries = FILES.map((relPath) => ({
  name: relPath,
  data: fs.readFileSync(path.join(SRC, relPath)),
}));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, buildZip(entries));
console.log('[build-extension-zip] ✅ ' + entries.length + ' fichiers → public/cyrus-extension.zip (' + fs.statSync(OUT).size + ' octets)');
