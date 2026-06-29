const Coupon = require('../models/Coupon');
const Bundle = require('../models/Bundle');
const Product = require('../models/Product');
const AppError = require('../utils/AppError');

/**
 * Validate a coupon against a cart and compute the discount (whole rupees).
 * cart = { items: [{ product, qty, price, category }], subtotal }
 */
async function validateCoupon({ code, userId, cart }) {
  const coupon = await Coupon.findOne({ code: String(code || '').toUpperCase().trim() });
  if (!coupon) throw new AppError('Invalid coupon code', 404);
  if (!coupon.isActive) throw new AppError('This coupon is not active', 400);

  const now = Date.now();
  if (coupon.validFrom && now < new Date(coupon.validFrom).getTime()) throw new AppError('Coupon not yet valid', 400);
  if (coupon.validUntil && now > new Date(coupon.validUntil).getTime()) throw new AppError('Coupon has expired', 400);

  const subtotal = cart.subtotal || 0;
  if (subtotal < coupon.minOrderValue) throw new AppError(`Minimum order of ₹${coupon.minOrderValue} required`, 400);

  if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) throw new AppError('Coupon usage limit reached', 400);
  if (coupon.perUserLimit && userId) {
    const u = coupon.usedBy.find((x) => String(x.user) === String(userId));
    if (u && u.count >= coupon.perUserLimit) throw new AppError('You have already used this coupon', 400);
  }

  // Eligible amount depends on scope.
  let eligible = subtotal;
  if (coupon.scope !== 'all') {
    const targetIds = coupon.targets.map(String);
    eligible = (cart.items || []).reduce((sum, it) => {
      const match = coupon.scope === 'product'
        ? targetIds.includes(String(it.product))
        : targetIds.includes(String(it.category));
      return match ? sum + it.price * it.qty : sum;
    }, 0);
    if (eligible <= 0) throw new AppError('Coupon does not apply to these items', 400);
  }

  let discount = coupon.type === 'percentage' ? Math.round((eligible * coupon.value) / 100) : coupon.value;
  if (coupon.type === 'percentage' && coupon.maxDiscount > 0) discount = Math.min(discount, coupon.maxDiscount);
  discount = Math.min(discount, subtotal); // never exceed the order

  return { code: coupon.code, discount, type: coupon.type, value: coupon.value, couponId: coupon._id };
}

/** Mark a coupon used (call after a successful order). */
async function consumeCoupon(couponId, userId) {
  if (!couponId) return;
  await Coupon.updateOne({ _id: couponId }, { $inc: { usedCount: 1 } });
  if (userId) {
    const c = await Coupon.findById(couponId);
    const entry = c.usedBy.find((x) => String(x.user) === String(userId));
    if (entry) await Coupon.updateOne({ _id: couponId, 'usedBy.user': userId }, { $inc: { 'usedBy.$.count': 1 } });
    else await Coupon.updateOne({ _id: couponId }, { $push: { usedBy: { user: userId, count: 1 } } });
  }
}

/** Bundles to surface on a product page, priced. */
async function bundlesForProduct(productId) {
  const bundles = await Bundle.find({ isActive: true, $or: [{ anchorProduct: productId }, { products: productId }] })
    .populate('products', 'name price mrp images');
  return bundles.map((bd) => priceBundle(bd)).filter(Boolean);
}

/** All active, priced bundles (for the app's Bundles section / offers strip). */
async function listActiveBundles({ limit = 50 } = {}) {
  const bundles = await Bundle.find({ isActive: true })
    .sort({ createdAt: -1 }).limit(limit)
    .populate('products', 'name price mrp images');
  return bundles.map((bd) => priceBundle(bd)).filter(Boolean);
}

function priceBundle(bd) {
  const products = (bd.products || []).filter(Boolean);
  if (products.length < 2) return null;
  const original = products.reduce((s, p) => s + (p.price || 0), 0);
  const bundlePrice = bd.pricingMode === 'fixed'
    ? bd.bundlePrice
    : Math.round(original * (1 - (bd.discountPercent || 0) / 100));
  return {
    id: String(bd._id),
    name: bd.name,
    products: products.map((p) => ({ id: String(p._id), name: p.name, price: p.price, image: p.images?.[0] })),
    originalTotal: original,
    bundlePrice,
    youSave: Math.max(0, original - bundlePrice),
  };
}

module.exports = { validateCoupon, consumeCoupon, bundlesForProduct, listActiveBundles, priceBundle };
