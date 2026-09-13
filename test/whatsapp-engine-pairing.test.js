// TEST — Moteur Baileys : génération du code d'appairage (requestPairingCode)
// -----------------------------------------------------------------------------
// Reproduit la course identifiée (diagnostic du 2026-09-13) : le moteur
// appelait sock.requestPairingCode() immédiatement après connect()/logout(),
// pendant que la WebSocket était encore CONNECTING. Baileys (sendRawMessage)
// lève alors Boom('Connection Closed') dès que ws.isOpen est faux — un défaut
// de SÉQUENCEMENT de l'appelant, pas un défaut de protocole. Le correctif
// attend l'armement du flux (QR émis OU socket 'open') via waitForStreamReady
// avant d'envoyer la demande, avec retry borné.
//
// Baileys, qrcode-terminal, githubStore et whatsappAuthStore sont simulés via
// require.cache : aucun réseau, aucun disque réel hors du dossier temporaire.
// Le mock de makeWASocket reproduit fidèlement le contrat Baileys qui causait
// la course (requestPairingCode → 'Connection Closed' tant que le flux n'est
// pas armé).

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { EventEmitter } = require('events');
const { mock } = require('node:test');

let passed = 0;
let failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed += 1; console.log('  ✓ ' + name); }
  else { failed += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(title) { console.log('\n■ ' + title); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// --- Horloge d'ordre de séquencement (les timestamps Date.now peuvent
// --- coller sur la même milliseconde, l'ordre monotone est plus fiable).
let order = 0;
function mark() { order += 1; return order; }

// --- Sockets simulés -------------------------------------------------------
const createdSockets = [];
const AUTH_DIR_TEST = fs.mkdtempSync(path.join(os.tmpdir(), 'baileys-pairing-test-'));
process.env.AUTH_DIR = AUTH_DIR_TEST;

function makeMockSocket(config = {}) {
  const sock = {
    ev: new EventEmitter(),
    wsArmed: config.wsArmed === true, // équivalent de ws.isOpen côté Baileys
    failFirstCodeCall: config.failFirstCodeCall === true,
    codeCalls: [],
    requestedAt: null,
    armedAt: null,
    requestPairingCode: async (digits) => {
      sock.codeCalls.push(digits);
      if (sock.failFirstCodeCall && sock.codeCalls.length === 1) {
        // Reproduit Boom('Connection Closed') : la ws n'est pas encore armée.
        throw new Error('Connection Closed');
      }
      if (!sock.wsArmed) {
        throw new Error('Connection Closed');
      }
      sock.requestedAt = mark();
      return '1234-5678-9012-3456';
    },
    logout: async () => {},
    end: () => {},
    sendMessage: async () => ({}),
    groupMetadata: async () => ({}),
    sendPresenceUpdate: async () => ({}),
    arm() {
      sock.wsArmed = true;
      sock.armedAt = mark();
      // Émission du QR sur le socket : le listener principal du moteur mémorise
      // latestQR, la garde waitForStreamReady résout.
      sock.ev.emit('connection.update', { qr: 'FAKEQR' + sock.codeCalls.length });
    },
    close(statusCode) {
      sock.ev.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode } } },
      });
    },
  };
  createdSockets.push(sock);
  return sock;
}

// --- Capacité des modules externes via require.cache ----------------------
function stubModule(absPath, exports) {
  require.cache[absPath] = { id: absPath, filename: absPath, loaded: true, exports };
}

stubModule(require.resolve('@whiskeysockets/baileys'), {
  default: (opts) => makeMockSocket({}),
  useMultiFileAuthState: async () => ({
    state: { creds: { registered: false } },
    saveCreds: async () => {},
  }),
  DisconnectReason: {
    loggedOut: 401,
    connectionClosed: 515,
    connectionLost: 408,
    timedOut: 428,
  },
});
stubModule(require.resolve('qrcode-terminal'), { generate: () => {} });
stubModule(require.resolve(path.join(__dirname, '..', 'adapters', 'whatsappAuthStore.js')), {
  createAuthStore: () => ({
    pushSnapshot: async () => {},
    startPeriodicSync: () => {},
    stopPeriodicSync: () => {},
    clearRemote: async () => {},
    restoreSessionFromRemote: async () => {},
    getStatus: () => ({}),
  }),
});
stubModule(require.resolve(path.join(__dirname, '..', 'githubStore.js')), { enabled: false });

// Le moteur est requis APRÈS la mise en cache des stubs.
const { createSession } = require('../adapters/whatsappEngineBaileys');

function lastSocket() {
  return createdSockets[createdSockets.length - 1];
}

