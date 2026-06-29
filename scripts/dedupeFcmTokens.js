/* eslint-disable no-console */
// One-shot cleanup for the multi-device push-token model.
//
// BEFORE this change, registerFcmToken deduped ONLY by exact token string, so
// every token rotation / re-login on the same phone appended a brand-new row.
// Result: a single device accumulated many fcmTokens entries (and the panel
// showed "12 devices" for one phone). Those legacy rows also predate device
// identity capture, so they have no deviceId/deviceName ("Unknown device").
//
// This script collapses each user's fcmTokens to one row per device:
//   • group by deviceId when present, else by token, else keep as-is
//   • within a group keep the most-recently-used row (lastUsedAt||addedAt)
//   • also drop exact-duplicate token rows
//
// New rows registered by the updated app carry deviceId + name, so they
// self-dedup and stay clean going forward. This only cleans the backlog.
//
// Idempotent — safe to run repeatedly.
//
//   node scripts/dedupeFcmTokens.js
require('dotenv').config();
const { connectDB, disconnectDB } = require('../config/db');
const User = require('../models/User');

const ts = (t) => new Date(t.lastUsedAt || t.addedAt || 0).getTime();

function dedupe(tokens) {
  // Group key: prefer the stable deviceId; fall back to the token itself.
  const byKey = new Map();
  for (const t of tokens) {
    const key = t.deviceId || t.token;
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing || ts(t) >= ts(existing)) byKey.set(key, t);
  }
  // Most-recent device first (matches the admin panel's sort).
  return [...byKey.values()].sort((a, b) => ts(b) - ts(a));
}

async function run() {
  await connectDB();
  console.log('Deduping fcmTokens across all users...');

  const cursor = User.find({ 'fcmTokens.1': { $exists: true } }).cursor(); // 2+ tokens
  let scanned = 0;
  let changed = 0;
  let rowsRemoved = 0;

  for (let user = await cursor.next(); user != null; user = await cursor.next()) {
    scanned++;
    const before = user.fcmTokens || [];
    const after = dedupe(before);
    if (after.length !== before.length) {
      rowsRemoved += before.length - after.length;
      changed++;
      await User.updateOne({ _id: user._id }, { $set: { fcmTokens: after } });
      console.log(`  ${user.phone || user._id}: ${before.length} → ${after.length}`);
    }
  }

  console.log(`Scanned ${scanned} multi-token user(s); cleaned ${changed}, removed ${rowsRemoved} duplicate row(s).`);
  await disconnectDB();
  console.log('Done.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
