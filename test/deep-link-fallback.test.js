// TEST 4 — Repli automatique en Mode Manuel Express (deep links wa.me/t.me)
//          + attache média autonome sur cooldown/pause.
// -------------------------------------------------------------------------------
// Valide lib/intelligence/deep-link-fallback.js : décision pure, zéro réseau,
// aucune session sollicitée. Les raisons de cooldown sont les valeurs utilisées
// par adapters/sessionRegulator.js (éviction/pause -> la session est disposée,
// un nouvel envoi doit basculer en mode manuel).

'use strict';

const DF = require('../lib/intelligence/deep-link-fallback.js');

let passed = 0;
let failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed += 1; console.log('  ✓ ' + name); }
  else { failed += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(title) { console.log('\n■ ' + title); }

section('DELIVERY NORMALE — session disponible');
{
  const r = DF.resolveDelivery('WHATSAPP', '22664977093', 'Bonjour', { sender: { ok: true } });
  assert('mode DIRECT', r.mode === 'DIRECT', JSON.stringify(r));
  const r2 = DF.resolveDelivery('WHATSAPP', '22664977093', 'Bonjour', {});
  assert('sans sender injecté → DIRECT (parité de comportement par défaut)', r2.mode === 'DIRECT');
}

section('COOLDOWN WHATSAPP — bascule deep-link + attache média');
{
  const r = DF.resolveDelivery('WHATSAPP', '226 64 97 70 93', 'Votre offre arrive', {
    sender: { ok: false, reason: 'FLOOD_WAIT' },
    mediaUrl: '/tmp/offre.jpg',
  });
  assert('mode DEEP_LINK', r.mode === 'DEEP_LINK', JSON.stringify(r));
  assert('raison FLOOD_WAIT remontée', r.reason === 'FLOOD_WAIT', r.reason);
  assert('URL wa.me avec numéro épuré', r.url.indexOf('https://wa.me/22664977093') === 0, r.url);
  assert('texte pré-rempli encodé (espaces → %20)', r.url.indexOf('?text=') !== -1 && r.url.indexOf(' ' ) === -1, r.url);
  assert('attache média autonome conservée dans le payload', r.mediaUrl === '/tmp/offre.jpg' && r.payload.mediaUrl === '/tmp/offre.jpg', JSON.stringify(r.payload));
  assert('le message d\'envoi reste attaché au lien (Mode Manuel Express)', r.payload.text === 'Votre offre arrive');
}

section('ÉVICTION SESSION — raisons du régulateur');
{
  for (const reason of ['SESSION_EVICTED', 'SESSION_PAUSED', 'PAUSED', 'COOLING', 'DISPOSED', 'NOT_CONNECTED']) {
    const r = DF.resolveDelivery('WHATSAPP', '22664977093', 'Rappel', { sender: { ok: false, reason } });
    assert('cooldown ' + reason + ' → DEEP_LINK', r.mode === 'DEEP_LINK' && r.reason === reason, JSON.stringify(r));
  }
  assert('isCooldownReason reconnaît FLOOD_WAIT', DF.isCooldownReason('FLOOD_WAIT'));
  assert('isCooldownReason ne reconnaît pas un truc au hasard', !DF.isCooldownReason('NETWORK_OK'));
}

section('COOLDOWN TELEGRAM — lien t.me');
{
  const r = DF.resolveDelivery('TELEGRAM', '@mon.offre', 'Rappel', { sender: { ok: false, reason: 'FLOOD_WAIT' } });
  assert('mode DEEP_LINK', r.mode === 'DEEP_LINK');
  assert('URL t.me sans le @, texte pré-rempli', r.url === 'https://t.me/mon.offre?text=' + encodeURIComponent('Rappel'), r.url);
  const r2 = DF.resolveDelivery('TELEGRAM', '1234567890', 'Rappel', { sender: { ok: false, reason: 'FLOOD_WAIT' } });
  assert('identifiant numérique : t.me sans pré-remplissage (note explicite)', r2.url === 'https://t.me/1234567890' && !!r2.note, JSON.stringify(r2));
}

section('PAUSE CAMPAGNE programmée — délai re-planifié');
{
  // Cas PAUSE_CAMPAIGN miroir : une tâche reportée (mode_reflect) déclenche la
  // même bascule si le régulateur est en pause au moment du run.
  const r = DF.resolveDelivery('WHATSAPP', '22664977093', 'Relance', { sender: { ok: false, reason: 'PAUSED' }, mediaUrl: 'data:image/png;base64,AAA' });
  assert('mode DEEP_LINK pour une campagne en pause', r.mode === 'DEEP_LINK' && r.reason === 'PAUSED');
  assert('attache média data-URL conservée', r.mediaUrl.indexOf('data:image/png') === 0);
}

console.log('\n========================================');
console.log('RÉSULTATS : ' + passed + ' passés, ' + failed + ' échoués');
console.log('========================================');
process.exitCode = failed ? 1 : 0;