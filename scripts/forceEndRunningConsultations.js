/* eslint-disable no-console */
// Force-end any RUNNING consultations (and optionally live broadcasts) — a
// reusable rescue tool for when a 1-on-1 session gets stuck in 'accepted' or
// 'ongoing' server-side (e.g. both apps killed mid-call) and keeps the seeker's
// wallet locked / the astrologer flagged busy.
//
// It does NOT brute-force the status: it routes each stuck session through the
// real sessionService.endSession() teardown so billing settles correctly, the
// unspent wallet lock is released, the astrologer is credited + freed (presence
// recomputed), recording stops, and BOTH apps get the 'session-ended' event.
//
// 'accepted' (room open, never billed) ends with ₹0 — endSession derives
// durationSec from startedAt||endedAt, so an un-started session bills nothing.
//
// Usage (preview first, ALWAYS):
//   node scripts/forceEndRunningConsultations.js --dry-run
//   node scripts/forceEndRunningConsultations.js                 # ends consultations
//   node scripts/forceEndRunningConsultations.js --include-live  # also ends live broadcasts
//
// Multi-tenant: pass --slug <tenant> to target ONE tenant's DB (the teardown —
// billing settle, wallet release/credit — then runs against that tenant's DB, as
// it must). Without --slug it uses the default connection (single-tenant mode).
//   node scripts/forceEndRunningConsultations.js --slug astrotalk
//
// Safe + idempotent: endSession() no-ops on already-terminal sessions. Does NOT
// delete any history/billing records — it only TRANSITIONS stuck sessions to
// 'completed'. Run on the VM with the service env loaded:
//   set -a; source /etc/rg-backend.env; set +a; node scripts/forceEndRunningConsultations.js --slug astrotalk
require('dotenv').config();
const { connectDB, disconnectDB } = require('../config/db');
const { contextForSlug, defaultContext } = require('../utils/tenantContext');
const sessionService = require('../services/sessionService');
const liveService = require('../services/liveService');

const DRY = process.argv.includes('--dry-run');
const INCLUDE_LIVE = process.argv.includes('--include-live');
const slugIdx = process.argv.indexOf('--slug');
const SLUG = slugIdx !== -1 ? process.argv[slugIdx + 1] : null;
const RUNNING = ['accepted', 'ongoing'];

async function run() {
  await connectDB();
  // Build the ctx whose DB the teardown must run against. With --slug we open the
  // tenant connection; otherwise the default connection (single-tenant).
  const ctx = SLUG ? await contextForSlug(SLUG) : defaultContext();
  const Session = ctx.model('Session');
  console.log(DRY ? '\n=== DRY RUN (no writes) ===\n' : '\n=== FORCE-ENDING RUNNING CONSULTATIONS ===\n');
  console.log(`Tenant: ${SLUG || '(default)'}\n`);

  const running = await Session.find({ status: { $in: RUNNING } })
    .select('sessionId type status startedAt acceptedAt user astrologer')
    .lean();
  console.log(`Running consultations (accepted|ongoing): ${running.length}`);
  for (const s of running) {
    const tag = `${s.sessionId} (${s.type}, ${s.status}, ${s.startedAt ? 'billed' : 'never-started'})`;
    if (DRY) {
      console.log(`  would end: ${tag}`);
      continue;
    }
    try {
      // 'admin_cleanup' would need to be in the endReason enum; use 'hangup' (an
      // accepted reason) so the Session.endReason validation passes. The summary
      // log records that this was a manual sweep.
      const summary = await sessionService.endSession(ctx, { sessionId: s.sessionId, endReason: 'hangup' });
      console.log(`  ended: ${tag} → billed ${summary.billedMinutes}min, ₹${summary.totalAmount}`);
    } catch (e) {
      console.log(`  FAILED: ${tag} → ${e.message}`);
    }
  }

  if (INCLUDE_LIVE) {
    const LiveSession = ctx.model('LiveSession');
    const lives = await LiveSession.find({ status: 'live' }).select('_id astrologer title').lean();
    console.log(`\nLive broadcasts (status:'live'): ${lives.length}`);
    for (const l of lives) {
      if (DRY) { console.log(`  would end live: ${l._id} ${JSON.stringify(l.title)}`); continue; }
      try {
        await liveService.endLive(ctx, { liveSessionId: String(l._id), astrologerUserId: l.astrologer, reason: 'manual' });
        console.log(`  ended live: ${l._id}`);
      } catch (e) {
        console.log(`  FAILED live ${l._id}: ${e.message}`);
      }
    }
  }

  console.log('\nDone.');
  await disconnectDB();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
