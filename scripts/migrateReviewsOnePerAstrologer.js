/* eslint-disable no-console */
// Migrate Review uniqueness from one-per-SESSION to one-per-(user, astrologer).
//
//   1) Drop the old `session_unique_present` index (if present).
//   2) Collapse existing duplicates: where a user has >1 'user' review for the
//      same astrologer, keep the EARLIEST and delete the rest.
//   3) Recompute the aggregate rating for every affected astrologer profile.
//   4) Build the new partial-unique { user, astrologer } index.
//
// Safe to run multiple times (idempotent). Run with --dry-run to preview.
//   node scripts/migrateReviewsOnePerAstrologer.js --dry-run
//   node scripts/migrateReviewsOnePerAstrologer.js
require('dotenv').config();
const { connectDB, disconnectDB } = require('../config/db');
const Review = require('../models/Review');
const reviewService = require('../services/reviewService');

const DRY = process.argv.includes('--dry-run');

async function run() {
  await connectDB();
  console.log(DRY ? '\n=== DRY RUN ===\n' : '\n=== MIGRATING REVIEWS ===\n');

  // 1) Drop the stale per-session unique index.
  const idx = await Review.collection.indexes();
  const hasOld = idx.some((i) => i.name === 'session_unique_present');
  console.log(`Old session_unique_present index present: ${hasOld}`);
  if (hasOld && !DRY) {
    await Review.collection.dropIndex('session_unique_present');
    console.log('  → dropped session_unique_present');
  }

  // 2) Find duplicate (user, astrologer) groups among USER reviews.
  const dups = await Review.aggregate([
    { $match: { source: 'user', user: { $ne: null } } },
    { $sort: { createdAt: 1 } },
    { $group: { _id: { user: '$user', astrologer: '$astrologer' }, ids: { $push: '$_id' }, profile: { $first: '$astrologerProfile' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);
  console.log(`Duplicate (user, astrologer) groups: ${dups.length}`);

  const affectedProfiles = new Set();
  let toDelete = 0;
  for (const g of dups) {
    const remove = g.ids.slice(1); // keep earliest (ids[0])
    toDelete += remove.length;
    if (g.profile) affectedProfiles.add(String(g.profile));
    if (!DRY) await Review.deleteMany({ _id: { $in: remove } });
  }
  console.log(`  ${DRY ? 'would delete' : 'deleted'} ${toDelete} duplicate review(s) across ${affectedProfiles.size} astrologer(s)`);

  // 3) Recompute aggregate ratings for affected profiles.
  if (!DRY) {
    for (const pid of affectedProfiles) {
      await reviewService.recomputeAstrologerRating(pid).catch((e) => console.warn('recompute failed', pid, e.message));
    }
    if (affectedProfiles.size) console.log(`  → recomputed ${affectedProfiles.size} astrologer rating(s)`);
  }

  // 4) Build the new unique index (mongoose ensures it from the schema, but do it
  //    explicitly so this script leaves the DB in the final state).
  if (!DRY) {
    await Review.syncIndexes();
    console.log('  → synced indexes (user_astrologer_unique now enforced)');
  }

  console.log(DRY ? '\nDry run complete — nothing changed.\n' : '\nDone.\n');
  await disconnectDB();
}

run().catch((e) => { console.error(e); process.exit(1); });
