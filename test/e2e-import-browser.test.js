// TEST DE BOUT EN BOUT — chargement des contacts dans la liste d'envoi, dans un VRAI Chrome sur le build OBSCURCI réel,
// contre un VRAI serveur isolé (aucune connexion Firebase/Cloudflare/GitHub, données et licences temporaires).
//   node --test test/e2e-import-browser.test.js
// Ignoré automatiquement si Chrome n'est pas installé.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn, execFileSync } = require('child_process'); const http = require('http');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const hasChrome = fs.existsSync(CHROME);
const ROOT = path.join(__dirname, '..');
const P = (f) => f.split(path.sep).join('/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpGet = (url) => new Promise((res, rej) => http.get(url, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(d)); }).on('error', rej));

test('import de contacts (Excel, collage, CSV) -> liste d\'envoi -> « Lancer l\'envoi », WhatsApp et Telegram', { skip: !hasChrome && 'Chrome absent', timeout: 240000 }, async () => {
  const { launch, client } = require('./helpers/cdp');
  const XLSX = require('xlsx');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-e2e-'));
  const port = 4100 + Math.floor(Math.random() * 400);
  const env = Object.assign({}, process.env, {
    PORT: String(port), ADMIN_PASSWORD: 'e2e', WHATSAPP_ENGINE: 'baileys', LICENSES_PATH: path.join(tmp, 'lic.json'),
    AI_ENGINE_STORAGE_DIR: path.join(tmp, 'data'), AUTH_DIR: path.join(tmp, 'auth'),
    FIREBASE_SERVICE_ACCOUNT_PATH: '', FIREBASE_ADMIN_SECRET: '', CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ADMIN_SECRET: '',
    CLOUDFLARE_LICENSE_URL: '', GITHUB_TOKEN: '', GITHUB_DATA_REPO: '', RENDER_API_KEY: '',
  });
  fs.writeFileSync(env.LICENSES_PATH, '[]');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-dashboard.js')], { stdio: 'ignore' });
  const key = execFileSync(process.execPath, ['-e', "const l=require('./licenses');l.createLicense({expiresAt:Date.now()+864e5,note:'e2e',allowedModules:['whatsapp','telegram']}).then(r=>console.log(r.key))"], { cwd: ROOT, env }).toString().trim().split(/\s+/).pop();
  assert.match(key, /^KEY-/);
  const server = spawn(process.execPath, ['index.js'], { cwd: ROOT, env, stdio: 'ignore' });
  let chrome = null; let c = null;
  try {
    for (let i = 0; i < 40; i++) { try { await httpGet(`http://127.0.0.1:${port}/health`); break; } catch (e) { await sleep(1000); } }
    // fichiers de test : Excel SANS « + » (nombres bruts, comme Excel les stocke), CSV, doublon
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ nom: 'Awa', telephone: 22670111111 }, { nom: 'Ben', telephone: 22670111112 }, { nom: 'Chris', telephone: 22670111113 }, { nom: 'Doublon', telephone: 22670111111 }]), 'F');
    XLSX.writeFile(wb, path.join(tmp, 'c1.xlsx'));
    fs.writeFileSync(path.join(tmp, 'c2.csv'), 'nom;telephone\nEva;22670222221\nFabrice;22670222222\n');
    fs.writeFileSync(path.join(tmp, 't1.csv'), 'Username;Nom;Telephone\n@tg_one;Un;\n@tg_two;Deux;\n;Trois;22670444441\n');

    chrome = await launch(); c = client(chrome.ws); await c.ready;
    await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('DOM.enable');
    const base = `http://127.0.0.1:${port}/`;
    await c.send('Page.navigate', { url: base }); await sleep(2500);
    await c.evaluate(`localStorage.setItem('auth_type','license'); localStorage.setItem('auth_value','${key}'); true`);
    await c.send('Page.navigate', { url: base }); await sleep(5000);
    assert.equal(await c.evaluate(`document.getElementById('app').hidden`), false, 'connecté');
    await c.evaluate(`window.__cap=[]; const of=window.fetch; window.fetch=function(u,o){ let b=null; try{ if(o&&o.body instanceof FormData){ b={}; for(const [k,v] of o.body.entries()) b[k]= typeof v==='string'? v.slice(0,900):'[fichier]'; } }catch(e){} __cap.push({u:String(u).slice(0,80), body:b}); return of.apply(this, arguments); }; true`);
    const upload = async (predicate, file) => { const doc = await c.send('DOM.getDocument', { depth: -1 }); const idx = await c.evaluate(`[...document.querySelectorAll('input[type=file]')].findIndex(e=>${predicate})`); const { nodeIds } = await c.send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: 'input[type=file]' }); await c.send('DOM.setFileInputFiles', { nodeId: nodeIds[idx], files: [P(path.join(tmp, file))] }); };
    const text = (id) => c.evaluate(`document.getElementById('${id}').textContent`);
    const paste = (host, lines) => c.evaluate(`(async()=>{ const h=document.getElementById('${host}'); h.querySelector('textarea').value=${JSON.stringify(lines)}.join(String.fromCharCode(10)); [...h.querySelectorAll('button')].find(b=>/Analyser/.test(b.textContent)).click(); await new Promise(r=>setTimeout(r,2500)); })()`);

    // WHATSAPP — 1) Excel choisi, AUCUN clic sur « Importer »
    await upload(`e.id==='import-file'`, 'c1.xlsx'); await sleep(3000);
    assert.match(await text('campaign-import-count'), /^3 contact\(s\) prêt\(s\)/, 'Excel chargé directement (nombres sans +)');
    // 2) collage (formats variés : +, sans +, 00) — s'ajoute, ne remplace pas
    await paste('wa-adv-import', ['+22670999001', '22670999002', '0022670999003']);
    assert.match(await text('campaign-import-count'), /^6 contact\(s\) prêt\(s\)/);
    // 3) CSV historique — s'ajoute aussi
    await upload(`e.id==='import-file'`, 'c2.csv'); await sleep(3000);
    assert.match(await text('campaign-import-count'), /^8 contact\(s\) prêt\(s\)/);
    assert.equal(await c.evaluate(`document.querySelector('input[name=target-mode][value=import]').checked`), true, 'cible « Liste importée » cochée');
    assert.equal(await c.evaluate(`!document.getElementById('campaign-import-field').hidden`), true);
    assert.equal(await c.evaluate(`document.getElementById('import-body').rows.length`), 8);
    // 4) « Lancer l'envoi » : la requête réellement envoyée contient les 8 numéros
    const sent = JSON.parse(await c.evaluate(`(async()=>{ document.getElementById('campaign-add-text-btn').click(); await new Promise(r=>setTimeout(r,300)); const ta=document.querySelector('[id*=sequence] textarea'); ta.value='Bonjour test'; ta.dispatchEvent(new Event('input',{bubbles:true})); window.__cap.length=0; document.getElementById('send-campaign-btn').click(); await new Promise(r=>setTimeout(r,2500)); const post=window.__cap.find(x=>x.body&&x.body.recipients); return JSON.stringify({ feedback: document.getElementById('campaign-feedback').textContent, recipients: post ? JSON.parse(post.body.recipients).map(x=>x.telephone) : null }); })()`));
    assert.doesNotMatch(sent.feedback, /Importez d'abord|Aucun contact/, sent.feedback);
    assert.deepEqual(sent.recipients.sort(), ['22670111111', '22670111112', '22670111113', '22670222221', '22670222222', '22670999001', '22670999002', '22670999003']);

    // TELEGRAM — collage puis CSV, sans clic « Importer »
    await paste('tg-adv-import', ['22670333331', '22670333332']);
    assert.match(await text('tg-dm-import-count'), /^2 contact\(s\)/);
    await upload(`e.id==='tg-dm-import-file'`, 't1.csv'); await sleep(3000);
    assert.match(await text('tg-dm-import-count'), /^5 contact\(s\)/);
    assert.equal(c.events.filter((e) => e.method === 'Runtime.exceptionThrown').length, 0, 'aucune exception JavaScript');
  } finally {
    try { if (c) c.close(); } catch (e) { /* */ }
    try { if (chrome) chrome.proc.kill(); } catch (e) { /* */ }
    try { server.kill(); } catch (e) { /* */ }
    await sleep(500);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* */ }
  }
});

