const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const env = require('../config/env');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

/**
 * Image upload service. Prefers Google Cloud Storage (public-read URLs); falls
 * back to ImageBB, then to a mock placeholder — so flows work in any setup.
 * Used for profile photos, KYC docs, product/pooja images, matrimony photos.
 *
 * All callers use the same contract: uploadImage(buffer, name) -> { url }.
 */

// ── GCS (lazy singleton so the SDK only loads when configured) ──
let _bucket = null;
function gcsConfigured() {
  return !!(env.gcs.bucket && (env.gcs.keyFile || env.gcs.credentialsJson || env.gcs.projectId));
}
function getBucket() {
  if (_bucket) return _bucket;
  const { Storage } = require('@google-cloud/storage');
  const opts = {};
  if (env.gcs.projectId) opts.projectId = env.gcs.projectId;
  if (env.gcs.credentialsJson) {
    opts.credentials = JSON.parse(env.gcs.credentialsJson);
  } else if (env.gcs.keyFile) {
    opts.keyFilename = env.gcs.keyFile;
  }
  // If neither is set, the SDK uses Application Default Credentials (e.g. on GCP).
  _bucket = new Storage(opts).bucket(env.gcs.bucket);
  return _bucket;
}

function extFromName(name) {
  const e = (path.extname(name || '') || '').toLowerCase();
  return e && e.length <= 6 ? e : '.jpg';
}
function contentTypeFor(ext) {
  return {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.webp': 'image/webp', '.gif': 'image/gif', '.heic': 'image/heic', '.pdf': 'application/pdf',
  }[ext] || 'application/octet-stream';
}

async function uploadToGcs(buffer, name, { tenantSlug } = {}) {
  const bucket = getBucket();
  const ext = extFromName(name);
  // Unique, unguessable object name under the upload prefix. All tenants share
  // ONE bucket, so tenant uploads are namespaced under tenants/<slug>/ to keep
  // them logically isolated + listable/deletable per tenant.
  const rand = crypto.randomBytes(8).toString('hex');
  const safe = (name || 'image').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
  const prefix = tenantSlug && tenantSlug !== 'default'
    ? `tenants/${tenantSlug}/${env.gcs.uploadPrefix}`
    : env.gcs.uploadPrefix;
  const objectName = `${prefix}/${Date.now()}-${rand}-${safe}${safe.endsWith(ext) ? '' : ext}`;

  const file = bucket.file(objectName);
  await file.save(buffer, {
    resumable: false,
    contentType: contentTypeFor(ext),
    metadata: { cacheControl: 'public, max-age=31536000' },
  });
  // Public read is granted at the BUCKET level (allUsers → Storage Object Viewer)
  // because the bucket uses Uniform bucket-level access — per-object ACLs are
  // disabled, so we don't call makePublic() here.

  const url = `https://storage.googleapis.com/${env.gcs.bucket}/${encodeURI(objectName)}`;
  return { url, displayUrl: url, objectName };
}

function isConfigured() {
  return gcsConfigured() || !!env.imagebb.apiKey;
}

/** @param {Buffer} buffer  @param {string} [name] */
async function uploadImage(buffer, name, { tenantSlug } = {}) {
  if (!buffer || !buffer.length) throw new AppError('No image provided', 400);

  // 1) Google Cloud Storage (preferred).
  if (gcsConfigured()) {
    try {
      return await uploadToGcs(buffer, name, { tenantSlug });
    } catch (e) {
      logger.error('GCS upload failed', e.message);
      throw new AppError('Image upload failed', 502);
    }
  }

  // 2) ImageBB (legacy fallback).
  if (env.imagebb.apiKey) {
    const form = new URLSearchParams();
    form.append('image', buffer.toString('base64'));
    if (name) form.append('name', name);
    const { data } = await axios.post(
      `https://api.imgbb.com/1/upload?key=${env.imagebb.apiKey}`,
      form,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000, maxBodyLength: Infinity }
    );
    if (!data || !data.success) throw new AppError('Image upload failed', 502);
    return {
      url: data.data.url,
      displayUrl: data.data.display_url,
      deleteUrl: data.data.delete_url,
      thumb: data.data.thumb && data.data.thumb.url,
    };
  }

  // 3) Mock (no provider configured) — keeps dev flows working.
  logger.warn('[UPLOAD MOCK] no GCS/ImageBB configured; returning placeholder URL');
  return { url: `https://placehold.co/600x600?text=${encodeURIComponent(name || 'image')}`, mock: true };
}

module.exports = { uploadImage, isConfigured, uploadToGcs };
