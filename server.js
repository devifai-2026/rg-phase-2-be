const http = require('http');
const app = require('./app');
const env = require('./config/env');
const logger = require('./utils/logger');
const { connectDB, disconnectDB } = require('./config/db');
const { initSocket } = require('./websockets');
const jobWorker = require('./workers/jobWorker');
const fcmService = require('./services/fcmService');
const bqService = require('./services/bqService');


let server;

/**
 * Clear presence rows this instanceId owned before the current process started.
 * Best-effort and never blocks boot: the Redis leases expire on their own within
 * env.socket.leaseTtlSec, so this only shortens the window from ~20s to ~0.
 */
function resetPresenceOnBoot() {
  const { forEachTenant } = require('./utils/forEachTenant');
  const presenceService = require('./services/presenceService');
  return forEachTenant((ctx) => presenceService.resetInstancePresence(ctx, env.instanceId))
    .catch((e) => logger.warn('boot presence reset failed', e.message));
}

async function start() {
  await connectDB();

  server = http.createServer(app);
  // AWAITED: initSocket connects the Redis adapter. Listening before it resolves
  // binds early sockets to the in-memory adapter and then swaps the adapter out
  // from under them, silently breaking cross-instance delivery for those clients.
  const io = await initSocket(server);
  app.set('io', io);

  fcmService.init();
  bqService.start(); // periodic flush of API logs / analytics / notification events
  jobWorker.start();

  // Seed the LLM prompts into the DB (idempotent) so the DB is the source of
  // truth — code defaults only seed/fallback. Admin edits in "Danger Prompts"
  // override them and survive restarts. Best-effort: never block boot.
  require('./services/promptService').seedPrompts().catch((e) => logger.warn('prompt seed failed', e.message));

  // ── SaaS control-plane boot (only when multi-tenant is enabled) ──
  // Connects the control DB and seeds the built-in plans (incl. free_trial).
  // Guarded so single-tenant deploys never touch the control plane.
  if (env.saas.enabled) {
    const { connectControlDB } = require('./config/controlDb');
    connectControlDB()
      .then(() => require('./services/control/planService').seedPlans())
      .then(() => logger.info('SaaS control-plane ready'))
      // Boot-time presence reset needs the tenant list, so it chains AFTER the
      // control DB is up. A crash/SIGKILL leaves astrologers marked online with
      // dead sockets; without this the reconcile sweep wouldn't notice for 60-150s.
      .then(() => resetPresenceOnBoot())
      .catch((e) => logger.error('SaaS control-plane boot failed', e.message));
  } else {
    resetPresenceOnBoot();
  }

  server.listen(env.port, () => {
    logger.info(`Server listening on :${env.port}`, { env: env.nodeEnv, docs: `http://localhost:${env.port}/api-docs` });
  });
}

// ── Graceful shutdown (drain sockets + jobs before exit) ──
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.warn(`Received ${signal}, shutting down...`);
  try {
    if (server) {
      const io = app.get('io');
      if (io) {
        io.emit('server-draining', { instance: env.instanceId });
        io.close();
      }
      await new Promise((resolve) => server.close(resolve));
    }
    await jobWorker.stop();
    await bqService.stop(); // final flush of buffered rows
    await disconnectDB();
  } catch (e) {
    logger.error('Shutdown error', e.message);
  } finally {
    process.exit(0);
  }
}

['SIGTERM', 'SIGINT'].forEach((sig) => process.on(sig, () => shutdown(sig)));
process.on('unhandledRejection', (err) => logger.error('Unhandled rejection', err && err.message));
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', err && err.message);
});

start().catch((err) => {
  logger.error('Failed to start server', err.message);
  process.exit(1);
});
