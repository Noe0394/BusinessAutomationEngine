// Pilote CDP minimal (test manuel, non commité) : Chrome headless réel + serveur local.
const { spawn } = require('child_process'); const http = require('http'); const WebSocket = require('ws'); const os = require('os'); const path = require('path'); const fs = require('fs');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333 + Math.floor(Math.random() * 500);
const get = (url) => new Promise((res, rej) => http.get(url, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(d)); }).on('error', rej));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function launch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-cdp-'));
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, '--no-first-run', '--disable-gpu', '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { const list = JSON.parse(await get(`http://127.0.0.1:${PORT}/json`)); const page = list.find((t) => t.type === 'page'); if (page) return { proc, ws: page.webSocketDebuggerUrl }; } catch (e) { /* pas prêt */ } await sleep(500); }
  throw new Error('Chrome ne démarre pas');
}
function client(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map(); const events = [];
  ws.on('message', (m) => { const d = JSON.parse(m); if (d.id && pending.has(d.id)) { const { res, rej } = pending.get(d.id); pending.delete(d.id); d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result); } else if (d.method) events.push(d); });
  const send = (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ready = new Promise((r) => ws.on('open', r));
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
  return { ready, send, evaluate, events, close: () => ws.close() };
}
module.exports = { launch, client, sleep };
