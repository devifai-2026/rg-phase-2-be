const mongoose = require('mongoose');

/** Managed pooja catalog entry (like a product). Amounts are whole rupees. */
const poojaTypeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // Admin-managed category (Family / Person / Vastu / …). Required for the
    // global admin catalog, but NOT for astrologer-submitted poojas — those come
    // in uncategorized and the admin assigns a category on review/approval.
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PoojaCategory',
      // Only required when this is an admin/global pooja (no owning astrologer).
      required: function () { return this.astrologer == null; },
      index: true,
    },
    description: { type: String },
    // Two artwork shapes the app shows in different places. At least one is
    // required (the admin can upload either or both):
    //   imagePortrait  (3:4)  — used in the catalog list cards
    //   imageLandscape (16:9) — used on the pooja detail header
    // `image` is the legacy single field, kept for old records + fallback.
    image: { type: String },
    imagePortrait: { type: String },
    imageLandscape: { type: String },
    basePrice: { type: Number, default: 0, min: 0, set: (v) => Math.round(Number(v) || 0) },
    // Max number of people this pooja can be booked for (0–4). 0 = unspecified.
    maxPersons: { type: Number, default: 0, min: 0, max: 4, set: (v) => Math.round(Number(v) || 0) },
    // Duration as a number + unit the admin picks (minutes or hours).
    duration: { type: Number, default: 0, min: 0, set: (v) => Math.round(Number(v) || 0) },
    durationUnit: { type: String, enum: ['min', 'hr'], default: 'min' },
    durationNote: { type: String }, // legacy free-text (kept for old records)
    // Optional availability window — empty means bookable any day.
    availableFrom: { type: Date },
    availableTo: { type: Date },
    isActive: { type: Boolean, default: true, index: true },

    // ── Astrologer-owned offerings ──
    // `astrologer` = owning astrologer's User id (null = global admin catalog).
    // Astrologer-created poojas need admin approval before going on the store.
    astrologer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    status: { type: String, enum: ['approved', 'pending', 'rejected'], default: 'approved', index: true },
    commissionPercent: { type: Number, default: 0, min: 0, max: 100 },
    adminNote: { type: String, maxlength: 500 },

    // Real bookings counter (incremented on each paid booking).
    bookedCount: { type: Number, default: 0, min: 0 },
    // Admin-seeded social proof (display rating/reviews/booked; not real).
    manualRating: { type: Number, default: 0, min: 0, max: 5 },
    manualReviewCount: { type: Number, default: 0, min: 0 },
    manualBookedCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

// Show real numbers once they cross a threshold, else the admin seed.
const REAL_THRESHOLD = 10;
poojaTypeSchema.virtual('displayBooked').get(function () {
  return this.bookedCount > REAL_THRESHOLD ? this.bookedCount : (this.manualBookedCount || this.bookedCount);
});
poojaTypeSchema.virtual('displayRating').get(function () {
  return this.manualRating || 0;
});
poojaTypeSchema.virtual('displayReviewCount').get(function () {
  return this.manualReviewCount || 0;
});
poojaTypeSchema.set('toJSON', { virtuals: true });
poojaTypeSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('PoojaType', poojaTypeSchema);
