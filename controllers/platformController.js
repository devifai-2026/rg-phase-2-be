const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const env = require('../config/env');
// (secrets are returned unmasked to the owner console — the PO owns these values)
const { signOwner } = require('../utils/ownerToken');
const { Tenant, Plan, Subscription, TenantSecret, OwnerUser, BuildJob, Lead, CronRun } = require('../models/control');
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
  // Control-plane secrets. The PO OWNS these values (they set them), so the
  // console shows the real decrypted values — not masked — so they can verify
  // and copy them. This endpoint is owner-only (ownerProtect).
  const secretDoc = await TenantSecret.findOne({ tenant: tenant._id });
  const secrets = secretDoc
    ? Object.fromEntries(Object.entries(secretDoc.decrypted()).map(([k, v]) => [k, v || '']))
    : {};
  // TENANT-DB config (theme, payment gateways, VedicAstro, Agora) — the source of
  // truth the apps read. Surfaced so the console reflects the REAL per-tenant
  // config, not just the control-plane TenantSecret. Best-effort per tenant DB.
  const config = await tenantConfigSummary(tenant);
  // The tenant's admin phone(s) — super_admin users in the tenant DB.
  const adminPhones = await tenantAdminPhones(tenant);
  res.json({ success: true, data: { ...tenant, subscription, secrets, config, adminPhone: adminPhones[0] || '', adminPhones, urls: tenantUrls(tenant) } });
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
    // Show real values (owner-only endpoint; the PO set these and needs to verify them).
    const set = (v) => (v ? String(v) : '');
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