test('sources difficiles : Excel aux en-têtes inhabituels sur 2 feuilles + PHOTO (OCR) -> même liste d\'envoi par défaut -> lancement', { skip: !hasChrome && 'Chrome absent', timeout: 300000 }, async () => {
  const { launch, client } = require('./helpers/cdp');
  const XLSX = require('xlsx'); const { Resvg } = require('@resvg/resvg-js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-e2e2-'));
  const port = 4500 + Math.floor(Math.random() * 400);
  const env = Object.assign({}, process.env, {
    PORT: String(port), ADMIN_PASSWORD: 'e2e', WHATSAPP_ENGINE: 'baileys', LICENSES_PATH: path.join(tmp, 'lic.json'),
    AI_ENGINE_STORAGE_DIR: path.join(tmp, 'data'), AUTH_DIR: path.join(tmp, 'auth'),
    FIREBASE_SERVICE_ACCOUNT_PATH: '', FIREBASE_ADMIN_SECRET: '', CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ADMIN_SECRET: '',
    CLOUDFLARE_LICENSE_URL: '', GITHUB_TOKEN: '', GITHUB_DATA_REPO: '', RENDER_API_KEY: '',
  });
  fs.writeFileSync(env.LICENSES_PATH, '[]');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-dashboard.js')], { stdio: 'ignore' });
  const key = execFileSync(process.execPath, ['-e', "const l=require('./licenses');l.createLicense({expiresAt:Date.now()+864e5,note:'e2e',allowedModules:['whatsapp','telegram']}).then(r=>console.log(r.key))"], { cwd: ROOT, env }).toString().trim().split(/\s+/).pop();
  const server = spawn(process.execPath, ['index.js'], { cwd: ROOT, env, stdio: 'ignore' });
  let chrome = null; let c = null;
  try {
    for (let i = 0; i < 40; i++) { try { await httpGet(`http://127.0.0.1:${port}/health`); break; } catch (e) { await sleep(1000); } }
    // Excel : en-têtes que l'ancien import ne reconnaissait pas, numéros en colonne 3, deux feuilles
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Client', 'Numéro WhatsApp'], ['Zoé', 22670555551]]), 'Clients');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['#', 'Prénom', 'Mobile pro'], [1, 'Yan', 22670555552]]), 'Prospects');
    XLSX.writeFile(wb, path.join(tmp, 'messy.xlsx'));
    // Photo : capture d'une liste (texte rendu en image, lu ensuite par l'OCR réel)
    const fontFile = path.join(ROOT, 'node_modules', 'dejavu-fonts-ttf', 'ttf', 'DejaVuSans.ttf');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="360"><rect width="900" height="360" fill="white"/>' +
      '<text x="40" y="110" font-family="DejaVu Sans" font-size="54" fill="black">Awa   +226 70 66 66 61</text>' +
      '<text x="40" y="230" font-family="DejaVu Sans" font-size="54" fill="black">Ben   +226 70 66 66 62</text></svg>';
    fs.writeFileSync(path.join(tmp, 'liste.png'), new Resvg(svg, { font: { fontFiles: [fontFile], loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' } }).render().asPng());

    chrome = await launch(); c = client(chrome.ws); await c.ready;
    await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('DOM.enable');
    const base = `http://127.0.0.1:${port}/`;
    await c.send('Page.navigate', { url: base }); await sleep(2500);
    await c.evaluate(`localStorage.setItem('auth_type','license'); localStorage.setItem('auth_value','${key}'); true`);
    await c.send('Page.navigate', { url: base }); await sleep(5000);
    await c.evaluate(`window.__cap=[]; const of=window.fetch; window.fetch=function(u,o){ let b=null; try{ if(o&&o.body instanceof FormData){ b={}; for(const [k,v] of o.body.entries()) b[k]= typeof v==='string'? v.slice(0,900):'[fichier]'; } }catch(e){} __cap.push({u:String(u).slice(0,80), body:b}); return of.apply(this, arguments); }; true`);
    const upload = async (predicate, file) => { const doc = await c.send('DOM.getDocument', { depth: -1 }); const idx = await c.evaluate(`[...document.querySelectorAll('input[type=file]')].findIndex(e=>${predicate})`); assert.ok(idx >= 0, 'champ fichier introuvable'); const { nodeIds } = await c.send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: 'input[type=file]' }); await c.send('DOM.setFileInputFiles', { nodeId: nodeIds[idx], files: [P(path.join(tmp, file))] }); };
    const count = () => c.evaluate(`document.getElementById('campaign-import-count').textContent`);

    // 1) Excel historique (en-têtes inconnus, 2 feuilles), aucun clic « Importer »
    await upload(`e.id==='import-file'`, 'messy.xlsx'); await sleep(3500);
    assert.match(await count(), /^2 contact\(s\) prêt\(s\)/, 'les deux numéros (2 feuilles, en-têtes inhabituels) sont chargés');

    // 2) Photo -> OCR réel -> ajoutée à la MÊME liste
    await upload(`e.accept==='image/*' && !!e.closest('#wa-adv-import')`, 'liste.png');
    await c.evaluate(`(async()=>{ const h=document.getElementById('wa-adv-import'); h.querySelector('textarea').value=''; [...h.querySelectorAll('button')].find(b=>/Analyser/.test(b.textContent)).click(); })()`);
    let n = ''; for (let i = 0; i < 40; i++) { await sleep(1500); n = await count(); if (/^4 contact/.test(n)) break; }
    assert.match(n, /^4 contact\(s\) prêt\(s\)/, 'la photo (OCR) alimente la même liste : ' + n);

    // 3) Lancement : les 4 numéros partent, liste unique par défaut
    const sent = JSON.parse(await c.evaluate(`(async()=>{ document.getElementById('campaign-add-text-btn').click(); await new Promise(r=>setTimeout(r,300)); const ta=document.querySelector('[id*=sequence] textarea'); ta.value='Bonjour'; ta.dispatchEvent(new Event('input',{bubbles:true})); window.__cap.length=0; document.getElementById('send-campaign-btn').click(); await new Promise(r=>setTimeout(r,2500)); const post=window.__cap.find(x=>x.body&&x.body.recipients); return JSON.stringify({ recipients: post ? JSON.parse(post.body.recipients).map(x=>x.telephone) : null }); })()`));
    assert.deepEqual(sent.recipients.sort(), ['22670555551', '22670555552', '22670666661', '22670666662']);
    assert.equal(c.events.filter((e) => e.method === 'Runtime.exceptionThrown').length, 0);
  } finally {
    try { if (c) c.close(); } catch (e) { /* */ }
    try { if (chrome) chrome.proc.kill(); } catch (e) { /* */ }
    try { server.kill(); } catch (e) { /* */ }
    await sleep(500);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* */ }
  }
});
