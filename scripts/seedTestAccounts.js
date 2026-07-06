/* eslint-disable no-console */
require('dotenv').config();
/**
 * Seed the three TEST / bypass login accounts for a tenant (Play-Store review,
 * QA, demo): one admin, one user, one astrologer. These are the accounts that
 * pair with the OTP bypass in otpService (env OTP_TEST_ACCOUNTS) — the bypass
 * lets them log in with a fixed code and NO WhatsApp send; this script makes
 * the accounts actually EXIST with the right roles so the login lands somewhere.
 *
 * Numbers + roles are fixed defaults (override via flags). The astrologer gets a
 * minimal ACTIVE profile so the astro app's exists-check gate lets it sign in.
 * Idempotent — re-running updates roles/profile in place, never duplicates.
 *
 * Usage (on the VM, where tenant DBs are reachable):
 *   node scripts/seedTestAccounts.js <slug>
 *   node scripts/seedTestAccounts.js astrotalk
 *   node scripts/seedTestAccounts.js astrotalk --admin 9100000001 --user 9100000002 --astro 9100000003
 *
 * After seeding, set on the VM env (/etc/rg-backend.env) and restart:
 *   OTP_TEST_ACCOUNTS=astrotalk:9100000001,9100000002,9100000003
 *   OTP_TEST_CODE=123456
 */
const env = require('../config/env');
const { connectControlDB, disconnectControlDB } = require('../config/controlDb');
const { Tenant, TenantSecret } = require('../models/control');
const { getTenantDb, modelFor } = require('../config/tenantConnections');
const { normalizePhone } = require('../utils/phone');

function argFlag(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const DEFAULTS = { admin: '9100000001', user: '9100000002', astro: '9100000003' };

async function main() {
  const slug = process.argv[2];
  if (!slug || slug.startsWith('--')) {
    console.error('Usage: node scripts/seedTestAccounts.js <slug> [--admin N --user N --astro N]');
    process.exit(1);
  }

  const nums = {
    admin: normalizePhone(argFlag('admin', DEFAULTS.admin)),
    user: normalizePhone(argFlag('user', DEFAULTS.user)),
    astro: normalizePhone(argFlag('astro', DEFAULTS.astro)),
  };
  for (const [k, v] of Object.entries(nums)) {
    if (!v) { console.error(`✗ invalid ${k} number`); process.exit(1); }
  }

  if (!env.saas.enabled) { console.error('✗ SAAS_ENABLED is not true — refusing to run.'); process.exit(1); }

  await connectControlDB();
  const tenant = await Tenant.findOne({ slug });
  if (!tenant) { console.error('✗ tenant not found:', slug); process.exit(1); }

  let dbUri;
  if (!tenant.dbOnDefaultCluster) {
    const s = await TenantSecret.findOne({ tenant: tenant._id });
    dbUri = s ? s.decrypted().dbUri : undefined;
  }
  const db = getTenantDb(tenant, dbUri);
  const User = modelFor(db, 'User');
  const AstrologerProfile = modelFor(db, 'AstrologerProfile');

  // 1) ADMIN — role super_admin so it can reach every admin surface.
  const admin = await upsertUser(User, nums.admin, { name: 'QA Admin', role: 'super_admin' });
  console.log(`✓ admin      ${nums.admin}  role=${admin.role}`);

  // 2) USER — a plain seeker. Role forced to 'user' in case it was reused.
  const user = await upsertUser(User, nums.user, { name: 'QA User', role: 'user' });
  console.log(`✓ user       ${nums.user}  role=${user.role}`);

  // 3) ASTROLOGER — user(role=astrologer) + an ACTIVE minimal profile so the
  //    astro app's exists-check gate (applicationStatus==='active') allows login.
  const astroUser = await upsertUser(User, nums.astro, { name: 'QA Astrologer', role: 'astrologer' });
  let profile = await AstrologerProfile.findOne({ user: astroUser._id });
  const rate = { enabled: true, ratePerMin: 10, adminCutPerMin: 3 };
  if (!profile) {
    profile = await AstrologerProfile.create({
      user: astroUser._id,
      displayName: 'QA Astrologer',
      rating: 5,
      applicationStatus: 'active',
      kycStatus: 'approved',
      activatedAt: new Date(),
      location: { address: 'Test address', pincode: '110001', city: 'Delhi', state: 'Delhi' },
      rates: { call: { ...rate }, chat: { ...rate }, video: { ...rate } },
      availabilityPreference: false, // must start offline (no live socket yet)
      expertise: ['Vedic'],
      languages: ['Hindi', 'English'],
      experienceYears: 5,
    });
  } else {
    profile.applicationStatus = 'active';
    profile.kycStatus = 'approved';
    if (!profile.rating) profile.rating = 5;
    if (!profile.activatedAt) profile.activatedAt = new Date();
    await profile.save();
  }
  console.log(`✓ astrologer ${nums.astro}  status=${profile.applicationStatus}  profile=${profile._id}`);

  console.log('\nDone. Now set on the VM (and restart backend):');
  console.log(`  OTP_TEST_ACCOUNTS=${slug}:${nums.admin.slice(2)},${nums.user.slice(2)},${nums.astro.slice(2)}`);
  console.log(`  OTP_TEST_CODE=${env.otp.testCode}`);

  await disconnectControlDB();
  process.exit(0);
}

/** Create the user if absent, else force name/role. Marks phone verified. */
async function upsertUser(User, phone, fields) {
  let u = await User.findOne({ phone });
  if (!u) {
    u = await User.create({ phone, isPhoneVerified: true, ...fields });
  } else {
    u.isPhoneVerified = true;
    if (fields.role) u.role = fields.role;
    if (fields.name && !u.name) u.name = fields.name;
    await u.save();
  }
  return u;
}

main().catch((e) => { console.error('Seed failed:', e); process.exit(1); });
