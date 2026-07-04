const { Tenant, TenantSecret } = require('../../models/control');
const { getTenantDb, modelFor } = require('../../config/tenantConnections');
const { tenantContext } = require('../../utils/tenantContext');
const atlasService = require('./atlasService');
const subscriptionService = require('./subscriptionService');
const logger = require('../../utils/logger');
const AppError = require('../../utils/AppError');

/**
 * End-to-end tenant provisioning (owner console "Create tenant"):
 *   1) create the control-plane Tenant record,
 *   2) provision its isolated database (Atlas Admin API, or default cluster),
 *   3) store per-tenant secrets encrypted (Mongo URL, Agora, PayU, WABridge…),
 *   4) seed the tenant DB: singleton config docs + branding → AppConfig,
 *   5) start the 14-day free trial,
 *   6) flip the tenant to `active`.
 *
 * Idempotent-ish: a duplicate slug is rejected up front. On a mid-way failure the
 * tenant is left in `provisioning` for retry/cleanup.
 */
async function createTenant({
  slug,
  displayName,
  domains = [],
  branding = {},
  androidUser = {},
  androidAstrologer = {},
  secrets = {}, // { dbUri?, agoraAppId?, agoraAppCertificate?, payuKey?, payuSalt?, waBridge*?, llmApiKey? }
} = {}) {
  slug = String(slug || '').toLowerCase().trim();
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) {
    throw new AppError('Invalid slug (a-z, 0-9, hyphen; 3-40 chars)', 400);
  }
  if (await Tenant.findOne({ slug })) throw new AppError('A tenant with this slug already exists', 409);

  // Android applicationId (package name) MUST be globally unique — two tenants
  // can't share one (Play Store + Firebase register per applicationId). Reject a
  // duplicate of EITHER the user or astrologer app id against ANY existing
  // tenant's user OR astrologer id. Also reject the two ids colliding with each
  // other within this same request.
  await assertAppIdsAvailable(androidUser && androidUser.applicationId, androidAstrologer && androidAstrologer.applicationId);

  // 1) Control-plane record (starts in `provisioning`).
  const tenant = await Tenant.create({
    slug,
    displayName: displayName || slug,
    status: 'provisioning',
    dbName: `tenant_${slug.replace(/-/g, '_')}`,
    dbOnDefaultCluster: true,
    domains,
    branding,
    androidUser,
    androidAstrologer,
  });

  try {
    // 2) Provision the database (Atlas creates a scoped user; dev → default cluster).
    const prov = await atlasService.provisionTenantDb(slug);
    tenant.dbName = prov.dbName;
    tenant.dbOnDefaultCluster = prov.onDefaultCluster;
    await tenant.save();

    // 3) Store secrets encrypted (the setter encrypts). The provisioned dbUri
    //    (if any) plus whatever the owner pasted at creation.
    const secretDoc = { tenant: tenant._id, ...secrets };
    if (prov.dbUri) secretDoc.dbUri = prov.dbUri;
    await TenantSecret.findOneAndUpdate({ tenant: tenant._id }, secretDoc, { upsert: true, new: true, setDefaultsOnInsert: true });

    // 4) Seed the tenant DB with essential config + branding.
    const db = getTenantDb(tenant, prov.dbUri);
    const secretsFn = () => TenantSecret.findOne({ tenant: tenant._id }).then((s) => (s ? s.decrypted() : {}));
    const ctx = tenantContext({ tenant, db, secrets: secretsFn });
    await seedTenantDb(ctx, branding);

    // 5) Start the free trial.
    await subscriptionService.startTrial(tenant._id);

    // 6) Activate.
    tenant.status = 'active';
    await tenant.save();

    logger.info('Tenant provisioned', { slug, dbName: tenant.dbName });
    return tenant;
  } catch (e) {
    logger.error('Tenant provisioning failed', { slug, error: e.message });
    throw e; // tenant left in `provisioning` for retry/cleanup
  }
}

