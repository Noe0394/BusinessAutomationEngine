'use strict';

const MAX_BUCKETS = 500;
const startedAt = new Date().toISOString();
const buckets = new Map();

function chunkBytes(chunk, encoding) {
  if (chunk == null) return 0;
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (typeof chunk === 'string') return Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : 'utf8');
  return 0;
}

function routeKey(req) {
  if (!req.route || req.route.path == null) return 'unmatched';
  return `${req.baseUrl || ''}${String(req.route.path)}`.slice(0, 180);
}

function middleware(req, res, next) {
  if (req.path === '/api/admin/performance-metrics') return next();

  const started = process.hrtime.bigint();
  let requestBodyBytes = 0;
  let responseBodyBytes = 0;
  req.on('data', (chunk) => { requestBodyBytes += chunkBytes(chunk); });

  const write = res.write;
  const end = res.end;
  res.write = function measuredWrite(chunk, encoding) {
    responseBodyBytes += chunkBytes(chunk, encoding);
    return write.apply(this, arguments);
  };
  res.end = function measuredEnd(chunk, encoding) {
    responseBodyBytes += chunkBytes(chunk, encoding);
    return end.apply(this, arguments);
  };

  let recorded = false;
  const record = (completed) => {
    if (recorded) return;
    recorded = true;
    const route = routeKey(req);
    const key = `${req.method} ${route} ${res.statusCode}`;
    let bucket = buckets.get(key);
    if (!bucket && buckets.size < MAX_BUCKETS) {
      bucket = { method: req.method, route, status: res.statusCode, requests: 0, requestBodyBytes: 0, responseBodyBytes: 0, durationMs: 0, incomplete: 0 };
      buckets.set(key, bucket);
    }
    if (!bucket) return;
    bucket.requests += 1;
    bucket.requestBodyBytes += requestBodyBytes;
    bucket.responseBodyBytes += responseBodyBytes;
    bucket.durationMs += Number(process.hrtime.bigint() - started) / 1e6;
    if (!completed) bucket.incomplete += 1;
  };
  res.once('finish', () => record(true));
  res.once('close', () => record(false));
  next();
}

function privateApiRevalidation(req, res, next) {
  if (req.method === 'GET' && req.path.startsWith('/api/') && !res.hasHeader('Cache-Control')) {
    // Express ETags remain enabled by default. Browsers revalidate private API
    // responses; shared caches must never store them.
    res.setHeader('Cache-Control', 'private, no-cache');
  }
  next();
}

function snapshot() {
  const byRoute = Array.from(buckets.values()).map((bucket) => Object.assign({}, bucket));
  const totals = byRoute.reduce((acc, bucket) => {
    acc.requests += bucket.requests;
    acc.requestBodyBytes += bucket.requestBodyBytes;
    acc.responseBodyBytes += bucket.responseBodyBytes;
    acc.durationMs += bucket.durationMs;
    acc.incomplete += bucket.incomplete;
    return acc;
  }, { requests: 0, requestBodyBytes: 0, responseBodyBytes: 0, durationMs: 0, incomplete: 0 });
  return { startedAt, capturedAt: new Date().toISOString(), totals, byRoute };
}

module.exports = { middleware, privateApiRevalidation, snapshot };
