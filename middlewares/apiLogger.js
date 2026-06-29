const crypto = require('crypto');
const bqService = require('../services/bqService');

/**
 * Attaches a request id and writes an API-log row on response finish.
 * Logs go to BigQuery (rg_analytics.api_logs) — an append-only, analyze-later
 * store, NOT MongoDB. Writes are buffered + best-effort and never block the
 * response; when BigQuery is disabled the call is a no-op.
 */
function apiLogger(req, res, next) {
  req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  const start = Date.now();

  res.on('finish', () => {
    const ms = Date.now() - start;
    // Skip noisy/health endpoints.
    if (req.originalUrl === '/healthz' || req.originalUrl === '/readyz') return;

    bqService.logApiRequest({
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      duration_ms: ms,
      user_id: req.user ? String(req.user._id) : null,
      role: req.user ? req.user.role : null,
      ip: req.ip,
      user_agent: req.headers['user-agent'] || null,
      request_id: req.requestId,
    });
  });

  next();
}

module.exports = apiLogger;
