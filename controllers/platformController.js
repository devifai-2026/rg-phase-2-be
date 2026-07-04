const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const env = require('../config/env');
const { mask } = require('../utils/secretCrypto');
const { signOwner } = require('../utils/ownerToken');
const { Tenant, Plan, Subscription, TenantSecret, OwnerUser, BuildJob } = require('../models/control');
const provisionService = require('../services/control/provisionService');
const subscriptionService = require('../services/control/subscriptionService');
const { invalidateTenant } = require('../middlewares/tenantResolver');

// Build the tenant-facing URLs the owner console shows after provisioning:
// landing page + admin console. Derived from the platform public domain
// (SAAS_PUBLIC_DOMAIN / last SAAS_ROOT_DOMAIN entry, e.g. devifai.in). If a
// tenant has a custom domain in `domains`, prefer the first as the landing URL.
function tenantUrls(tenant) {
  const base = env.saas.publicDomain;
  const slug = tenant.slug;
  const customLanding = (tenant.domains || []).find((d) => d && !d.endsWith('.sslip.io'));
  return {
    landing: customLanding ? `https://${customLanding}` : (base ? `https://${slug}.${base}` : ''),
    admin: base ? `https://${slug}.admin.${base}` : '',
  };
}

// ── Owner auth ──────────────────────────────────────────────────────────────
exports.login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const owner = await OwnerUser.findOne({ email: String(email || '').toLowerCase().trim() });
  if (!owner || !owner.isActive || !(await owner.verifyPassword(password || ''))) {
    throw new AppError('Invalid credentials', 401);
  }
  owner.lastLoginAt = new Date();
  await owner.save();
  res.json({ success: true, data: { token: signOwner(owner), owner: owner.toSafeJSON() } });
});

exports.me = asyncHandler(async (req, res) => {
  res.json({ success: true, data: req.owner.toSafeJSON() });
});

// ── Tenants ───────────────────────────────────────────────────────────────
exports.listTenants = asyncHandler(async (req, res) => {
  const tenants = await Tenant.find().sort({ createdAt: -1 }).lean();
  // Attach each tenant's subscription status for the console list.
  const subs = await Subscription.find({ tenant: { $in: tenants.map((t) => t._id) } }).lean();
  const byTenant = new Map(subs.map((s) => [String(s.tenant), s]));
  const data = tenants.map((t) => ({ ...t, subscription: byTenant.get(String(t._id)) || null, urls: tenantUrls(t) }));
  res.json({ success: true, data });
});

exports.getTenant = asyncHandler(async (req, res) => {
  const tenant = await Tenant.findOne({ slug: req.params.slug }).lean();
  if (!tenant) throw new AppError('Tenant not found', 404);
  const subscription = await Subscription.findOne({ tenant: tenant._id }).lean();
  // Control-plane secrets — masked (never expose plaintext).
  const secretDoc = await TenantSecret.findOne({ tenant: tenant._id });
  const maskedSecrets = secretDoc
    ? Object.fromEntries(Object.entries(secretDoc.decrypted()).map(([k, v]) => [k, v ? mask(v) : '']))
    : {};
  // TENANT-DB config (theme, payment gateways, VedicAstro, Agora) — the source of
  // truth the apps read. Surfaced so the console reflects the REAL per-tenant
  // config, not just the control-plane TenantSecret. Best-effort per tenant DB.
  const config = await tenantConfigSummary(tenant);
  res.json({ success: true, data: { ...tenant, subscription, secrets: maskedSecrets, config, urls: tenantUrls(tenant) } });
});

