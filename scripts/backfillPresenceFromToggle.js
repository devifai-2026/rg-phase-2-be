/* eslint-disable no-console */
// One-shot backfill for the TOGGLE-AS-TRUTH presence model.
//
// Presence is now derived from the astrologer's availability TOGGLE alone — a
// live socket is no longer required to be shown online (so killing/backgrounding
// the app does not flip them offline). Under the OLD model (online = toggle AND
// live socket), astrologers who had toggled ON but whose socket had dropped were
// stranded with isOnline=false in the DB, so the USER app showed them OFFLINE
// while their OWN app showed online. This realigns the stored derived fields with
// the toggle so users see the correct status immediately.
//
//   isOnline := availabilityPreference
//   currentCallStatus := keep 'busy' if currently busy, else available/offline
//
// Idempotent. Does NOT touch anyone mid-session (currentCallStatus 'busy' kept).
//
//   node scripts/backfillPresenceFromToggle.js
require('dotenv').config();
const { connectDB, disconnectDB } = require('../config/db');
const AstrologerProfile = require('../models/AstrologerProfile');

async function run() {
  await connectDB();
  console.log('Backfilling presence from availability toggle...');

  // Available: toggle ON and not currently busy → show available/online.
  const online = await AstrologerProfile.updateMany(
    { availabilityPreference: true, currentCallStatus: { $ne: 'busy' } },
    { $set: { isOnline: true, currentCallStatus: 'available' } }
  );
  console.log(`  set ONLINE/available on ${online.modifiedCount} profile(s)`);

  // Toggle ON but busy → online but keep busy.
  const busy = await AstrologerProfile.updateMany(
    { availabilityPreference: true, currentCallStatus: 'busy' },
    { $set: { isOnline: true } }
  );
  console.log(`  kept ONLINE/busy on ${busy.modifiedCount} profile(s)`);

  // Toggle OFF → offline (unless busy, which keeps its status).
  const offline = await AstrologerProfile.updateMany(
    { availabilityPreference: { $ne: true }, currentCallStatus: { $ne: 'busy' } },
    { $set: { isOnline: false, currentCallStatus: 'offline' } }
  );
  console.log(`  set OFFLINE on ${offline.modifiedCount} profile(s)`);

  await disconnectDB();
  console.log('Done.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
