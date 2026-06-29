const env = require('../config/env');

/**
 * Tiny structured logger. JSON in prod, readable in dev.
 * Dependency-free so the app boots without optional packages.
 */
function emit(level, msg, meta) {
  const base = { t: new Date().toISOString(), level, instance: env.instanceId, msg };
  const record =
    meta && typeof meta === 'object'
      ? { ...base, ...meta }
      : meta !== undefined
        ? { ...base, detail: meta }
        : base;

  if (env.isProd) {
    process.stdout.write(JSON.stringify(record) + '\n');
  } else {
    const tag = { info: 'i', warn: '!', error: 'x', debug: '.' }[level] || '*';
    const extra = meta !== undefined ? ` ${typeof meta === 'string' ? meta : JSON.stringify(meta)}` : '';
    process.stdout.write(`[${tag}] ${msg}${extra}\n`);
  }
}

module.exports = {
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
  debug: (msg, meta) => env.isDev && emit('debug', msg, meta),
};
