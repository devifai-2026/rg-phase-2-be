/**
 * Bootstrap the first platform-owner account (for the owner console).
 * Usage:
 *   OWNER_EMAIL=you@example.com OWNER_PASSWORD=secret OWNER_NAME="Owner" \
 *     node scripts/seedOwner.js
 *
 * Idempotent: re-running updates the password/name for that email.
 */
require('dotenv').config();
const { connectControlDB, disconnectControlDB } = require('../config/controlDb');
const { OwnerUser } = require('../models/control');

async function main() {
  const email = (process.env.OWNER_EMAIL || '').toLowerCase().trim();
  const password = process.env.OWNER_PASSWORD || '';
  const name = process.env.OWNER_NAME || 'Owner';
  if (!email || !password) {
    console.error('Set OWNER_EMAIL and OWNER_PASSWORD env vars.');
    process.exit(1);
  }

  await connectControlDB();
  let owner = await OwnerUser.findOne({ email });
  if (!owner) owner = new OwnerUser({ email, name, role: 'owner' });
  owner.name = name;
  owner.role = 'owner';
  owner.isActive = true;
  await owner.setPassword(password);
  await owner.save();

  console.log(`Owner ${email} seeded (role=owner).`);
  await disconnectControlDB();
  process.exit(0);
}

main().catch((e) => {
  console.error('seedOwner failed:', e.message);
  process.exit(1);
});
