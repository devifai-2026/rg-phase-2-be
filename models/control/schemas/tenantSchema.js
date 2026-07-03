const mongoose = require('mongoose');

/**
 * One record per white-label client. The central control-plane document: it
 * names the tenant's isolated database, the domains that route to it, and the
 * brand identity used by the app factory + landing-page generator.
 *
 * Data isolation is DB-per-tenant: `dbName` is the physical Mongo database this
 * tenant's collections live in (resolved to a connection by tenantConnections.js).
 */
const brandingSchema = new mongoose.Schema(
  {
    // Shown app name / wordmark (the app's compiled default is the fallback).
    displayName: { type: String },
    tagline: { type: String },
    supportEmail: { type: String },
    supportPhone: { type: String },
    // Asset URLs (GCS). Logo/icon feed the app factory; hero feeds the landing page.
    logoUrl: { type: String },
    appIconUrl: { type: String },   // 1024px source for flutter_launcher_icons
    heroImageUrl: { type: String },
    // Primary brand colors ('#RRGGBB'); the full theme token set lives per-tenant
    // in that tenant's AppConfig.theme (Theme Studio) — these are just the
    // landing-page + store-listing accents.
    primaryColor: { type: String },
    accentColor: { type: String },
  },
  { _id: false }
);

// Android build identity for the app factory (Android-only — no iOS).
const androidAppSchema = new mongoose.Schema(
  {
    applicationId: { type: String }, // e.g. com.<client>.user
    label: { type: String },         // Play/app label
    // Google Play developer account this app publishes under (informational).
    playAccount: { type: String },
  },
  { _id: false }
);

const tenantSchema = new mongoose.Schema(
  {
    // URL-safe unique key; used as subdomain, GCS prefix, Flutter --dart-define
    // TENANT=<slug>, and Firebase app grouping. Immutable after creation.
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    displayName: { type: String, required: true },

    // Lifecycle. `status` here is the tenant's own enablement; the billing gate
    // is Subscription.status (a suspended subscription blocks the tenant even if
    // status='active'). 'provisioning' = DB being created; 'archived' = soft-deleted.
    status: {
      type: String,
      enum: ['provisioning', 'active', 'disabled', 'archived'],
      default: 'provisioning',
      index: true,
    },

    // ── Isolation ──
    dbName: { type: String, required: true }, // physical Mongo database name
    // If this tenant lives on a different cluster than the default, its full URI
    // is stored (encrypted) in TenantSecret; otherwise it shares the default host.
    dbOnDefaultCluster: { type: Boolean, default: true },

    // ── Routing ──
    // Hostnames that resolve to this tenant (landing + tenant admin + API host).
    // tenantResolver matches the request Host against these (or the slug subdomain).
    domains: [{ type: String, lowercase: true, trim: true }],

    branding: { type: brandingSchema, default: () => ({}) },
    androidUser: { type: androidAppSchema, default: () => ({}) },       // user app
    androidAstrologer: { type: androidAppSchema, default: () => ({}) }, // astrologer app

    // Denormalized pointer to the active subscription for fast gating reads.
    subscription: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription' },

    notes: { type: String },
  },
  { timestamps: true }
);

// DB-level backstop against duplicate Android package names. Sparse + unique so
// tenants without an app id set are exempt. This guards the same-slot case at
// the DB (race-safe); the cross-slot case (user id of A == astro id of B) is
// enforced in provisionService.assertAppIdsAvailable().
tenantSchema.index({ 'androidUser.applicationId': 1 }, { unique: true, sparse: true });
tenantSchema.index({ 'androidAstrologer.applicationId': 1 }, { unique: true, sparse: true });

module.exports = tenantSchema;
