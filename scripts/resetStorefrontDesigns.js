/* eslint-disable no-console */
// Reset an astrologer's AI storefront generations so they can re-run them.
// Deletes their StorefrontLayout docs (usage = count of those, so this restores
// remaining → LIFETIME_LIMIT) and clears the profile's activeStorefrontLayout
// pointer (so the user app falls back to the preset theme until they regenerate).
//
// Usage (preview first):
//   node scripts/resetStorefrontDesigns.js <phone> --dry-run
//   node scripts/resetStorefrontDesigns.js 9382911551
//
// Run on the VM with the service env loaded:
//   set -a; source /etc/rg-backend.env; set +a; node scripts/resetStorefrontDesigns.js 9382911551
require('dotenv').config();
const { connectDB, disconnectDB } = require('../config/db');
const User = require('../models/User');
const AstrologerProfile = require('../models/AstrologerProfile');
const StorefrontLayout = require('../models/StorefrontLayout');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const phoneArg = args.find((a) => !a.startsWith('--'));

async function run() {
  if (!phoneArg) { console.error('Provide a phone number: node scripts/resetStorefrontDesigns.js <phone>'); process.exit(1); }
  await connectDB();
  console.log(DRY ? '\n=== DRY RUN (no writes) ===\n' : '\n=== RESET STOREFRONT DESIGNS ===\n');

  // Match the phone with or without country code (the DB may store +91 / 91 / bare).
  const digits = phoneArg.replace(/\D/g, '').slice(-10);
  const user = await User.findOne({ phone: { $regex: `${digits}$` } }).select('_id phone name').lean();
  if (!user) { console.error(`No user found for phone ending ${digits}`); await disconnectDB(); process.exit(1); }
  console.log(`User: ${user.name || '(no name)'}  phone=${user.phone}  _id=${user._id}`);

  const profile = await AstrologerProfile.findOne({ user: user._id }).select('_id displayName activeStorefrontLayout').lean();
  if (!profile) { console.error('No astrologer profile for that user.'); await disconnectDB(); process.exit(1); }
  console.log(`Astrologer profile: ${profile.displayName}  _id=${profile._id}  active=${profile.activeStorefrontLayout || '-'}`);

  const layouts = await StorefrontLayout.find({ astrologer: user._id }).select('_id name').lean();
  console.log(`StorefrontLayout docs: ${layouts.length}`);
  layouts.forEach((l) => console.log(`   ${l._id}  ${l.name || ''}`));

  if (!DRY) {
    const del = await StorefrontLayout.deleteMany({ astrologer: user._id });
    await AstrologerProfile.updateOne({ _id: profile._id }, { $unset: { activeStorefrontLayout: '' } });
    console.log(`\n  → deleted ${del.deletedCount} layout(s); cleared activeStorefrontLayout.`);
    console.log('  → generations reset: remaining is back to the lifetime limit.');
  }

  console.log('\nDone.');
  await disconnectDB();
}

run().catch((e) => { console.error(e); process.exit(1); });