(async () => {
  section('Course séquencement : attente de l’armement du flux avant la demande');

  {
    const session = createSession('pair-test-1');
    // requestPairingCode → connect() (socket frais, non armé). Le mock lève
    // 'Connection Closed' si la demande arrive avant l'armement : l'ancien code
    // échouait ICI. Le correctif attend le QR puis émet la demande.
    const p = session.requestPairingCode('+2250700000001');
    await sleep(15); // laisser connect() finir et la garde s'abonner
    const sock = lastSocket();
    sock.arm(); // 15 ms plus tard : la WebSocket est armée (QR émis)
    const code = await p;
    assert('code d’appairage généré (pas de "Connection Closed")',
      code === '1234-5678-9012-3456', code);
    assert('la demande n’est partie qu’APRÈS l’armement du flux',
      sock.requestedAt !== null && sock.requestedAt > sock.armedAt,
      `requestedAt=${sock.requestedAt} armedAt=${sock.armedAt}`);
    assert('code demandé exactement une fois', sock.codeCalls.length === 1, String(sock.codeCalls.length));
    session.dispose();
  }

  section('Déjà armé : réponse immédiate (fast-path latestQR)');

  {
    const session = createSession('pair-test-2');
    await session.connect();
    const sock = lastSocket();
    sock.arm(); // le flux est armé avant la demande
    const code = await session.requestPairingCode('2250700000002');
    assert('code généré sans attente', code === '1234-5678-9012-3456', code);
    assert('une seule demande de code', sock.codeCalls.length === 1, String(sock.codeCalls.length));
    session.dispose();
  }

  section('Fermeture avant armement : rejet honnête avec le statusCode (401)');

  {
    const session = createSession('pair-test-3');
    const p = session.requestPairingCode('+2250700000003');
    await sleep(15);
    lastSocket().close(401); // WhatsApp révoque pendant la connexion
    let errMsg = null;
    try { await p; } catch (err) { errMsg = err.message; }
    assert('promesse rejetée avec le code 401', /401/.test(errMsg || ''), errMsg);
    assert('pas un "Connection Closed" trompeur', !/Connection Closed/i.test(errMsg || ''), errMsg);
    session.dispose();
  }

  section('Échec de séquencement au moment de l’envoi : retry borné');

  {
    const session = createSession('pair-test-4');
    const p = session.requestPairingCode('+2250700000004');
    await sleep(15);
    const sock = lastSocket();
    sock.failFirstCodeCall = true; // la ws bascule juste entre la garde et l'envoi
    sock.arm();
    const code = await p;
    assert('résolu après un retry', code === '1234-5678-9012-3456', code);
    assert('la demande a été retentée (2 appels)', sock.codeCalls.length === 2, String(sock.codeCalls.length));
    session.dispose();
  }

  section('Échecs répétés sans jamais s’appairer -> régénération d’identité neuve (purge)');

  {
    // Reproduit le blocage constaté en production (tenant "__admin__",
    // 2026-09-13) : un appairage jamais finalisé qui échoue en boucle
    // (QR/code régénéré puis fermeture quasi immédiate, ex. code 428) ne se
    // rétablissait jamais tout seul — les mêmes identifiants (jamais
    // enregistrés) étaient retentés indéfiniment. Après 3 échecs consécutifs
    // enregistrés (donc à la 4e fermeture), le moteur doit purger AUTH_DIR
    // pour forcer une identité d'appareil neuve au prochain essai.
    // Les reconnexions automatiques passent par scheduleReconnect() (délais
    // réels 3s/6s/12s...) : horloge simulée (node:test mock.timers) pour ne
    // pas ralentir la suite, plutôt que de rappeler connect() à la main (ce
    // qui laisserait le minuteur programmé par le close() précédent toujours
    // en attente et fausserait le compteur consecutiveFailures).
    async function flushMicrotasks() { for (let i = 0; i < 8; i += 1) await null; }

    const session = createSession('pair-test-6');
    const authDir = path.join(AUTH_DIR_TEST, 'pair-test-6');

    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await session.connect();
      assert('AUTH_DIR créé au premier connect()', fs.existsSync(authDir));
      fs.writeFileSync(path.join(authDir, 'marker.json'), '{}'); // témoin de l'identité "actuelle"

      lastSocket().close(428); // échec 1 (consecutiveFailures 0 -> 1), reconnexion programmée à 3s
      mock.timers.tick(3_000);
      await flushMicrotasks();

      lastSocket().close(428); // échec 2 (1 -> 2), reconnexion à 6s
      mock.timers.tick(6_000);
      await flushMicrotasks();

      lastSocket().close(428); // échec 3 (2 -> 3), reconnexion à 12s
      mock.timers.tick(12_000);
      await flushMicrotasks();
      assert('identité PAS encore purgée après seulement 3 échecs', fs.existsSync(path.join(authDir, 'marker.json')));

      lastSocket().close(428); // échec 4 : consecutiveFailures valait 3 au moment du test -> purge
      await flushMicrotasks();

      assert('AUTH_DIR purgé après échecs consécutifs sans appairage réussi', !fs.existsSync(authDir));
    } finally {
      mock.timers.reset();
    }
    session.dispose();
  }

  section('Régressions : numéro invalide');

  {
    const session = createSession('pair-test-5');
    let errMsg = null;
    try { await session.requestPairingCode('abc'); } catch (err) { errMsg = err.message; }
    assert('INVALID_PHONE_NUMBER', errMsg === 'INVALID_PHONE_NUMBER', errMsg);
    session.dispose();
  }

  // Nettoyage : les dossiers de session temporaires.
  try { fs.rmSync(AUTH_DIR_TEST, { recursive: true, force: true }); } catch (err) { /* ignore */ }

  console.log('\n========================================');
  console.log('RÉSULTATS : ' + passed + ' passés, ' + failed + ' échoués');
  console.log('========================================');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => { console.error('RUNNER CRASH:', err); process.exit(1); });