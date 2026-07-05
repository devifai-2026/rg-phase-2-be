const express = require('express');
const ctrl = require('../controllers/platformController');
const { ownerProtect, ownerRoleOnly } = require('../middlewares/ownerOnly');
const { upload } = require('../middlewares/upload');

/**
 * Platform-owner control-plane API. Mounted at /platform OUTSIDE the tenant
 * resolver (these routes operate on the control plane, never a tenant DB).
 * All routes except login require an owner token (ownerProtect).
 */
const router = express.Router();

// Public: owner login.
router.post('/login', ctrl.login);

// Public (shared-secret): GitHub Actions build workflow posts its result here.
// Must be BEFORE ownerProtect since CI has no owner token.
router.post('/builds/:id/callback', ctrl.buildCallback);

// Public: marketing landing page contact form submits a lead here (no auth).
router.post('/leads', ctrl.createLead);

// Everything below requires a valid owner token.
router.use(ownerProtect);

router.get('/me', ctrl.me);
router.get('/overview', ctrl.overview);
router.get('/analytics', ctrl.analytics);
router.get('/vm-metrics', ctrl.vmMetrics);
router.get('/api-metrics', ctrl.apiMetrics);

// Branding asset upload (logo / app icon) → GCS, returns a public URL.
router.post('/branding-upload', ownerRoleOnly, upload.single('image'), ctrl.uploadBranding);

// Cron monitor: run history + per-(cron,tenant) summary.
router.get('/cron-runs', ctrl.cronRuns);
router.get('/cron-summary', ctrl.cronSummary);

// AI System Prompts (Danger Prompts) — PO-managed per tenant.
router.get('/tenants/:slug/prompts', ctrl.listTenantPrompts);
router.put('/tenants/:slug/prompts', ownerRoleOnly, ctrl.updateTenantPrompt);

// Platform release keystore (owner-only): metadata/passwords + raw .jks download.
router.get('/keystore', ownerRoleOnly, ctrl.getKeystore);
router.get('/keystore/download', ownerRoleOnly, ctrl.downloadKeystore);

// Leads (owner views/manages; public submit is above ownerProtect)
router.get('/leads', ctrl.listLeads);
router.patch('/leads/:id', ownerRoleOnly, ctrl.updateLead);

// Tenants
router.get('/tenants', ctrl.listTenants);
router.get('/tenants/:slug', ctrl.getTenant);
router.post('/tenants', ownerRoleOnly, ctrl.createTenant);
router.patch('/tenants/:slug', ctrl.updateTenant);
router.put('/tenants/:slug/secrets', ownerRoleOnly, ctrl.updateSecrets);
router.put('/tenants/:slug/admin-phone', ownerRoleOnly, ctrl.setAdminPhone);
// Suspend (reversible) — blocks all logins. DELETE kept for back-compat = suspend.
router.delete('/tenants/:slug', ownerRoleOnly, ctrl.archiveTenant);
router.post('/tenants/:slug/suspend', ownerRoleOnly, ctrl.archiveTenant);
router.post('/tenants/:slug/reactivate', ownerRoleOnly, ctrl.reactivateTenant);
// Permanent delete (irreversible) — requires { confirm: <slug> } in the body.
router.post('/tenants/:slug/delete', ownerRoleOnly, ctrl.deleteTenant);

// Plans & subscriptions & billing
router.get('/plans', ctrl.listPlans);
router.post('/plans', ownerRoleOnly, ctrl.upsertPlan);
router.get('/billing', ctrl.billingOverview);
router.put('/tenants/:slug/subscription', ownerRoleOnly, ctrl.setSubscription);
router.post('/tenants/:slug/payment', ownerRoleOnly, ctrl.recordPayment);

// Builds
router.get('/builds', ctrl.listBuilds);
router.post('/builds/all', ownerRoleOnly, ctrl.buildAll);
router.post('/tenants/:slug/builds', ctrl.requestBuild);
router.delete('/builds/clear', ctrl.clearBuilds);
router.delete('/builds/:id', ctrl.deleteBuild);

// Network-fallback telemetry: how many users hit the api.devifai.in DNS/network
// issue and self-healed onto the sslip fallback — time series + recent events,
// split by tenant + app (user vs astrologer).
router.get('/net-fallback', ctrl.netFallbackStats);

module.exports = router;
