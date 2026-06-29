/* eslint-disable no-console */
// One-shot backfill for the new presence model.
//
// Presence is now DERIVED: effective online = availabilityPreference (saved
// toggle intent) AND a live socket connection. Older docs have no
// `availabilityPreference`, so:
//   1) Seed it from the legacy `isOnline` flag (preserve their last intent).
//   2) Reset the DERIVED fields to offline — no sockets are connected during a
//      migration, so nobody is actually reachable. They re-derive to online on
//      their next socket connect (which restores the preference we just seeded).
//
// Safe to run multiple times (idempotent).
//
//   node scripts/backfillAvailabilityPreference.js
require('dotenv').config();
const { connectDB, disconnectDB } = require('../config/db');
const AstrologerProfile = require('../models/AstrologerProfile');

async function run() {
  await connectDB();
  console.log('Backfilling availabilityPreference...');

  // 1) Seed intent from legacy isOnline where the new field is missing.
  const seeded = await AstrologerProfile.updateMany(
    { availabilityPreference: { $exists: false } },
    [{ $set: { availabilityPreference: { $ifNull: ['$isOnline', false] } } }]
  );
  console.log(`  seeded availabilityPreference on ${seeded.modifiedCount} profile(s)`);

  // 2) Reset derived presence to offline (no live sockets at migration time).
  //    Don't touch anyone mid-session ('busy') — let the session end clear it.
  const reset = await AstrologerProfile.updateMany(
    { currentCallStatus: { $ne: 'busy' } },
    { $set: { isOnline: false, currentCallStatus: 'offline' } }
  );
  console.log(`  reset derived presence on ${reset.modifiedCount} profile(s)`);

  await disconnectDB();
  console.log('Done.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
