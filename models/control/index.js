/**
 * Control-plane models — bound to the dedicated `saas_control` connection, NOT
 * to a tenant connection. These are the only globally-shared collections in the
 * platform. Import from here (not mongoose.model) so every caller uses the same
 * connection instance.
 *
 *   const { Tenant, Subscription } = require('../models/control');
 */
const { getControlConnection } = require('../../config/controlDb');

const tenantSchema = require('./schemas/tenantSchema');
const planSchema = require('./schemas/planSchema');
const subscriptionSchema = require('./schemas/subscriptionSchema');
const tenantSecretSchema = require('./schemas/tenantSecretSchema');
const ownerUserSchema = require('./schemas/ownerUserSchema');
const buildJobSchema = require('./schemas/buildJobSchema');
const leadSchema = require('./schemas/leadSchema');
const cronRunSchema = require('./schemas/cronRunSchema');
const platformKeystoreSchema = require('./schemas/platformKeystoreSchema');
const netFallbackEventSchema = require('./schemas/netFallbackEventSchema');

const conn = getControlConnection();

// conn.model() is idempotent per connection — safe to require this file anywhere.
const Tenant = conn.model('Tenant', tenantSchema);
const Plan = conn.model('Plan', planSchema);
const Subscription = conn.model('Subscription', subscriptionSchema);
const TenantSecret = conn.model('TenantSecret', tenantSecretSchema);
const OwnerUser = conn.model('OwnerUser', ownerUserSchema);
const BuildJob = conn.model('BuildJob', buildJobSchema);
const Lead = conn.model('Lead', leadSchema);
const CronRun = conn.model('CronRun', cronRunSchema);
const PlatformKeystore = conn.model('PlatformKeystore', platformKeystoreSchema);
const NetFallbackEvent = conn.model('NetFallbackEvent', netFallbackEventSchema);

module.exports = { Tenant, Plan, Subscription, TenantSecret, OwnerUser, BuildJob, Lead, CronRun, PlatformKeystore, NetFallbackEvent, connection: conn };
