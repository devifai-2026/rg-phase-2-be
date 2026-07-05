const { Tenant, TenantSecret } = require('../../models/control');
const { getTenantDb, modelFor } = require('../../config/tenantConnections');
const { tenantContext } = require('../../utils/tenantContext');
const atlasService = require('./atlasService');
const subscriptionService = require('./subscriptionService');
const firebaseAppService = require('./firebaseAppService');
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
  secrets = {}, // control-plane secrets: { dbUri?, waBridge*?, llmApiKey? }
  adminPhone = '', // first super_admin login for the tenant's admin panel (PO-set, trusted → no OTP)
  config = {}, // seeded into TENANT DB configs: { payments:{active,payu,razorpay,cashfree}, vedicAstroKey, agora:{appId,appCertificate} }
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
    await seedTenantDb(ctx, branding, config);

    // 4b) Create the tenant's first admin (super_admin) so someone can log into
    //     <slug>.admin.<domain> immediately. The PO is trusted, so the phone is
    //     marked verified without an OTP round-trip. No-op if no phone given.
    if (adminPhone) await ensureTenantAdmin(ctx, adminPhone, branding.displayName || slug);

    // 4c) Register the tenant's Android applicationId(s) in the shared Firebase
    //     project so CI builds can fetch a matching google-services.json. Uses
    //     the FCM service-account (Firebase Management role). Best-effort: a
    //     failure here is recorded but does not abort provisioning — the app can
    //     be registered manually later. No-op when Firebase isn't configured.
    try {
      const fb = await firebaseAppService.ensureTenantApps({
        userAppId: androidUser && androidUser.applicationId,
        astroAppId: androidAstrologer && androidAstrologer.applicationId,
        displayName: displayName || slug,
      });
      if (fb.errors && fb.errors.length) {
        logger.warn('Tenant Firebase app registration had errors', { slug, errors: fb.errors });
      } else if (fb.configured) {
        logger.info('Tenant Firebase apps ensured', { slug, project: firebaseAppService.projectId() });
      }
    } catch (e) {
      logger.error('Tenant Firebase app registration failed (non-fatal)', { slug, error: e.message });
    }

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

// Default brand palette (ARGB hex, #AARRGGBB — matches Flutter Color(0x...) and
// the app's compiled tokens). Applied to EVERY new tenant so it starts branded;
// the owner's primaryColor/accentColor then override red/gold on top.
const DEFAULT_PALETTE = {
  red: '#FFE0584A', redDeep: '#FFC0392B', redSoft: '#29E0584A',
  gold: '#FFC98A5E', green: '#FF2E9E6B', blue: '#FF2D6FB0',
  violet: '#FF6D4B9E', indigo: '#FF3B5BA9', mint: '#FF8FD0C0',
};

/**
 * Seed a fresh tenant DB with ALL its config (the source of truth the apps +
 * tenant admin read): branding/theme/logo (AppConfig), the default palette,
 * payment gateways (all 3 + active), VedicAstro key, and Agora creds. The PO
 * sets these at creation so the tenant is fully live immediately; the tenant
 * admin can edit any of it later via their own admin panel.
 *
 * @param ctx        tenant context
 * @param branding   { displayName, logoUrl, appIconUrl, primaryColor, accentColor, tagline }
 * @param config     { payments:{active,payu,razorpay,cashfree}, vedicAstroKey, agora:{appId,appCertificate} }
 */
async function seedTenantDb(ctx, branding = {}, config = {}) {
  // Touch the singletons so their .get() creates the default doc in this DB.
  const singletons = ['AdminSettings', 'AppConfig', 'AgoraConfig', 'VedicAstroConfig', 'PaymentGatewayConfig', 'HoroscopeConfig'];
  for (const name of singletons) {
    try { await ctx.model(name).get(); } catch (e) { logger.debug(`seed ${name} skipped`, e.message); }
  }

  // ── AppConfig: brand name, logo, splash, theme (default palette + overrides) ──
  try {
    const AppConfig = ctx.model('AppConfig');
    const cfg = await AppConfig.get();
    if (branding.displayName) cfg.appName = branding.displayName;
    if (branding.logoUrl) cfg.logoUrl = branding.logoUrl;

    // Start from the default palette so every tenant is branded, then apply the
    // owner's chosen primary/accent on top.
    const tokenPatch = { ...DEFAULT_PALETTE };
    if (branding.primaryColor) tokenPatch.red = toArgb(branding.primaryColor);
    if (branding.accentColor) tokenPatch.gold = toArgb(branding.accentColor);
    const t = cfg.theme ? cfg.theme.toObject() : {};
    cfg.theme = {
      enabled: true,
      dark: { ...(t.dark || {}), ...tokenPatch },
      light: { ...(t.light || {}), ...tokenPatch },
    };

    if (branding.logoUrl || branding.appIconUrl) {
      const s = cfg.splash ? cfg.splash.toObject() : {};
      cfg.splash = { ...s, image: branding.appIconUrl || branding.logoUrl || s.image };
    }
    await cfg.save();
  } catch (e) {
    logger.warn('branding/theme seed failed', e.message);
  }

  // ── Payment gateways (all 3 + which is active) ──
  try {
    const p = config.payments || {};
    if (p.active || p.payu || p.razorpay || p.cashfree) {
      const PaymentGatewayConfig = ctx.model('PaymentGatewayConfig');
      const g = await PaymentGatewayConfig.get();
      if (p.active) g.active = p.active;
      if (p.payu) g.payu = { ...g.payu.toObject?.() || g.payu, ...p.payu };
      if (p.razorpay) g.razorpay = { ...g.razorpay.toObject?.() || g.razorpay, ...p.razorpay };
      if (p.cashfree) g.cashfree = { ...g.cashfree.toObject?.() || g.cashfree, ...p.cashfree };
      await g.save();
    }
  } catch (e) {
    logger.warn('payment gateway seed failed', e.message);
  }

  // ── VedicAstro API key ──
  try {
    if (config.vedicAstroKey) {
      const VedicAstroConfig = ctx.model('VedicAstroConfig');
      const v = await VedicAstroConfig.get();
      v.apiKey = config.vedicAstroKey; // schema setter encrypts (enc:)
      await v.save();
    }
  } catch (e) {
    logger.warn('vedicastro seed failed', e.message);
  }

  // ── Agora (voice/video) ──
  try {
    const a = config.agora || {};
    if (a.appId || a.appCertificate) {
      const AgoraConfig = ctx.model('AgoraConfig');
      const ag = await AgoraConfig.get();
      if (a.appId) ag.appId = a.appId;
      if (a.appCertificate) ag.appCertificate = a.appCertificate; // setter encrypts
      await ag.save();
    }
  } catch (e) {
    logger.warn('agora seed failed', e.message);
  }
}

