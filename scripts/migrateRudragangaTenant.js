/**
 * Migrate the existing single-tenant Rudraganga database into the multi-tenant
 * platform as tenant #1.
 *
 * Rudraganga becomes just one paid tenant. This script:
 *   1) creates the control-plane Tenant record (slug 'rudraganga') + secrets,
 *   2) points it at the EXISTING production database (no data copy — it simply
 *      adopts the current DB as this tenant's DB, so nothing moves and there's
 *      zero downtime/data risk),
 *   3) seeds its subscription as a paid/active plan (it's a live paying client),
 *   4) sets its branding so its apps keep showing "Rudraganga".
 *
 * Idempotent: re-running updates the tenant record without touching app data.
 *
 * Usage (against prod control DB + the existing MONGO_URI as the tenant DB):
 *   SAAS_ENABLED=true SAAS_CONTROL_DB_URI=<control> \
 *   RUDRAGANGA_DOMAINS=rudraganga.app,rudraganga.admin.<root> \
 *     node scripts/migrateRudragangaTenant.js
 */
require('dotenv').config();
const env = require('../config/env');
const { connectControlDB, disconnectControlDB } = require('../config/controlDb');
const { Tenant, Plan, Subscription, TenantSecret } = require('../models/control');
const planService = require('../services/control/planService');
const subscriptionService = require('../services/control/subscriptionService');

// The existing DB name embedded in MONGO_URI (adopted as-is — NO data copy).
function existingDbName() {
  const m = env.mongoUri.split('?')[0].match(/\/([^/]+)$/);
  return (m && m[1]) || 'astro_wellness';
}

async function main() {
  await connectControlDB();
  await planService.seedPlans();

  const slug = 'rudraganga';
  const dbName = existingDbName();
  const domains = (process.env.RUDRAGANGA_DOMAINS || 'rudraganga.app')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

  // 1) Tenant record — adopt the EXISTING db (dbOnDefaultCluster=true, same dbName).
  let tenant = await Tenant.findOne({ slug });
  const branding = {
    displayName: 'Rudraganga',
    tagline: 'Talk to expert astrologers — anytime, anywhere.',
    primaryColor: '#B71C1C',
    accentColor: '#FFB300',
  };
  if (!tenant) {
    tenant = await Tenant.create({
      slug, displayName: 'Rudraganga', status: 'active',
      dbName, dbOnDefaultCluster: true, domains, branding,
      androidUser: { applicationId: 'com.rudraganga.rg_user', label: 'Rudraganga' },
      androidAstrologer: { applicationId: 'com.rudraganga.rg_astrologer', label: 'Rudraganga Astrologer' },
    });
  } else {
    tenant.status = 'active'; tenant.dbName = dbName; tenant.domains = domains; tenant.branding = branding;
    await tenant.save();
  }

  // 2) Secrets: adopt the platform env creds as this tenant's (Rudraganga's
  //    current Agora/PayU/WABridge live in env). dbUri blank → default cluster.
  await TenantSecret.findOneAndUpdate({ tenant: tenant._id }, {
    tenant: tenant._id,
    agoraAppId: env.agora.appId, agoraAppCertificate: env.agora.appCertificate,
    payuKey: env.payu.key, payuSalt: env.payu.salt,
    waBridgeAppKey: env.waBridge.appKey, waBridgeAuthKey: env.waBridge.authKey,
    waBridgeDeviceId: env.waBridge.deviceId, waBridgeOtpTemplateId: env.waBridge.otpTemplateId,
  }, { upsert: true, setDefaultsOnInsert: true });

  // 3) Seed the app's brand name into its OWN AppConfig so its apps show
  //    "Rudraganga" (via the same tenant-branding mechanism every tenant uses).
  const { getTenantDb, modelFor } = require('../config/tenantConnections');
  const db = getTenantDb(tenant);
  const AppConfig = modelFor(db, 'AppConfig');
  const cfg = await AppConfig.get();
  if (!cfg.appName) { cfg.appName = 'Rudraganga'; await cfg.save(); }

  // 4) Subscription: Rudraganga is a PAID client → activate a paid plan. Create a
  //    'pro' plan if none exists, then activate (no trial).
  await Plan.updateOne({ key: 'pro' }, { $setOnInsert: { key: 'pro', name: 'Pro', price: 0, interval: 'month' } }, { upsert: true });
  const sub = await Subscription.findOne({ tenant: tenant._id });
  if (!sub || sub.status !== 'active') {
    await subscriptionService.activatePaidPlan(tenant._id, 'pro', { periodDays: 3650 }); // long period — it's the flagship
  }

  console.log(`✔ Rudraganga migrated as tenant #1 (slug=${slug}, db=${dbName}, domains=${domains.join(',')})`);
  await disconnectControlDB();
  process.exit(0);
}

main().catch((e) => { console.error('migration failed:', e.message); process.exit(1); });
