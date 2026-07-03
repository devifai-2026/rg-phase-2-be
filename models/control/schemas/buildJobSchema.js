const mongoose = require('mongoose');

/**
 * One Android build request produced by the in-panel build service. The owner
 * console enqueues a BuildJob; a Linux+Android-SDK build worker picks it up,
 * stamps the tenant flavor, runs `flutter build appbundle/apk` with the tenant's
 * signing key, uploads the signed artifact to GCS, and writes back artifactUrl.
 *
 * Android-only — there is no iOS build path.
 */
const buildJobSchema = new mongoose.Schema(
  {
    tenant: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    tenantSlug: { type: String, required: true }, // denormalized for the worker

    app: { type: String, enum: ['user', 'astrologer'], required: true },
    artifact: { type: String, enum: ['aab', 'apk'], default: 'aab' }, // aab=Play, apk=sideload/QA

    // Build inputs stamped into the flavor. apiBase + tenant slug become
    // --dart-define; applicationId/label come from Tenant.androidUser/Astrologer.
    applicationId: { type: String },
    versionName: { type: String },
    versionCode: { type: Number },
    apiBase: { type: String }, // https://<tenant-api-host>

    status: {
      type: String,
      enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'],
      default: 'queued',
      index: true,
    },

    startedAt: { type: Date },
    finishedAt: { type: Date },
    artifactUrl: { type: String }, // GCS URL of the signed .aab/.apk
    log: { type: String, default: '' }, // build stdout/stderr tail
    error: { type: String },

    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'OwnerUser' },
    // Worker lease so only one worker runs a job (mirrors the Job queue pattern).
    lockedBy: { type: String },
    lockedAt: { type: Date },
  },
  { timestamps: true }
);

buildJobSchema.index({ status: 1, createdAt: 1 });

module.exports = buildJobSchema;