// Read the tenant DB's config singletons and return a masked summary for the
// owner console. Never throws — returns nulls if the tenant DB is unreachable.
async function tenantConfigSummary(tenant) {
  try {
    const { getTenantDb, modelFor } = require('../config/tenantConnections');
    const { decrypt } = require('../utils/secretCrypto');
    let dbUri;
    if (!tenant.dbOnDefaultCluster) {
      const s = await TenantSecret.findOne({ tenant: tenant._id });
      dbUri = s ? s.decrypted().dbUri : undefined;
    }
    const db = getTenantDb(tenant, dbUri);
    const AppConfig = modelFor(db, 'AppConfig');
    const PaymentGatewayConfig = modelFor(db, 'PaymentGatewayConfig');
    const VedicAstroConfig = modelFor(db, 'VedicAstroConfig');
    const AgoraConfig = modelFor(db, 'AgoraConfig');
    const [app, pg, va, ag] = await Promise.all([
      AppConfig.get(), PaymentGatewayConfig.get(), VedicAstroConfig.get(), AgoraConfig.get(),
    ]);
    const set = (v) => (v ? mask(String(v)) : '');
    return {
      theme: { enabled: !!(app.theme && app.theme.enabled), primary: (app.theme && app.theme.dark && app.theme.dark.red) || '', accent: (app.theme && app.theme.dark && app.theme.dark.gold) || '' },
      appName: app.appName || '',
      logoUrl: app.logoUrl || '',
      payments: {
        active: pg.active || 'payu',
        payu: { key: set(pg.payu && pg.payu.key), salt: set(pg.payu && pg.payu.salt) },
        razorpay: { keyId: set(pg.razorpay && pg.razorpay.keyId), keySecret: set(pg.razorpay && pg.razorpay.keySecret) },
        cashfree: { appId: set(pg.cashfree && pg.cashfree.appId), secretKey: set(pg.cashfree && pg.cashfree.secretKey) },
      },
      vedicAstro: set(va.apiKey ? decrypt(va.apiKey) : ''),
      agora: { appId: ag.appId || '', appCertificate: set(ag.appCertificate ? decrypt(ag.appCertificate) : '') },
    };
  } catch (e) {
    require('../utils/logger').warn('tenantConfigSummary failed', e.message);
    return null;
  }
}

exports.createTenant = asyncHandler(async (req, res) => {
  const tenant = await provisionService.createTenant(req.body);
  // Return the tenant-facing URLs so the console can show them immediately.
  res.status(201).json({ success: true, data: { ...tenant.toObject(), urls: tenantUrls(tenant) } });
});

exports.updateTenant = asyncHandler(async (req, res) => {
  const { branding, domains, androidUser, androidAstrologer, displayName } = req.body;
  const existing = await Tenant.findOne({ slug: req.params.slug });
  if (!existing) throw new AppError('Tenant not found', 404);

  // If the applicationId(s) change, enforce global uniqueness (excluding self).
  if (androidUser || androidAstrologer) {
    const uid = (androidUser && androidUser.applicationId) || (existing.androidUser && existing.androidUser.applicationId);
    const aid = (androidAstrologer && androidAstrologer.applicationId) || (existing.androidAstrologer && existing.androidAstrologer.applicationId);
    await provisionService.assertAppIdsAvailable(uid, aid, existing._id);
  }

  const patch = {};
  if (branding) patch.branding = branding;
  if (domains) patch.domains = domains;
  if (androidUser) patch.androidUser = androidUser;
  if (androidAstrologer) patch.androidAstrologer = androidAstrologer;
  if (displayName) patch.displayName = displayName;
  const tenant = await Tenant.findOneAndUpdate({ slug: req.params.slug }, patch, { new: true });
  invalidateTenant(tenant.slug);
  res.json({ success: true, data: tenant });
});