// Normalize a color to 8-digit ARGB hex (#AARRGGBB). Accepts #RGB, #RRGGBB, or
// #AARRGGBB; defaults alpha to FF (opaque) so app Color(0x...) parsing matches.
function toArgb(input) {
  let s = String(input || '').replace('#', '').trim();
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  if (s.length === 6) s = 'FF' + s;
  if (s.length !== 8) return input; // leave odd values as-is
  return '#' + s.toUpperCase();
}

/**
 * Ensure a tenant has a super_admin with the given phone (create or promote).
 * PO-driven, so the phone is trusted → verified without an OTP. Idempotent:
 * re-running with the same phone is a no-op; with a NEW phone it promotes that
 * number to super_admin (used by the "change admin phone" flow). Returns the user.
 */
async function ensureTenantAdmin(ctx, phone, name) {
  const { normalizePhone } = require('../../utils/phone');
  const normalized = normalizePhone(phone);
  if (!normalized) throw new AppError('Enter a valid 10-digit admin phone number', 400);
  const User = ctx.model('User');
  let user = await User.findOne({ phone: normalized });
  if (user) {
    // Promote an existing account (e.g. a user) to super_admin.
    if (user.role !== 'super_admin') { user.role = 'super_admin'; await user.save(); }
  } else {
    user = await User.create({ phone: normalized, name: name || undefined, role: 'super_admin', isPhoneVerified: true });
  }
  return user;
}

/** Set/replace a tenant's admin phone (PO action). Seeds/promotes super_admin. */
async function setTenantAdminPhone(slug, phone) {
  const tenant = await Tenant.findOne({ slug, status: { $in: ['active', 'provisioning'] } });
  if (!tenant) throw new AppError('Tenant not found', 404);
  const secretsFn = () => TenantSecret.findOne({ tenant: tenant._id }).then((s) => (s ? s.decrypted() : {}));
  let secretDbUri;
  if (!tenant.dbOnDefaultCluster) secretDbUri = (await secretsFn()).dbUri;
  const db = getTenantDb(tenant, secretDbUri);
  const ctx = tenantContext({ tenant, db, secrets: secretsFn });
  return ensureTenantAdmin(ctx, phone, tenant.displayName);
}

/** Suspend a tenant (reversible): status → archived, blocks ALL logins
 *  (users/admin/astrologers) immediately without dropping data. */
async function archiveTenant(slug) {
  const tenant = await Tenant.findOneAndUpdate(
    { slug, status: { $ne: 'deleted' } },
    { status: 'archived' },
    { new: true },
  );
  if (tenant) require('../../middlewares/tenantResolver').invalidateTenant(slug);
  return tenant;
}

/** Reactivate a suspended (archived) tenant → status active. A permanently
 *  deleted tenant (status 'deleted') can NOT be reactivated. */
async function reactivateTenant(slug) {
  const tenant = await Tenant.findOne({ slug });
  if (!tenant) return null;
  if (tenant.status === 'deleted') {
    throw new AppError('This tenant was permanently deleted and cannot be reactivated', 409);
  }
  tenant.status = 'active';
  await tenant.save();
  require('../../middlewares/tenantResolver').invalidateTenant(slug);
  // Restore the billing gate to a usable state.
  try { await subscriptionService.reactivate(tenant._id); } catch (_) { /* best effort */ }
  return tenant;
}

/** Permanently delete a tenant (irreversible): status → deleted + deletedAt.
 *  Blocks ALL logins forever and cannot be reactivated. Data is retained in the
 *  tenant DB (not dropped) so it can be exported/audited, but the tenant is dead. */
async function deleteTenant(slug, ownerId) {
  const tenant = await Tenant.findOneAndUpdate(
    { slug },
    { status: 'deleted', deletedAt: new Date(), deletedBy: ownerId },
    { new: true },
  );
  if (tenant) {
    require('../../middlewares/tenantResolver').invalidateTenant(slug);
    try { await subscriptionService.setStatus(tenant._id, 'cancelled'); } catch (_) { /* best effort */ }
  }
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

module.exports = { createTenant, seedTenantDb, archiveTenant, reactivateTenant, deleteTenant, assertAppIdsAvailable, ensureTenantAdmin, setTenantAdminPhone };
