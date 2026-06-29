const asyncHandler = require('../utils/asyncHandler');
const Coupon = require('../models/Coupon');
const Bundle = require('../models/Bundle');
const Product = require('../models/Product');
const offersService = require('../services/offersService');
const AppError = require('../utils/AppError');

// ── Coupons (admin CRUD) ──
exports.listCoupons = asyncHandler(async (req, res) => {
  const items = await Coupon.find().sort({ createdAt: -1 });
  res.json({ success: true, data: items });
});
exports.createCoupon = asyncHandler(async (req, res) => {
  const body = { ...req.body, code: String(req.body.code).toUpperCase().trim() };
  const c = await Coupon.create(body);
  // System template: announce the new offer to all users (if enabled).
  const discount = c.type === 'percentage' ? `${c.value}%` : `₹${c.value}`;
  require('../services/broadcastService').fireEvent('offer_created', {
    vars: { code: c.code, title: c.description || 'a new offer', discount },
  });
  res.status(201).json({ success: true, data: c });
});
exports.updateCoupon = asyncHandler(async (req, res) => {
  const c = await Coupon.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!c) throw new AppError('Coupon not found', 404);
  res.json({ success: true, data: c });
});
exports.deleteCoupon = asyncHandler(async (req, res) => {
  await Coupon.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

// ── Public: validate a coupon against a cart ──
exports.validateCoupon = asyncHandler(async (req, res) => {
  const { code, items = [] } = req.body;
  // Build cart from product ids + qty (prices resolved server-side, never trusted from client).
  const ids = items.map((i) => i.productId);
  const products = await Product.find({ _id: { $in: ids } });
  const map = {}; products.forEach((p) => (map[String(p._id)] = p));
  const cartItems = items.map((i) => {
    const p = map[String(i.productId)];
    return p ? { product: p._id, category: p.category, price: p.price, qty: i.qty } : null;
  }).filter(Boolean);
  const subtotal = cartItems.reduce((s, it) => s + it.price * it.qty, 0);
  const result = await offersService.validateCoupon({ code, userId: req.user?._id, cart: { items: cartItems, subtotal } });
  res.json({ success: true, data: { ...result, subtotal, payable: subtotal - result.discount } });
});

// ── Bundles (admin CRUD) ──
exports.listBundles = asyncHandler(async (req, res) => {
  const items = await Bundle.find().sort({ createdAt: -1 }).populate('products', 'name price').populate('anchorProduct', 'name');
  res.json({ success: true, data: items });
});
exports.createBundle = asyncHandler(async (req, res) => {
  if (!req.body.products || req.body.products.length < 2) throw new AppError('A bundle needs at least 2 products', 400);
  const bd = await Bundle.create(req.body);
  res.status(201).json({ success: true, data: bd });
});
exports.updateBundle = asyncHandler(async (req, res) => {
  const bd = await Bundle.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!bd) throw new AppError('Bundle not found', 404);
  res.json({ success: true, data: bd });
});
exports.deleteBundle = asyncHandler(async (req, res) => {
  await Bundle.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

// ── Public: priced bundles for a product page ──
exports.bundlesForProduct = asyncHandler(async (req, res) => {
  const data = await offersService.bundlesForProduct(req.params.productId);
  res.json({ success: true, data });
});

// ── Public: all active priced bundles (Bundles section / offers strip) ──
exports.publicBundles = asyncHandler(async (req, res) => {
  const data = await offersService.listActiveBundles({ limit: Math.min(parseInt(req.query.limit || '50', 10), 100) });
  res.json({ success: true, data });
});

// ── Public: active coupons (offer strip; public-safe fields only) ──
exports.publicCoupons = asyncHandler(async (req, res) => {
  const now = new Date();
  const coupons = await Coupon.find({
    isActive: true,
    $and: [
      { $or: [{ validFrom: { $exists: false } }, { validFrom: null }, { validFrom: { $lte: now } }] },
      { $or: [{ validUntil: { $exists: false } }, { validUntil: null }, { validUntil: { $gte: now } }] },
    ],
  }).sort({ createdAt: -1 }).limit(30)
    .select('code description type value maxDiscount minOrderValue scope validUntil');
  res.json({ success: true, data: coupons });
});