// The tenant's admin phone(s): super_admin users in the tenant DB. These can
// OTP-login to <slug>.admin. Best-effort — returns [] if the DB is unreachable.
async function tenantAdminPhones(tenant) {
  try {
    const { getTenantDb, modelFor } = require('../config/tenantConnections');
    let dbUri;
    if (!tenant.dbOnDefaultCluster) {
      const s = await TenantSecret.findOne({ tenant: tenant._id });
      dbUri = s ? s.decrypted().dbUri : undefined;
    }
    const db = getTenantDb(tenant, dbUri);
    const User = modelFor(db, 'User');
    const admins = await User.find({ role: 'super_admin' }).select('phone').sort({ createdAt: 1 }).lean();
    return admins.map((a) => a.phone).filter(Boolean);
  } catch (e) {
    require('../utils/logger').warn('tenantAdminPhones failed', e.message);
    return [];
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

// Suspend a tenant (reversible): blocks all logins (users/admin/astrologers)
// immediately. Data retained; can be reactivated.
exports.archiveTenant = asyncHandler(async (req, res) => {
  const tenant = await provisionService.archiveTenant(req.params.slug);
  if (!tenant) throw new AppError('Tenant not found', 404);
  res.json({ success: true, data: tenant });
});

// Reactivate a suspended tenant → active (all logins work again).
exports.reactivateTenant = asyncHandler(async (req, res) => {
  const tenant = await provisionService.reactivateTenant(req.params.slug);
  if (!tenant) throw new AppError('Tenant not found', 404);
  res.json({ success: true, data: tenant });
});

// Permanently delete a tenant (irreversible). Requires confirm=<slug> in the
// body to prevent accidents. Blocks all logins forever; data retained in DB.
exports.deleteTenant = asyncHandler(async (req, res) => {
  if (req.body.confirm !== req.params.slug) {
    throw new AppError('Type the tenant slug to confirm permanent deletion', 400);
  }
  const tenant = await provisionService.deleteTenant(req.params.slug, req.owner._id);
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

// Record a monthly payment for a tenant → advances the billing period by one
// month and sets the subscription active. Body: { amount, method?, reference?, planKey? }.
exports.recordPayment = asyncHandler(async (req, res) => {
  const tenant = await Tenant.findOne({ slug: req.params.slug });
  if (!tenant) throw new AppError('Tenant not found', 404);
  const { amount, method, reference, planKey } = req.body;
  if (amount == null || Number(amount) < 0) throw new AppError('A valid amount is required', 400);
  const sub = await subscriptionService.recordPayment(
    tenant._id,
    { amount: Number(amount), method, reference, recordedBy: req.owner._id },
    planKey,
  );
  res.json({ success: true, data: sub });
});

// Billing overview for the calendar: every tenant's next due date, status, last
// payment, and monthly amount — plus this-period aggregates. Powers the console
// billing calendar (paid / upcoming / overdue color-coding).
exports.billingOverview = asyncHandler(async (req, res) => {
  const now = new Date();
  const tenants = await Tenant.find({ status: { $nin: ['deleted'] } }).select('slug displayName status').lean();
  const subs = await Subscription.find({ tenant: { $in: tenants.map((t) => t._id) } }).lean();
  const byTenant = new Map(subs.map((s) => [String(s.tenant), s]));
  const graceMs = (env.saas.graceDays || 0) * 86400000;

  const rows = tenants.map((t) => {
    const s = byTenant.get(String(t._id));
    const dueDate = s ? (s.currentPeriodEnd || s.trialEndsAt || null) : null;
    const payments = (s && s.payments) || [];
    const lastPayment = payments.length ? payments[payments.length - 1] : null;
    const monthly = lastPayment ? lastPayment.amount : 0;
    // Derive a billing state for the calendar.
    let state = 'none';
    if (s) {
      if (s.status === 'suspended' || s.status === 'cancelled') state = 'suspended';
      else if (s.status === 'trialing') state = 'trial';
      else if (dueDate) {
        const due = new Date(dueDate).getTime();
        if (due < now.getTime()) state = (now.getTime() - due) > graceMs ? 'overdue' : 'grace';
        else state = (due - now.getTime()) < 7 * 86400000 ? 'due_soon' : 'paid';
      } else state = 'active';
    }
    return {
      slug: t.slug, displayName: t.displayName, tenantStatus: t.status,
      subStatus: s ? s.status : null, planKey: s ? s.planKey : null,
      dueDate, state, monthly,
      lastPaymentAt: lastPayment ? lastPayment.paidAt : null,
      lastPaymentAmount: lastPayment ? lastPayment.amount : null,
    };
  });

  const totals = {
    tenants: rows.length,
    overdue: rows.filter((r) => r.state === 'overdue' || r.state === 'grace').length,
    dueSoon: rows.filter((r) => r.state === 'due_soon').length,
    active: rows.filter((r) => ['paid', 'due_soon', 'active'].includes(r.state)).length,
    monthlyRecurring: rows.reduce((a, r) => a + (['paid', 'due_soon', 'grace', 'overdue'].includes(r.state) ? (r.monthly || 0) : 0), 0),
  };
  res.json({ success: true, data: { now, graceDays: env.saas.graceDays || 0, rows, totals } });
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

// Queue + dispatch one tenant/app/artifact build. Returns { job } or
// { skipped:'in_flight' } if a build for that tenant+app is already pending.
// Shared by requestBuild (single) and buildAll (fan-out).
async function queueBuild(tenant, { app = 'user', artifact = 'aab', apiBase, versionName, versionCode } = {}, ownerId) {
  const inFlight = await BuildJob.findOne({ tenant: tenant._id, app, status: { $in: ['queued', 'running'] } });
  if (inFlight) return { skipped: 'in_flight', app };

  const androidCfg = app === 'astrologer' ? tenant.androidAstrologer : tenant.androidUser;
  // Monotonic per-(tenant,app) version (Android requires increasing versionCode).
  const priorCount = await BuildJob.countDocuments({ tenant: tenant._id, app });
  const vc = versionCode || (priorCount + 1);
  const vn = versionName || `1.0.${priorCount + 1}`;
  const base = apiBase || (env.saas.publicDomain ? `https://api.${env.saas.publicDomain}` : `https://${env.saas.rootDomain}`);

  // App name shown under the icon + in the notification tray. Prefer the tenant's
  // display name (e.g. "Rudraganga"), fall back to the per-app label then slug.
  const appLabel = (androidCfg && androidCfg.appLabel) || tenant.displayName || tenant.slug;

  const job = await BuildJob.create({
    tenant: tenant._id, tenantSlug: tenant.slug, app, artifact,
    applicationId: androidCfg && androidCfg.applicationId, appLabel,
    apiBase: base, versionName: vn, versionCode: vc,
    requestedBy: ownerId, status: 'queued',
  });
  require('../services/control/buildDispatchService').dispatch(job).catch(() => {});
  return { job };
}

exports.requestBuild = asyncHandler(async (req, res) => {
  const tenant = await Tenant.findOne({ slug: req.params.slug });
  if (!tenant) throw new AppError('Tenant not found', 404);
  const r = await queueBuild(tenant, req.body, req.owner._id);
  if (r.skipped) throw new AppError(`A ${r.app} build is already in progress. Wait for it to finish.`, 409);
  res.status(201).json({ success: true, data: r.job });
});

// Build EVERY active tenant (optionally filtered). Fans out one BuildJob per
// tenant × requested app(s), skipping any already in-flight. artifact defaults
// to 'aab' (Play). Body: { apps?:['user','astrologer'], artifact?:'aab'|'apk' }.
exports.buildAll = asyncHandler(async (req, res) => {
  const apps = Array.isArray(req.body.apps) && req.body.apps.length ? req.body.apps : ['user', 'astrologer'];
  const artifact = req.body.artifact || 'aab';
  const tenants = await Tenant.find({ status: 'active' });
  const results = [];
  for (const tenant of tenants) {
    for (const app of apps) {
      const r = await queueBuild(tenant, { app, artifact }, req.owner._id);
      results.push({ tenant: tenant.slug, app, artifact, queued: !r.skipped, reason: r.skipped });
    }
  }
  const queued = results.filter((r) => r.queued).length;
  res.json({ success: true, data: { queued, total: results.length, results } });
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

  // On a successful build, delete older artifacts of the same (tenant, app,
  // artifact) — keep only the latest. Fire-and-forget so the callback is fast.
  if (status === 'succeeded') {
    BuildJob.findById(req.params.id).lean()
      .then((job) => require('../services/control/buildArtifactService').pruneSuperseded(job))
      .catch((e) => require('../utils/logger').warn('artifact prune after callback failed', e.message));
  }
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

// Live Google Cloud VM metrics (CPU / memory / disk / network) from Cloud
// Monitoring, for the dashboard's infrastructure charts. ?hours=3 (default).
exports.vmMetrics = asyncHandler(async (req, res) => {
  const hours = Math.min(Math.max(parseInt(req.query.hours || '3', 10) || 3, 1), 168);
  const data = await require('../services/control/vmMetricsService').report({ hours });
  res.json({ success: true, data });
});

// Upload a tenant branding asset (logo / app icon) → GCS → returns a public URL
// the create/edit-tenant form stores in branding.logoUrl / branding.appIconUrl.
// Multipart field 'image'; query/body: kind=logo|icon, slug=<tenant|new>.
exports.uploadBranding = asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError('Image file required (field: image)', 400);
  const kind = (req.body.kind || req.query.kind) === 'icon' ? 'icon' : 'logo';
  const slug = req.body.slug || req.query.slug || 'new';
  const { url } = await require('../services/control/brandingUploadService').upload({
    buffer: req.file.buffer, mimetype: req.file.mimetype, kind, slug,
  });
  res.status(201).json({ success: true, data: { url } });
});

// ── Cron monitor ─────────────────────────────────────────────────────────────
// List recent cron runs, newest first. Filters: ?tenant=<slug> ?cron=<name>
// ?ok=true|false. Powers the PO console cron page + tenant filter.
exports.cronRuns = asyncHandler(async (req, res) => {
  const q = {};
  if (req.query.tenant) q.tenantSlug = req.query.tenant;
  if (req.query.cron) q.cron = req.query.cron;
  if (req.query.ok === 'true') q.ok = true;
  if (req.query.ok === 'false') q.ok = false;
  const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 1000);
  const runs = await CronRun.find(q).sort({ ranAt: -1 }).limit(limit).lean();
  res.json({ success: true, data: runs });
});

// Cron summary: for each (cron, tenant) the latest run + rolling totals over the
// last 24h (runs, total rows, failures). Gives the console an at-a-glance grid.
exports.cronSummary = asyncHandler(async (req, res) => {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const match = {};
  if (req.query.tenant) match.tenantSlug = req.query.tenant;
  const rows = await CronRun.aggregate([
    { $match: match },
    { $sort: { ranAt: -1 } },
    { $group: {
      _id: { cron: '$cron', tenantSlug: '$tenantSlug' },
      lastRanAt: { $first: '$ranAt' },
      lastRows: { $first: '$rowsAffected' },
      lastOk: { $first: '$ok' },
      lastError: { $first: '$error' },
      lastDurationMs: { $first: '$durationMs' },
      runs24h: { $sum: { $cond: [{ $gte: ['$ranAt', since] }, 1, 0] } },
      rows24h: { $sum: { $cond: [{ $gte: ['$ranAt', since] }, { $ifNull: ['$rowsAffected', 0] }, 0] } },
      fails24h: { $sum: { $cond: [{ $and: [{ $gte: ['$ranAt', since] }, { $eq: ['$ok', false] }] }, 1, 0] } },
    } },
    { $project: { _id: 0, cron: '$_id.cron', tenantSlug: '$_id.tenantSlug', lastRanAt: 1, lastRows: 1, lastOk: 1, lastError: 1, lastDurationMs: 1, runs24h: 1, rows24h: 1, fails24h: 1 } },
    { $sort: { cron: 1, tenantSlug: 1 } },
  ]);
  const crons = [...new Set(rows.map((r) => r.cron))];
  const tenants = [...new Set(rows.map((r) => r.tenantSlug))];
  res.json({ success: true, data: { rows, crons, tenants } });
});

// ── Leads ───────────────────────────────────────────────────────────────────
// PUBLIC: the marketing landing page's contact modal posts here (no auth).
// Minimal validation + defensive length caps; we always 201 so a scraper can't
// probe. Never returns the stored doc's internals.
exports.createLead = asyncHandler(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 120);
  const phoneDigits = String(b.phone || '').replace(/\D/g, '').slice(0, 15);
  if (!name || phoneDigits.length < 10) {
    throw new AppError('Name and a valid phone number are required', 400);
  }
  await Lead.create({
    name,
    cc: String(b.cc || '+91').trim().slice(0, 6),
    phone: phoneDigits,
    email: String(b.email || '').trim().slice(0, 160),
    intent: String(b.intent || 'General').trim().slice(0, 120),
    source: String(b.source || 'landing').trim().slice(0, 60),
    referer: String(req.get('referer') || '').slice(0, 300),
    userAgent: String(req.get('user-agent') || '').slice(0, 300),
  });
  res.status(201).json({ success: true, message: 'Thanks — we will reach out shortly.' });
});

// OWNER: list leads (newest first), optional ?status= filter.
exports.listLeads = asyncHandler(async (req, res) => {
  const q = {};
  if (req.query.status) q.status = req.query.status;
  const leads = await Lead.find(q).sort({ createdAt: -1 }).limit(500).lean();
  res.json({ success: true, data: leads });
});

// OWNER: update a lead's status / notes (follow-up workflow).
exports.updateLead = asyncHandler(async (req, res) => {
  const patch = {};
  if (req.body.status) patch.status = req.body.status;
  if (req.body.notes != null) patch.notes = String(req.body.notes).slice(0, 2000);
  const lead = await Lead.findByIdAndUpdate(req.params.id, patch, { new: true }).lean();
  if (!lead) throw new AppError('Lead not found', 404);
  res.json({ success: true, data: lead });
});
