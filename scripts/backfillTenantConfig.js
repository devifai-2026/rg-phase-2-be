/**
 * Backfill config for a MIGRATED tenant (e.g. Rudraganga) whose tenant DB
 * predates the multi-tenant provisioning seed. Seeds:
 *   - AppConfig.theme with the default palette (enabled=true) so the apps +
 *     owner console show brand colours, and appName/logo if missing;
 *   - AgoraConfig from the platform env Agora creds (Rudraganga used env Agora).
 * Idempotent — safe to re-run; only fills what's empty.
 *
 * Usage (on the VM):  node scripts/backfillTenantConfig.js <slug>
 *   e.g.  node scripts/backfillTenantConfig.js rudraganga
 */
require('dotenv').config();
const env = require('./../config/env');
const { connectControlDB, disconnectControlDB } = require('../config/controlDb');
const { Tenant, TenantSecret } = require('../models/control');
const { getTenantDb, modelFor } = require('../config/tenantConnections');
const { DEFAULT_PALETTE_NOTE } = {}; // (palette inlined below to avoid import churn)

const DEFAULT_PALETTE = {
  red: '#FFE0584A', redDeep: '#FFC0392B', redSoft: '#29E0584A',
  gold: '#FFC98A5E', green: '#FF2E9E6B', blue: '#FF2D6FB0',
  violet: '#FF6D4B9E', indigo: '#FF3B5BA9', mint: '#FF8FD0C0',
};

async function main() {
  const slug = process.argv[2];
  if (!slug) { console.error('Usage: node scripts/backfillTenantConfig.js <slug>'); process.exit(1); }

  await connectControlDB();
  const tenant = await Tenant.findOne({ slug });
  if (!tenant) { console.error('tenant not found:', slug); process.exit(1); }

  let dbUri;
  if (!tenant.dbOnDefaultCluster) {
    const s = await TenantSecret.findOne({ tenant: tenant._id });
    dbUri = s ? s.decrypted().dbUri : undefined;
  }
  const db = getTenantDb(tenant, dbUri);

  // 1) Theme — enable + fill the default palette if not already enabled.
  const AppConfig = modelFor(db, 'AppConfig');
  const cfg = await AppConfig.get();
  if (!cfg.theme || !cfg.theme.enabled) {
    const t = cfg.theme ? cfg.theme.toObject() : {};
    cfg.theme = {
      enabled: true,
      dark: { ...DEFAULT_PALETTE, ...(t.dark || {}) },
      light: { ...DEFAULT_PALETTE, ...(t.light || {}) },
    };
  }
  if (!cfg.appName) cfg.appName = tenant.displayName || slug;
  await cfg.save();
  console.log('✔ AppConfig theme enabled + palette seeded; appName =', cfg.appName);

  // 2) Agora — seed from platform env if the tenant's AgoraConfig is empty.
  const AgoraConfig = modelFor(db, 'AgoraConfig');
  const ag = await AgoraConfig.get();
  if (!ag.appId && env.agora.appId) {
    ag.appId = env.agora.appId;
    if (env.agora.appCertificate) ag.appCertificate = env.agora.appCertificate; // setter encrypts
    await ag.save();
    console.log('✔ AgoraConfig seeded from env (appId set)');
  } else {
    console.log('· AgoraConfig already set or no env Agora — skipped');
  }

  await disconnectControlDB();
  console.log(`Backfill complete for ${slug}.`);
  process.exit(0);
}

main().catch((e) => { console.error('backfill failed:', e.message); process.exit(1); });
