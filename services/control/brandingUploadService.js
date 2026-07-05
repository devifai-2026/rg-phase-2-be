const env = require('../../config/env');
const logger = require('../../utils/logger');

/**
 * Upload a tenant branding asset (logo / app icon) to GCS and return a public
 * URL. Used by the owner console's create/edit-tenant flow so the PO can UPLOAD
 * a file instead of pasting a URL. Stored under branding/<slug>/<kind>-<ts>.<ext>
 * in the same bucket CI/build artifacts use (public-read via bucket-level IAM).
 *
 * On the VM this writes via ADC (the default compute SA has storage.objectAdmin).
 * When the bucket can't be resolved, throws a clear error so the console shows it.
 */
let _bucket = null;
function bucket() {
  if (_bucket !== null) return _bucket || null;
  const name = env.gcpArtifactBucket || env.gcs.bucket || '';
  if (!name) { _bucket = false; return null; }
  try {
    const { Storage } = require('@google-cloud/storage');
    const opts = {};
    if (env.gcs.keyFile) opts.keyFilename = env.gcs.keyFile;
    else if (env.gcs.credentialsJson) { try { opts.credentials = JSON.parse(env.gcs.credentialsJson); } catch { /* ignore */ } }
    if (env.gcs.projectId) opts.projectId = env.gcs.projectId;
    _bucket = new Storage(opts).bucket(name);
    return _bucket;
  } catch (e) {
    logger.warn('brandingUploadService: could not init Storage', e.message);
    _bucket = false;
    return null;
  }
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/**
 * Upload a buffer. `kind` = 'logo' | 'icon'. `slug` optional (uses 'new' for
 * pre-creation uploads). `tsSuffix` is a caller-supplied unique suffix (no
 * Date.now in this module so it stays deterministic/testable). Returns { url }.
 */
async function upload({ buffer, mimetype, kind = 'logo', slug = 'new', tsSuffix }) {
  const bkt = bucket();
  if (!bkt) throw new Error('Artifact bucket not configured (GCP_ARTIFACT_BUCKET / GCS_BUCKET)');
  const ext = EXT[mimetype] || 'png';
  const safeSlug = String(slug || 'new').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'new';
  const suffix = tsSuffix || Math.floor(Date.now() / 1000);
  const objectName = `branding/${safeSlug}/${kind}-${suffix}.${ext}`;
  const file = bkt.file(objectName);
  await file.save(buffer, {
    resumable: false,
    contentType: mimetype,
    metadata: { cacheControl: 'public, max-age=31536000' },
  });
  const url = `https://storage.googleapis.com/${bkt.name}/${objectName}`;
  logger.info('Branding asset uploaded', { objectName, bytes: buffer.length });
  return { url, objectName };
}

module.exports = { upload };
