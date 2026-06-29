/* eslint-disable no-console */
require('dotenv').config();
/**
 * Pre-fill the VedicAstroConfig singleton with an API key (stored ENCRYPTED).
 * vedicAstroService reads this DB doc at runtime (DB first, env fallback), and
 * the admin panel (Platform → VedicAstro API) can view/edit/rotate it. The base
 * URL and cache TTL are code constants (config/env.js), not seeded here.
 *
 * The key is NOT hardcoded — pass it so the secret never lands in source:
 *
 *   VEDIC_ASTRO_API_KEY=your_key node scripts/seedVedicAstroKey.js
 *   node scripts/seedVedicAstroKey.js your_key
 *
 * Re-running with a new key rotates it.
 */
const { connectDB, disconnectDB } = require('../config/db');
const { encrypt, decrypt, mask } = require('../utils/secretCrypto');
const VedicAstroConfig = require('../models/VedicAstroConfig');

async function run() {
  const apiKey = (process.argv[2] || process.env.VEDIC_ASTRO_API_KEY || '').trim();

  if (!apiKey) {
    console.error('✗ No API key provided.');
    console.error('  Usage: VEDIC_ASTRO_API_KEY=your_key node scripts/seedVedicAstroKey.js');
    console.error('     or: node scripts/seedVedicAstroKey.js your_key');
    process.exit(1);
  }

  await connectDB();
  const doc = await VedicAstroConfig.get();
  doc.apiKey = encrypt(apiKey);
  await doc.save();

  // Read it back through the same decrypt path the service uses, to prove it works.
  const back = await VedicAstroConfig.get();
  const roundtrip = decrypt(back.apiKey);
  console.log('✓ VedicAstro API key seeded (encrypted at rest)');
  console.log(`  key      : ${mask(roundtrip)}`);
  console.log(`  decrypts : ${roundtrip === apiKey ? 'OK (matches input)' : '✗ MISMATCH'}`);

  await disconnectDB();
}

run().catch((e) => {
  console.error('Seed failed:', e);
  process.exit(1);
});