// Update per-tenant secrets (Agora / Mongo URL / PayU / WABridge / LLM). Only
// non-empty fields are applied so the console can PATCH one at a time. Values
// are re-encrypted by the schema setter.
exports.updateSecrets = asyncHandler(async (req, res) => {
  const tenant = await Tenant.findOne({ slug: req.params.slug });
  if (!tenant) throw new AppError('Tenant not found', 404);
  const allowed = [
    'dbUri', 'agoraAppId', 'agoraAppCertificate', 'agoraCustomerId', 'agoraCustomerSecret',
    'payuKey', 'payuSalt', 'waBridgeAppKey', 'waBridgeAuthKey', 'waBridgeDeviceId', 'waBridgeOtpTemplateId', 'llmApiKey',
  ];
  const patch = { tenant: tenant._id };
  for (const k of allowed) if (req.body[k] !== undefined && req.body[k] !== '') patch[k] = req.body[k];
  await TenantSecret.findOneAndUpdate({ tenant: tenant._id }, patch, { upsert: true, new: true });
  invalidateTenant(tenant.slug); // secrets changed → drop cached ctx/creds
  res.json({ success: true });
});

// Set/change the tenant's admin login phone (seeds/promotes a super_admin in the
// tenant DB). That phone can then log into <slug>.admin.<domain> via OTP.
exports.setAdminPhone = asyncHandler(async (req, res) => {
  const { phone } = req.body;
  if (!phone) throw new AppError('phone is required', 400);
  const admin = await provisionService.setTenantAdminPhone(req.params.slug, phone);
  res.json({ success: true, data: { phone: admin.phone, role: admin.role, name: admin.name } });
});

exports.archiveTenant = asyncHandler(async (req, res) => {
  const tenant = await provisionService.archiveTenant(req.params.slug);
  if (!tenant) throw new AppError('Tenant not found', 404);
  res.json({ success: true, data: tenant });
});

// ── Plans & Subscriptions ───────────────────────────────────────────────────
exports.listPlans = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await Plan.find().sort({ sortOrder: 1 }).lean() });
});

exports.upsertPlan = asyncHandler(async (req, res) => {
  const { key } = req.body;
  if (!key) throw new AppError('Plan key required', 400);
  const plan = await Plan.findOneAndUpdate({ key }, req.body, { upsert: true, new: true, setDefaultsOnInsert: true });
  res.json({ success: true, data: plan });
});

exports.setSubscription = asyncHandler(async (req, res) => {
  const tenant = await Tenant.findOne({ slug: req.params.slug });
  if (!tenant) throw new AppError('Tenant not found', 404);
  const { planKey, status, periodDays, payment } = req.body;
  let sub;
  if (planKey && planKey !== 'free_trial') {
    sub = await subscriptionService.activatePaidPlan(tenant._id, planKey, { periodDays, payment });
  } else if (status) {
    sub = await subscriptionService.setStatus(tenant._id, status);
  } else {
    throw new AppError('Provide planKey or status', 400);
  }
  res.json({ success: true, data: sub });
});

// ── Builds ──────────────────────────────────────────────────────────────────
exports.listBuilds = asyncHandler(async (req, res) => {
  const q = req.query.slug ? { tenantSlug: req.query.slug } : {};
  res.json({ success: true, data: await BuildJob.find(q).sort({ createdAt: -1 }).limit(100).lean() });
});

// Delete a single build job (any status) — clears it from the console.
exports.deleteBuild = asyncHandler(async (req, res) => {
  await BuildJob.deleteOne({ _id: req.params.id });
  res.json({ success: true });
});

// Cancel/clear all pending (queued/running) builds for a tenant (or all tenants
// if no slug) — the "stop all" the owner can hit from the console.
exports.clearBuilds = asyncHandler(async (req, res) => {
  const filter = { status: { $in: ['queued', 'running'] } };
  if (req.query.slug) filter.tenantSlug = req.query.slug;
  const r = await BuildJob.deleteMany(filter);
  res.json({ success: true, data: { cleared: r.deletedCount } });
});

