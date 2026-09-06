const test = require('node:test');
const assert = require('node:assert/strict');
const { CircuitBreakerState, getFloodWaitMs, isOverloadError } = require('../lib/circuitBreaker');

test('getRetryAfterSeconds: 0 tant que le coupe-circuit est fermé', () => {
  const state = new CircuitBreakerState();
  assert.equal(state.getRetryAfterSeconds(), 0);
});

test('getRetryAfterSeconds: reflète le délai restant pendant une pause de sécurité', () => {
  const state = new CircuitBreakerState();
  state.holdUntil = Date.now() + 65_000;
  state.networkStatus = 'circuit_open';
  const seconds = state.getRetryAfterSeconds();
  // Arrondi au-dessus : entre 60 et 65s selon le temps d'exécution du test.
  assert.ok(seconds > 0 && seconds <= 65, `attendu entre 1 et 65, reçu ${seconds}`);
});

test('getRetryAfterSeconds: retombe à 0 une fois le délai expiré', () => {
  const state = new CircuitBreakerState();
  state.holdUntil = Date.now() - 1000;
  state.networkStatus = 'circuit_open';
  assert.equal(state.getRetryAfterSeconds(), 0);
  assert.equal(state.isHeld(), false);
});

test('recordOverloadFailure: respecte le FLOOD_WAIT chiffré de Telegram plutôt que le backoff générique', () => {
  const state = new CircuitBreakerState();
  const err = new Error('A wait of 120 seconds is required (FLOOD_WAIT_120)');
  const backoffMs = state.recordOverloadFailure(err);
  assert.equal(backoffMs, 120_000);
  assert.equal(state.getRetryAfterSeconds(), 120);
});

test('getFloodWaitMs: extrait la durée depuis err.seconds en priorité', () => {
  assert.equal(getFloodWaitMs({ seconds: 30 }), 30_000);
});

test('getFloodWaitMs: null pour une erreur sans FLOOD_WAIT chiffré', () => {
  assert.equal(getFloodWaitMs(new Error('ECONNRESET')), null);
});

test('isOverloadError: détecte un 429 explicite et un message FLOOD', () => {
  assert.equal(isOverloadError({ status: 429 }), true);
  assert.equal(isOverloadError(new Error('FLOOD_WAIT_10')), true);
  assert.equal(isOverloadError(new Error('Numéro invalide')), false);
});