/**
 * Seed the essential singleton config docs into a fresh tenant DB and apply the
 * owner-provided branding to AppConfig (theme tokens + splash + logo). The
 * tenant admin can further edit these later via Theme Studio / App Config — this
 * is just the initial brand identity the owner sets at creation.
 */
async function seedTenantDb(ctx, branding = {}) {
  // Touch the singletons so their .get() creates the default doc in this DB.
  const singletons = ['AdminSettings', 'AppConfig', 'AgoraConfig', 'VedicAstroConfig', 'PaymentGatewayConfig', 'HoroscopeConfig'];
  for (const name of singletons) {
    try { await ctx.model(name).get(); } catch (e) { logger.debug(`seed ${name} skipped`, e.message); }
  }

  // Apply branding → AppConfig (theme + splash). Colors from branding map onto
  // the light/dark token sets' primary accents; the app fills the rest from its
  // compiled defaults per missing token.
  try {
    const AppConfig = ctx.model('AppConfig');
    const cfg = await AppConfig.get();
    // Brand name shown inside both apps — the key de-branding lever so a tenant's
    // build never shows another tenant's name.
    if (branding.displayName) cfg.appName = branding.displayName;
    // Brand logo (apps + tenant admin login); initials fallback when unset.
    if (branding.logoUrl) cfg.logoUrl = branding.logoUrl;
    if (branding.primaryColor || branding.accentColor) {
      const tokenPatch = {};
      if (branding.primaryColor) tokenPatch.red = branding.primaryColor;   // primary brand accent
      if (branding.accentColor) tokenPatch.gold = branding.accentColor;    // secondary accent
      const t = cfg.theme ? cfg.theme.toObject() : {};
      cfg.theme = {
        enabled: true,
        dark: { ...(t.dark || {}), ...tokenPatch },
        light: { ...(t.light || {}), ...tokenPatch },
      };
    }
    if (branding.logoUrl || branding.appIconUrl) {
      const s = cfg.splash ? cfg.splash.toObject() : {};
      cfg.splash = { ...s, image: branding.appIconUrl || branding.logoUrl || s.image };
    }
    await cfg.save();
  } catch (e) {
    logger.warn('branding seed failed', e.message);
  }
}

/** Archive (soft-delete) a tenant: block traffic without dropping data. */
async function archiveTenant(slug) {
  const tenant = await Tenant.findOneAndUpdate({ slug }, { status: 'archived' }, { new: true });
  if (tenant) require('../../middlewares/tenantResolver').invalidateTenant(slug);
  return tenant;
}

/**
 * Ensure the given Android applicationId(s) are not already used by any tenant
 * (in either the user or astrologer slot), and don't collide with each other.
 * `excludeTenantId` skips a tenant's own record (for updates). Throws 409 on clash.
 */
async function assertAppIdsAvailable(userAppId, astroAppId, excludeTenantId) {
  const ids = [userAppId, astroAppId].map((x) => (x || '').trim()).filter(Boolean);
  if (!ids.length) return;

  // Within-request collision: the two apps can't share one id.
  if (ids.length === 2 && ids[0] === ids[1]) {
    throw new AppError(`The user and astrologer apps must have different applicationIds (${ids[0]})`, 409);
  }

  const q = {
    $or: [
      { 'androidUser.applicationId': { $in: ids } },
      { 'androidAstrologer.applicationId': { $in: ids } },
    ],
  };
  if (excludeTenantId) q._id = { $ne: excludeTenantId };

  const clash = await Tenant.findOne(q).select('slug androidUser.applicationId androidAstrologer.applicationId');
  if (clash) {
    const taken = ids.find((id) =>
      (clash.androidUser && clash.androidUser.applicationId === id) ||
      (clash.androidAstrologer && clash.androidAstrologer.applicationId === id));
    throw new AppError(`applicationId "${taken}" is already used by tenant "${clash.slug}"`, 409);
  }
}

module.exports = { createTenant, seedTenantDb, archiveTenant, assertAppIdsAvailable };
