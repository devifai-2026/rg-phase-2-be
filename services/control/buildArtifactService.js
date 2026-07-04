const env = require('../../config/env');
const logger = require('../../utils/logger');
const { BuildJob } = require('../../models/control');

/**
 * Keep only the LATEST successful artifact per (tenant, app, artifact); when a
 * new build succeeds, delete the older ones' GCS objects and prune their
 * BuildJob rows. Called from the build callback on a successful build.
 *
 * The artifact bucket is the same GCS bucket CI uploads to (GCP_ARTIFACT_BUCKET
 * / GCS_BUCKET, default 'rudraganga'). On the VM the default compute SA has
 * storage.objectAdmin, so a plain Storage() client (ADC) can delete. When the
 * bucket can't be resolved, this is a safe no-op (logs a warning) — builds still
 * work, old artifacts just accumulate.
 */
let _bucket = null;
function bucket() {
  if (_bucket !== null) return _bucket || null;
  const name = env.gcpArtifactBucket || env.gcs.bucket || (env.gcpMonitoring && env.gcpMonitoring.projectId) || '';
  if (!name) { _bucket = false; return null; }
  try {
    const { Storage } = require('@google-cloud/storage');
    const opts = {};
    // Reuse an explicit key if one is configured; else ADC (VM compute SA).
    if (env.gcs.keyFile) opts.keyFilename = env.gcs.keyFile;
    else if (env.gcs.credentialsJson) { try { opts.credentials = JSON.parse(env.gcs.credentialsJson); } catch { /* ignore */ } }
    if (env.gcs.projectId) opts.projectId = env.gcs.projectId;
    _bucket = new Storage(opts).bucket(name);
    return _bucket;
  } catch (e) {
    logger.warn('buildArtifactService: could not init Storage', e.message);
    _bucket = false;
    return null;
  }
}

// Parse the GCS object path from a public artifact URL.
//   https://storage.googleapis.com/<bucket>/<object...>  → <object...>
function objectPathFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/^https?:\/\/storage\.googleapis\.com\/[^/]+\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * After `keepJob` succeeded, delete every OLDER succeeded build of the same
 * (tenant, app, artifact): remove its GCS object, then delete the BuildJob row.
 * Best-effort — never throws (called fire-and-forget from the callback).
 * Returns { deletedObjects, prunedJobs }.
 */
async function pruneSuperseded(keepJob) {
  const out = { deletedObjects: 0, prunedJobs: 0 };
  try {
    if (!keepJob || keepJob.status !== 'succeeded') return out;
    // Older succeeded builds for the same tenant/app/artifact (exclude the one we keep).
    const olds = await BuildJob.find({
      _id: { $ne: keepJob._id },
      tenant: keepJob.tenant,
      app: keepJob.app,
      artifact: keepJob.artifact,
      status: 'succeeded',
    }).lean();
    if (!olds.length) return out;

    const bkt = bucket();
    for (const j of olds) {
      const objPath = objectPathFromUrl(j.artifactUrl);
      if (objPath && bkt) {
        try {
          await bkt.file(objPath).delete({ ignoreNotFound: true });
          out.deletedObjects += 1;
        } catch (e) {
          logger.warn('buildArtifact delete failed', { object: objPath, error: e.message });
        }
      }
      await BuildJob.deleteOne({ _id: j._id });
      out.prunedJobs += 1;
    }
    logger.info('Pruned superseded build artifacts', {
      tenant: keepJob.tenantSlug, app: keepJob.app, artifact: keepJob.artifact, ...out,
    });
    return out;
  } catch (e) {
    logger.error('pruneSuperseded failed', e.message);
    return out;
  }
}

module.exports = { pruneSuperseded, objectPathFromUrl };
