'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const compression = require('compression');
const zlib = require('node:zlib');
const http = require('node:http');
const metrics = require('../lib/httpTrafficMetrics');

function request(port, { path = '/api/data', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

async function withServer(handler, run) {
  const app = express();
  app.use(metrics.middleware);
  app.use(compression({ threshold: 1024, filter: (req, res) => {
    if (String(res.getHeader('Content-Type') || '').startsWith('text/event-stream')) return false;
    return compression.filter(req, res);
  } }));
  app.use(metrics.privateApiRevalidation);
  handler(app);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await run(server.address().port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('private API GETs revalidate and ETags do not cross account responses', async () => {
  await withServer((app) => app.get('/api/data', (req, res) => {
    res.json({ account: req.headers['x-test-account'], value: 'stable' });
  }), async (port) => {
    const accountA = await request(port, { headers: { 'x-test-account': 'A' } });
    assert.equal(accountA.status, 200);
    assert.equal(accountA.headers['cache-control'], 'private, no-cache');
    assert.ok(accountA.headers.etag);

    const accountB = await request(port, { headers: { 'x-test-account': 'B', 'if-none-match': accountA.headers.etag } });
    assert.equal(accountB.status, 200);
    assert.equal(JSON.parse(accountB.body.toString()).account, 'B');

    const unchangedA = await request(port, { headers: { 'x-test-account': 'A', 'if-none-match': accountA.headers.etag } });
    assert.equal(unchangedA.status, 304);
    assert.equal(unchangedA.body.length, 0);
  });
});

test('JSON responses over the threshold use gzip and metrics count compressed bytes', async () => {
  let observed;
  await withServer((app) => app.get('/api/large', (_req, res) => {
    res.json({ payload: 'cyrus-'.repeat(3000) });
  }), async (port) => {
    const response = await request(port, { path: '/api/large', headers: { 'accept-encoding': 'gzip' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], 'gzip');
    const inflated = zlib.gunzipSync(response.body).toString();
    assert.ok(inflated.length > 16000);
    await new Promise((resolve) => setImmediate(resolve));
    observed = metrics.snapshot().byRoute.find((row) => row.route === '/api/large' && row.status === 200);
  });
  assert.ok(observed);
  assert.ok(observed.responseBodyBytes < Buffer.byteLength(JSON.stringify({ payload: 'cyrus-'.repeat(3000) })));
});

test('compression skips server-sent events', async () => {
  await withServer((app) => app.get('/api/events', (_req, res) => {
    res.type('text/event-stream');
    res.end(`data: ${'x'.repeat(1500)}\n\n`);
  }), async (port) => {
    const response = await request(port, { path: '/api/events', headers: { 'accept-encoding': 'gzip' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], undefined);
  });
});
