/* eslint-disable no-console */
// One-shot backfill: transliterate existing astrologer display names into every
// supported script and store them in nameI18n.
//
// Google Translate leaves Latin proper names unchanged, so the user app kept
// showing e.g. "Subhojit Dutta" in Bengali. Names are now transliterated via the
// rule-based transliterateService (approximate; admin can override any entry).
//
// Only fills locales that are missing/stale, so an admin-corrected name is never
// clobbered. Idempotent — safe to re-run. (The admin "Run translation" button
// does the same thing; this is for a one-shot deploy backfill / CLI use.)
//
//   node scripts/backfillNameI18n.js
require('dotenv').config();
const { connectDB, disconnectDB } = require('../config/db');
const AstrologerProfile = require('../models/AstrologerProfile');
const transliterateService = require('../services/transliterateService');

async function run() {
  await connectDB();
  if (!transliterateService.available()) {
    console.log('Transliteration engine unavailable — nothing to do.');
    await disconnectDB();
    return;
  }
  const targets = transliterateService.LANGUAGES.filter((l) => l !== 'en');
  const docs = await AstrologerProfile.find({ displayName: { $exists: true, $ne: '' } }).select('displayName nameI18n');
  console.log(`Backfilling nameI18n for ${docs.length} astrologer(s)...`);

  let updated = 0;
  for (const doc of docs) {
    const src = (doc.displayName || '').trim();
    if (!src) continue;
    const cur = doc.nameI18n || new Map();
    const get = (l) => (cur.get ? cur.get(l) : cur[l]);
    const set = (l, v) => (cur.set ? cur.set(l, v) : (cur[l] = v));
    let changed = false;
    for (const l of targets) {
      const existing = get(l);
      if (existing && existing !== src) continue; // keep admin overrides / already set
      const out = transliterateService.transliterate(src, l);
      if (out && out !== src) { set(l, out); changed = true; }
    }
    if (changed) { doc.nameI18n = cur; await doc.save(); updated += 1; }
  }
  console.log(`  updated ${updated} profile(s)`);
  await disconnectDB();
  console.log('Done.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
