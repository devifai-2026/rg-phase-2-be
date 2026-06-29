/* eslint-disable no-console */
// One-off cleanup of ALL live-broadcast data.
//
// Order of operations:
//   1) Gracefully END any active (status:'live') LiveSession — close its polls,
//      zero the viewer count, stamp endedAt — so the user-app Live tab clears
//      immediately (GET /live only returns status:'live').
//   2) DELETE all LivePoll docs (polls only ever belong to live sessions).
//   3) DELETE all LiveSession docs (live + ended history).
//   4) DELETE the "X is live" push records: Broadcast docs with data.type==='live'
//      and their BroadcastDelivery idempotency rows.
//
// NOTE: this only touches the DATABASE. In-memory liveService timers
// (auto-poll / disconnect auto-end) live in the running API process and are
// harmless once the docs are gone — they self-stop on their next tick when they
// find no live session. Restart the API if you want them cleared instantly.
//
// Run a preview first, then for real:
//   node scripts/clearLiveData.js --dry-run
//   node scripts/clearLiveData.js
require('dotenv').config();
const { connectDB, disconnectDB } = require('../config/db');
const LiveSession = require('../models/LiveSession');
const LivePoll = require('../models/LivePoll');
const Broadcast = require('../models/Broadcast');
const BroadcastDelivery = require('../models/BroadcastDelivery');

const DRY = process.argv.includes('--dry-run');

async function run() {
  await connectDB();
  console.log(DRY ? '\n=== DRY RUN (no writes) ===\n' : '\n=== CLEARING LIVE DATA ===\n');

  // ── 1) End active live sessions gracefully ──
  const active = await LiveSession.countDocuments({ status: 'live' });
  console.log(`Active (status:'live') sessions: ${active}`);
  if (active && !DRY) {
    const now = new Date();
    const r = await LiveSession.updateMany(
      { status: 'live' },
      { $set: { status: 'ended', endedAt: now, viewerCount: 0 } }
    );
    await LivePoll.updateMany({ active: true }, { $set: { active: false } });
    console.log(`  → ended ${r.modifiedCount} session(s) and closed their open polls`);
  }

  // ── 2) Delete all LivePoll docs ──
  const pollCount = await LivePoll.countDocuments({});
  console.log(`LivePoll docs: ${pollCount}`);
  if (pollCount && !DRY) {
    const r = await LivePoll.deleteMany({});
    console.log(`  → deleted ${r.deletedCount} poll(s)`);
  }

  // ── 3) Delete all LiveSession docs ──
  const sessCount = await LiveSession.countDocuments({});
  console.log(`LiveSession docs (all): ${sessCount}`);
  if (sessCount && !DRY) {
    const r = await LiveSession.deleteMany({});
    console.log(`  → deleted ${r.deletedCount} session(s)`);
  }

  // ── 4) Delete the "is live" push broadcasts + their delivery rows ──
  // The live push is created by liveService.notifyLive → broadcastService.send
  // with data.type === 'live'. Target exactly those.
  const liveBroadcasts = await Broadcast.find({ 'data.type': 'live' }).select('_id').lean();
  const ids = liveBroadcasts.map((b) => b._id);
  console.log(`Live push Broadcast docs (data.type:'live'): ${ids.length}`);
  if (ids.length) {
    const delCount = await BroadcastDelivery.countDocuments({ broadcast: { $in: ids } });
    console.log(`  BroadcastDelivery rows for those: ${delCount}`);
    if (!DRY) {
      const dr = await BroadcastDelivery.deleteMany({ broadcast: { $in: ids } });
      const br = await Broadcast.deleteMany({ _id: { $in: ids } });
      console.log(`  → deleted ${dr.deletedCount} delivery row(s) and ${br.deletedCount} broadcast(s)`);
    }
  }

  console.log(DRY ? '\nDry run complete — nothing was written.\n' : '\nDone.\n');
  await disconnectDB();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