exports.requestBuild = asyncHandler(async (req, res) => {
  const tenant = await Tenant.findOne({ slug: req.params.slug });
  if (!tenant) throw new AppError('Tenant not found', 404);
  const { app = 'user', artifact = 'aab' } = req.body;
  const androidCfg = app === 'astrologer' ? tenant.androidAstrologer : tenant.androidUser;

  // Don't queue a duplicate: if a build for this tenant+app is already queued or
  // running, refuse (one in-flight build per app at a time). The client also
  // disables the button, but this is the authoritative guard.
  const inFlight = await BuildJob.findOne({ tenant: tenant._id, app, status: { $in: ['queued', 'running'] } });
  if (inFlight) {
    throw new AppError(`A ${app} build is already ${inFlight.status}. Wait for it to finish.`, 409);
  }

  // AUTO-VERSION every build. Android requires versionCode to strictly increase
  // for each Play upload, so we use a monotonic per-(tenant,app) counter =
  // (number of prior builds for this tenant+app) + 1. versionName is a readable
  // base + that counter (e.g. 1.0.12). The owner can override via the request.
  const priorCount = await BuildJob.countDocuments({ tenant: tenant._id, app });
  const versionCode = req.body.versionCode || (priorCount + 1);
  const versionName = req.body.versionName || `1.0.${priorCount + 1}`;

  // Default the API base to the tenant's public API host so the built app talks
  // to the right backend (all tenants share one backend; routed by X-Tenant).
  const apiBase = req.body.apiBase
    || (env.saas.publicDomain ? `https://api.${env.saas.publicDomain}` : `https://${env.saas.rootDomain}`);

  const job = await BuildJob.create({
    tenant: tenant._id,
    tenantSlug: tenant.slug,
    app,
    artifact,
    applicationId: androidCfg && androidCfg.applicationId,
    apiBase,
    versionName,
    versionCode,
    requestedBy: req.owner._id,
    status: 'queued',
  });

  // Dispatch to GitHub Actions (the app repos build it). No-op if GH token unset
  // (job stays queued). Fire-and-forget so the request returns immediately.
  require('../services/control/buildDispatchService').dispatch(job).catch(() => {});

  res.status(201).json({ success: true, data: job });
});

// Callback from the GitHub Actions build workflow — marks the BuildJob done and
// records the artifact URL. Secured by a shared token (BUILD_CALLBACK_SECRET).
exports.buildCallback = asyncHandler(async (req, res) => {
  const secret = req.headers['x-build-secret'];
  if (!process.env.BUILD_CALLBACK_SECRET || secret !== process.env.BUILD_CALLBACK_SECRET) {
    throw new AppError('Unauthorized', 401);
  }
  const { status, artifactUrl, error, log } = req.body;
  const patch = { finishedAt: new Date() };
  if (status) patch.status = status;             // 'succeeded' | 'failed'
  if (artifactUrl) patch.artifactUrl = artifactUrl;
  if (error) patch.error = String(error).slice(0, 2000);
  if (log) patch.log = String(log).slice(0, 8000);
  await BuildJob.updateOne({ _id: req.params.id }, { $set: patch });
  res.json({ success: true });
});

// ── Cross-tenant analytics (headline counts) ────────────────────────────────
exports.overview = asyncHandler(async (req, res) => {
  const [tenantCount, activeSubs, trialing, suspended] = await Promise.all([
    Tenant.countDocuments({ status: 'active' }),
    Subscription.countDocuments({ status: 'active' }),
    Subscription.countDocuments({ status: 'trialing' }),
    Subscription.countDocuments({ status: 'suspended' }),
  ]);
  res.json({ success: true, data: { tenants: tenantCount, activeSubs, trialing, suspended } });
});

// Full analytics report: platform totals + per-tenant metrics (users, astrologers,
// sessions, revenue) + MongoDB storage/doc counts + subscription breakdown. Reads
// each tenant's own DB — heavier than /overview, so it's a separate endpoint.
exports.analytics = asyncHandler(async (req, res) => {
  const data = await require('../services/control/analyticsService').report();
  res.json({ success: true, data });
});
