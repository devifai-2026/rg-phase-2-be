/* eslint-disable no-console */
// One-shot backfill for the connectivity-based presence model.
//
// Effective online is now: availabilityPreference AND the device proved
// connectivity within env.presence.reachableTtlMs (via socket heartbeat or an
// FCM presence-ping ACK), tracked by the new `lastReachableAt` field.
//
// Older docs have no `lastReachableAt`. Without a seed, every currently-online
// astrologer would read as unreachable → offline until their next heartbeat /
// the next probe cycle. To avoid a visible flap on deploy, seed lastReachableAt
// = now for astrologers whose toggle is ON, giving their device a full TTL grace
// window to send its first heartbeat/ping. Genuinely-offline (no-internet)
// devices simply won't refresh it and will flip offline once the window lapses —
// which is the intended behaviour.
//
// Safe to run multiple times (idempotent-ish: it just refreshes the grace clock).
//
//   node scripts/backfillReachability.js
require('dotenv').config();
const { connectDB, disconnectDB } = require('../config/db');
const AstrologerProfile = require('../models/AstrologerProfile');

async function run() {
  await connectDB();
  console.log('Backfilling lastReachableAt for toggled-on astrologers...');

  const res = await AstrologerProfile.updateMany(
    { availabilityPreference: true },
    { $set: { lastReachableAt: new Date() } }
  );
  console.log(`  seeded lastReachableAt on ${res.modifiedCount} profile(s)`);

  await disconnectDB();
  console.log('Done.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
