const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * Admin-managed promo banner shown in the app's auto-rotating carousel on Home.
 * The image is cropped to the app's banner aspect (~5:1) in the admin before
 * upload, so it fits the strip exactly without distortion. `link` is an optional
 * deep target the banner taps to (e.g. 'offers', 'pooja', a product id, or a URL).
 */
const bannerSchema = new mongoose.Schema(
  {
    // Where the banner appears: 'promo' = top auto-rotating carousel,
    // 'pooja' = the "Book a Pooja" banner slot. Both crop to the same 5:1 strip.
    placement: { type: String, enum: ['promo', 'pooja'], default: 'promo', index: true },
    // Banners are image-only: any text is baked into the cropped 5:1 image, so
    // there are no separate title/subtitle fields.
    image: { type: String, required: true }, // cropped 5:1 image (GCS public URL)
    link: { type: String, trim: true }, // optional tap target (slug / id / url)
    isActive: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 }, // lower shows first

    // Optional scheduling — banner only shows inside this window when set.
    scheduledFrom: { type: Date },
    scheduledTo: { type: Date },
  },
  { timestamps: true }
);

bannerSchema.index({ placement: 1, isActive: 1, sortOrder: 1 });

module.exports = defineModel('Banner', bannerSchema);