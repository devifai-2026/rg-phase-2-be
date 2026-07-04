const express = require('express');
const ctrl = require('../controllers/platformController');
const { ownerProtect, ownerRoleOnly } = require('../middlewares/ownerOnly');

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

// Everything below requires a valid owner token.
router.use(ownerProtect);

router.get('/me', ctrl.me);
router.get('/overview', ctrl.overview);
router.get('/analytics', ctrl.analytics);

// Tenants
router.get('/tenants', ctrl.listTenants);
router.get('/tenants/:slug', ctrl.getTenant);
router.post('/tenants', ownerRoleOnly, ctrl.createTenant);
router.patch('/tenants/:slug', ctrl.updateTenant);
router.put('/tenants/:slug/secrets', ownerRoleOnly, ctrl.updateSecrets);
router.put('/tenants/:slug/admin-phone', ownerRoleOnly, ctrl.setAdminPhone);
router.delete('/tenants/:slug', ownerRoleOnly, ctrl.archiveTenant);

// Plans & subscriptions
router.get('/plans', ctrl.listPlans);
router.post('/plans', ownerRoleOnly, ctrl.upsertPlan);
router.put('/tenants/:slug/subscription', ownerRoleOnly, ctrl.setSubscription);

// Builds
router.get('/builds', ctrl.listBuilds);
router.post('/builds/all', ownerRoleOnly, ctrl.buildAll);
router.post('/tenants/:slug/builds', ctrl.requestBuild);
router.delete('/builds/clear', ctrl.clearBuilds);
router.delete('/builds/:id', ctrl.deleteBuild);

module.exports = router;
