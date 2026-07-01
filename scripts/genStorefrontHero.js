/**
 * One-off: generate the storefront hero (Imagen) with the CURRENT prompt for a
 * real astrologer, save the PNG locally to inspect, AND do the production path —
 * upload to GCS + patch StorefrontLayout.spec.heroImage in the DB.
 *
 *   node scripts/genStorefrontHero.js [astrologerUserId]
 *
 * Auth: uses whatever gcloud Application Default Credentials are active. We blank
 * GCS_KEY_FILE so the SDKs fall back to ADC (the committed key file is absent).
 */
require('dotenv').config();

// Force ADC: the committed gcs-key.json path is missing locally.
process.env.GCS_KEY_FILE = '';
process.env.GCS_CREDENTIALS_JSON = '';
// Make sure Vertex/genai + GCS bill the right project.
process.env.GCS_PROJECT_ID = process.env.GCS_PROJECT_ID || 'rudraganga';
process.env.VERTEX_PROJECT_ID = process.env.VERTEX_PROJECT_ID || process.env.GCS_PROJECT_ID;
process.env.GOOGLE_CLOUD_PROJECT = process.env.VERTEX_PROJECT_ID;

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { connectDB, disconnectDB } = require('../config/db');
const AstrologerProfile = require('../models/AstrologerProfile');
const StorefrontLayout = require('../models/StorefrontLayout');
const llmService = require('../services/llmService');
const uploadService = require('../services/uploadService');
const prompt = require('../services/prompts/storefrontDesign');

(async () => {
  await connectDB();

  const argId = process.argv[2];
  // Pick the target astrologer: explicit arg, else one that already has an
  // active layout (so we patch a real, visible storefront).
  let profile;
  if (argId) {
    profile = await AstrologerProfile.findOne({ user: argId }).lean();
  } else {
    profile = await AstrologerProfile.findOne({ activeStorefrontLayout: { $ne: null } })
      .sort({ updatedAt: -1 }).lean();
  }
  if (!profile) { console.error('No astrologer profile found'); process.exit(1); }

  const expertise = profile.expertise || [];
  console.log('Astrologer:', profile.displayName, '| user:', String(profile.user));
  console.log('Expertise:', expertise.join(', ') || '(none)');

  // Use the active layout's spec if present, else a minimal stub (the image
  // prompt only reads expertise + spec mood, not exact hexes).
  const layout = profile.activeStorefrontLayout
    ? await StorefrontLayout.findById(profile.activeStorefrontLayout)
    : null;
  const spec = (layout && layout.spec) || { name: 'Preview', accent: '#E8A33D' };

  const imgPrompt = prompt.buildImagePrompt({ spec, expertise });
  console.log('\n--- IMAGE PROMPT ---\n' + imgPrompt + '\n--------------------\n');

  console.log('Calling Imagen (', process.env.IMAGEN_MODEL || 'imagen-4.0-fast-generate-001', ')...');
  const png = await llmService.generateImage({
    prompt: imgPrompt,
    aspectRatio: '9:16',
    logMeta: { feature: 'storefrontDesign:manual', astrologer: String(profile.user) },
  });

  if (!png || !png.length) {
    console.error('❌ Imagen returned no bytes (auth/quota/model issue). Aborting.');
    await disconnectDB();
    process.exit(2);
  }

  // 1) Save locally so we can SHOW it.
  const outDir = path.resolve(__dirname, '../public/_preview');
  fs.mkdirSync(outDir, { recursive: true });
  const localPath = path.join(outDir, `storefront-hero-${Date.now()}.png`);
  fs.writeFileSync(localPath, png);
  console.log('✅ Saved local PNG:', localPath, `(${(png.length / 1024).toFixed(0)} KB)`);

  // 2) Production path: upload to GCS + patch the layout in the DB.
  if (uploadService.isConfigured() && layout) {
    const { url } = await uploadService.uploadImage(png, `storefront-hero-${Date.now()}.png`);
    if (url) {
      await StorefrontLayout.updateOne(
        { _id: layout._id },
        { $set: { 'spec.heroImage': url, 'spec.heroPending': false } },
      );
      console.log('✅ Uploaded + DB patched. heroImage =', url);
    } else {
      console.warn('⚠️  Upload returned no URL; DB not patched.');
    }
  } else {
    console.warn('⚠️  uploadService not configured or no active layout; skipped GCS+DB write.');
  }

  console.log('\nLOCAL_PNG=' + localPath);
  await disconnectDB();
  process.exit(0);
})().catch(async (e) => {
  console.error('FATAL', e);
  try { await disconnectDB(); } catch {}
  process.exit(1);
});
