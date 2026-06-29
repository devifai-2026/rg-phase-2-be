const mongoose = require('mongoose');

const productReviewSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    rating: { type: Number, min: 1, max: 5, required: true },
    comment: { type: String, maxlength: 1000 },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', index: true },
    categoryName: { type: String }, // denormalized for fast filtering
    images: [{ type: String }],
    description: { type: String },
    // mrp = original/struck-through price; price = actual selling price (charged).
    mrp: { type: Number, default: 0, min: 0, set: (v) => Math.round(Number(v) || 0) }, // whole rupees
    price: { type: Number, required: true, min: 0, set: (v) => Math.round(Number(v) || 0) }, // selling price (whole rupees)
    stock: { type: Number, default: 0, min: 0 },

    // ── Real, system-tracked metrics ──
    rating: { type: Number, default: 0 },          // computed avg of real reviews
    reviewCount: { type: Number, default: 0 },     // count of real reviews
    reviews: [productReviewSchema],
    soldCount: { type: Number, default: 0, min: 0 }, // real units sold (incremented at checkout)

    // ── Admin-seeded social proof (shown UNTIL real activity exceeds the
    //    threshold below, then the real numbers take over). Lets a new store
    //    look active before it has organic sales/reviews. ──
    manualSoldCount: { type: Number, default: 0, min: 0 },
    manualRating: { type: Number, default: 0, min: 0, max: 5 },
    manualReviewCount: { type: Number, default: 0, min: 0 },
    highlights: [{ type: String }], // optional admin bullet content ("100% authentic", etc.)

    isActive: { type: Boolean, default: true },

    // ── Astrologer-owned storefront items ──
    // `astrologer` is the owning astrologer's User id (null = global admin
    // catalog product, the original behavior). Astrologer-created products go
    // through an approval workflow before they appear on the public storefront.
    astrologer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    status: { type: String, enum: ['approved', 'pending', 'rejected'], default: 'approved', index: true },
    commissionPercent: { type: Number, default: 0, min: 0, max: 100 }, // admin-set on approval
    adminNote: { type: String, maxlength: 500 }, // rejection reason / note to the astrologer
  },
  { timestamps: true }
);

productSchema.index({ name: 'text', description: 'text' });

// Once REAL activity crosses this, real numbers replace the admin seed values.
const REAL_THRESHOLD = 10;

productSchema.virtual('discountPercent').get(function () {
  if (this.mrp && this.mrp > this.price) return Math.round(((this.mrp - this.price) / this.mrp) * 100);
  return 0;
});
// Display values: real if it has crossed the threshold, else the admin seed.
productSchema.virtual('displaySold').get(function () {
  return this.soldCount > REAL_THRESHOLD ? this.soldCount : (this.manualSoldCount || this.soldCount);
});
productSchema.virtual('displayRating').get(function () {
  return this.reviewCount > REAL_THRESHOLD ? this.rating : (this.manualRating || this.rating);
});
productSchema.virtual('displayReviewCount').get(function () {
  return this.reviewCount > REAL_THRESHOLD ? this.reviewCount : (this.manualReviewCount || this.reviewCount);
});
productSchema.set('toJSON', { virtuals: true });
productSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Product', productSchema);
