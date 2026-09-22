#!/usr/bin/env node
// Génère public/ui-v2.generated.css : surcharges du thème sombre (ui-v2.css) pour TOUTES les règles claires de public/dashboard.html (fonds blancs / pastel, textes sombres,
// bordures claires). Lit les blocs <style>, retrouve chaque règle qui pose une couleur claire/sombre « du thème clair » et émet la règle sombre équivalente, avec le
// MÊME sélecteur (donc la même portée). Chaque règle émise est SCOPÉE à ":root:not([data-theme=\"light\"]) <sélecteur>" : en thème CLAIR (choisi par
// l'utilisateur dans 🎨 Apparence), ces surcharges ne s'appliquent jamais et les couleurs claires d'origine de dashboard.html s'affichent normalement.
// À relancer quand le CSS du dashboard change :   node scripts/gen-ui-v2-overrides.js
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'public', 'dashboard.html');
const OUT = path.join(__dirname, '..', 'public', 'ui-v2.generated.css');

const html = fs.readFileSync(SRC, 'utf8');
const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');

// --- petit lecteur de règles (profondeur : @media aplatis, @keyframes / @font-face ignorés)
function rules(text) {
  const out = []; let i = 0;
  function block(start) { let d = 0; for (let j = start; j < text.length; j += 1) { if (text[j] === '{') d += 1; else if (text[j] === '}') { d -= 1; if (d === 0) return j; } } return text.length; }
  while (i < text.length) {
    const open = text.indexOf('{', i); if (open < 0) break;
    const head = text.slice(i, open).trim(); const close = block(open);
    if (/^@media/i.test(head)) { const inner = rules(text.slice(open + 1, close)); inner.forEach((r) => out.push(Object.assign({}, r, { media: head }))); }
    else if (!/^@/.test(head)) out.push({ selector: head, body: text.slice(open + 1, close), media: null });
    i = close + 1;
  }
  return out;
}

function parseColor(v) {
  v = String(v).trim().toLowerCase();
  let m = v.match(/^#([0-9a-f]{3})$/); if (m) return m[1].split('').map((h) => parseInt(h + h, 16));
  m = v.match(/^#([0-9a-f]{6})/); if (m) return [0, 2, 4].map((k) => parseInt(m[1].slice(k, k + 2), 16));
  m = v.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/); if (m) return [+m[1], +m[2], +m[3]];
  if (v === 'white') return [255, 255, 255]; if (v === 'black') return [0, 0, 0];
  return null;
}
const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
function hueOf([r, g, b]) {
  const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); const d = mx - mn; if (d < 18) return 'gray';
  let h; if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h = (h * 60 + 360) % 360;
  if (h < 20 || h >= 335) return 'red'; if (h < 70) return 'amber'; if (h < 170) return 'green'; if (h < 260) return 'blue'; return 'purple';
}
const TINT = { red: 'rgba(248,113,113,.12)', amber: 'rgba(251,191,36,.12)', green: 'rgba(52,227,155,.11)', blue: 'rgba(96,165,250,.12)', purple: 'rgba(124,92,255,.14)', gray: 'var(--surface-2)' };
const TEXT = { red: '#fca5a5', amber: '#fcd34d', green: '#5eeac0', blue: '#93c5fd', purple: '#c4b8ff', gray: 'var(--text-2)' };

const seen = new Set(); const emit = [];
for (const r of rules(css)) {
  const sels = r.selector; const decls = r.body.split(';').map((d) => d.trim()).filter(Boolean); const add = [];
  for (const d of decls) {
    const idx = d.indexOf(':'); if (idx < 0) continue; const prop = d.slice(0, idx).trim().toLowerCase(); const val = d.slice(idx + 1).trim();
    const bgMatch = prop.startsWith('background') && !/gradient|url\(/.test(val) ? val.match(/#[0-9a-f]{3,6}\b|rgba?\([^)]*\)|\bwhite\b/i) : null;
    if (bgMatch) {
      const c = parseColor(bgMatch[0]); if (!c) continue; const L = lum(c);
      if (/^rgba/i.test(bgMatch[0]) && parseFloat(bgMatch[0].split(',')[3]) < 0.5) continue; // déjà translucide
      if (L > 0.78) add.push(`background: ${hueOf(c) === 'gray' ? 'var(--surface-2)' : TINT[hueOf(c)]} !important`);
      continue;
    }
    if (prop === 'color') {
      const m = val.match(/#[0-9a-f]{3,6}\b|rgba?\([^)]*\)/i); if (!m) continue; const c = parseColor(m[0]); if (!c) continue;
      if (lum(c) < 0.42) add.push(`color: ${TEXT[hueOf(c)]} !important`);
      continue;
    }
    if (/^border(-top|-bottom|-left|-right)?(-color)?$/.test(prop)) {
      const m = val.match(/#[0-9a-f]{3,6}\b|rgba?\([^)]*\)/i); if (!m) continue; const c = parseColor(m[0]); if (!c) continue;
      if (lum(c) > 0.7) add.push(`border-color: var(--border) !important`);
      else if (hueOf(c) === 'green' && lum(c) < 0.35) add.push('border-color: rgba(52,227,155,.45) !important');
      continue;
    }
  }
  if (!add.length) continue;
  // Scopé au thème SOMBRE uniquement : en clair, l'utilisateur retrouve les couleurs d'origine de dashboard.html (déjà claires), sans neutralisation.
  const scopedSel = sels.split(',').map((s) => `:root:not([data-theme="light"]) ${s.trim()}`).join(', ');
  const rule = `${scopedSel} { ${[...new Set(add)].join('; ')}; }`; const key = (r.media || '') + rule; if (seen.has(key)) continue; seen.add(key);
  emit.push(r.media ? `${r.media} { ${rule} }` : rule);
}
fs.writeFileSync(OUT, `/* GÉNÉRÉ par scripts/gen-ui-v2-overrides.js — ne pas éditer à la main (relancer le script). Scopé au thème sombre : voir data-theme sur <html>. */\n${emit.join('\n')}\n`);
console.log(`${emit.length} surcharges écrites dans ${path.relative(process.cwd(), OUT)}`);
