const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const Product = require('../models/Product');
const PoojaType = require('../models/PoojaType');
const AstrologerProfile = require('../models/AstrologerProfile');

// Fields an astrologer may set on their own product. Admin-only fields
// (commissionPercent, status, adminNote) are never accepted from this path.
function pickProduct(body) {
  const out = {};
  for (const k of ['name', 'description', 'mrp', 'price', 'stock', 'categoryName', 'category']) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  if (Array.isArray(body.images)) out.images = body.images.filter((s) => typeof s === 'string');
  if (Array.isArray(body.highlights)) out.highlights = body.highlights.filter((s) => typeof s === 'string');
  return out;
}

function pickPooja(body) {
  const out = {};
  for (const k of ['name', 'description', 'basePrice', 'maxPersons', 'duration', 'durationUnit', 'durationNote', 'availableFrom', 'availableTo']) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  if (body.image) out.image = body.image;
  if (body.imagePortrait) out.imagePortrait = body.imagePortrait;
  if (body.imageLandscape) out.imageLandscape = body.imageLandscape;
  return out;
}

// ── Store theme ───────────────────────────────────────────────────────────
const STORE_THEMES = ['rudraksh', 'shiva', 'cosmic', 'royal', 'aurora', 'twilight', 'sapphire', 'lotus'];

/** Save the astrologer's chosen storefront template. PUT /astrologers/me/store-theme */
exports.setStoreTheme = asyncHandler(async (req, res) => {
  const theme = (req.body.theme || '').toString();
  if (!STORE_THEMES.includes(theme)) throw new AppError('Invalid store theme', 400);
  await AstrologerProfile.updateOne({ user: req.user._id }, { $set: { storeTheme: theme } });
  res.json({ success: true, data: { storeTheme: theme } });
});

// ── Astrologer product management ─────────────────────────────────────────
/** My products (all statuses, for the manage tab). GET /astrologers/me/products */
exports.myProducts = asyncHandler(async (req, res) => {
  const items = await Product.find({ astrologer: req.user._id }).sort({ createdAt: -1 }).lean();
  res.json({ success: true, data: items });
});

/**
 * The astrologer's SHAREABLE catalogue for the in-chat product picker: their own
 * approved, in-stock storefront items + the global RudraMaal (admin) catalogue —
 * the same set the AI recap suggests from. Optional ?q= name search. Each item
 * is tagged source ('storefront' | 'rudramaal'). GET /astrologers/me/catalogue
 */
exports.shareableCatalogue = asyncHandler(async (req, res) => {
  const aiInsights = require('../services/aiInsightsService');
  const all = await aiInsights.candidateProducts(req.user._id);
  const q = (req.query.q || '').toString().trim().toLowerCase();
  const filtered = q ? all.filter((p) => (p.name || '').toLowerCase().includes(q)) : all;
  const items = filtered.map((p) => ({
    id: String(p._id),
    name: p.name,
    price: p.price,
    image: Array.isArray(p.images) && p.images.length ? p.images[0] : null,
    category: p.categoryName || '',
    source: p.astrologer ? 'storefront' : 'rudramaal',
  }));
  res.json({ success: true, data: items });
});

/** Create a product (starts pending). POST /astrologers/me/products */
exports.createProduct = asyncHandler(async (req, res) => {
  const data = pickProduct(req.body);
  if (!data.name || data.price === undefined) throw new AppError('Name and price are required', 400);
  const product = await Product.create({
    ...data,
    astrologer: req.user._id,
    status: 'pending', // admin approval required before it goes live
    isActive: true,
  });
  res.status(201).json({ success: true, data: product });
});

/** Edit my product. Editing resets it to pending (re-review). Only my own. */
exports.updateProduct = asyncHandler(async (req, res) => {
  const product = await Product.findOne({ _id: req.params.id, astrologer: req.user._id });
  if (!product) throw new AppError('Product not found', 404);
  Object.assign(product, pickProduct(req.body));
  product.status = 'pending'; // any edit re-enters the approval queue
  product.adminNote = undefined;
  await product.save();
  res.json({ success: true, data: product });
});

/** Delete my product. DELETE /astrologers/me/products/:id */
exports.deleteProduct = asyncHandler(async (req, res) => {
  const r = await Product.deleteOne({ _id: req.params.id, astrologer: req.user._id });
  if (!r.deletedCount) throw new AppError('Product not found', 404);
  res.json({ success: true, data: { deleted: true } });
});

// ── Astrologer pooja management ───────────────────────────────────────────
exports.myPoojas = asyncHandler(async (req, res) => {
  const items = await PoojaType.find({ astrologer: req.user._id }).sort({ createdAt: -1 }).lean();
  res.json({ success: true, data: items });
});

exports.createPooja = asyncHandler(async (req, res) => {
  const data = pickPooja(req.body);
  if (!data.name || data.basePrice === undefined) throw new AppError('Name and price are required', 400);
  const pooja = await PoojaType.create({
    ...data,
    astrologer: req.user._id,
    status: 'pending',
    isActive: true,
    // Astrologer poojas are uncategorized by default; admin can assign on review.
    category: req.body.category || undefined,
  });
  res.status(201).json({ success: true, data: pooja });
});

exports.updatePooja = asyncHandler(async (req, res) => {
  const pooja = await PoojaType.findOne({ _id: req.params.id, astrologer: req.user._id });
  if (!pooja) throw new AppError('Pooja not found', 404);
  Object.assign(pooja, pickPooja(req.body));
  pooja.status = 'pending';
  pooja.adminNote = undefined;
  await pooja.save();
  res.json({ success: true, data: pooja });
});

exports.deletePooja = asyncHandler(async (req, res) => {
  const r = await PoojaType.deleteOne({ _id: req.params.id, astrologer: req.user._id });
  if (!r.deletedCount) throw new AppError('Pooja not found', 404);
  res.json({ success: true, data: { deleted: true } });
});

// ── Astrologer storefront ORDERS (read-only) ──────────────────────────────
/**
 * Orders that contain this astrologer's products. Read-only: the astrologer
 * sees only their own items + the order's fulfillment status (admin-controlled),
 * plus whether they've flagged it sent to admin. GET /astrologers/me/store-orders
 */
exports.myStoreOrders = asyncHandler(async (req, res) => {
  const Order = require('../models/Order');
  // Find this astrologer's product ids, then orders that include any of them.
  const myProductIds = await Product.find({ astrologer: req.user._id }).distinct('_id');
  if (!myProductIds.length) return res.json({ success: true, data: [] });

  const orders = await Order.find({ 'items.product': { $in: myProductIds }, paymentStatus: 'paid' })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  const mine = myProductIds.map(String);
  const data = orders.map((o) => {
    // Only expose THIS astrologer's line items + earnings, never the full bill.
    const items = (o.items || []).filter((it) => mine.includes(String(it.product)));
    return {
      id: String(o._id),
      shortId: String(o._id).slice(-6),
      status: o.status, // admin-controlled fulfillment status
      createdAt: o.createdAt,
      sentToAdmin: (o.sentToAdminBy || []).map(String).includes(String(req.user._id)),
      items: items.map((it) => ({
        productId: String(it.product),
        name: it.nameSnapshot,
        qty: it.qty,
        price: it.priceSnapshot,
      })),
    };
  });
  res.json({ success: true, data });
});

/**
 * Astrologer flags an order's item(s) as handed to the admin/fulfillment team.
 * Additive only — never changes the order's fulfillment status (admin-only).
 * POST /astrologers/me/store-orders/:id/sent
 */
exports.markOrderSentToAdmin = asyncHandler(async (req, res) => {
  const Order = require('../models/Order');
  const myProductIds = await Product.find({ astrologer: req.user._id }).distinct('_id');
  const order = await Order.findOne({ _id: req.params.id, 'items.product': { $in: myProductIds } });
  if (!order) throw new AppError('Order not found', 404);
  await Order.updateOne({ _id: order._id }, { $addToSet: { sentToAdminBy: req.user._id } });
  // Let the admin console know the seller dispatched their item.
  try { require('../websockets/emit').adminActivity('order', { id: order._id, title: `Astrologer sent items for order ${String(order._id).slice(-6)}` }); } catch (_) {}
  res.json({ success: true, data: { sentToAdmin: true } });
});

/** My pooja bookings (read-only): bookings for my poojas + their status. */
exports.myPoojaBookings = asyncHandler(async (req, res) => {
  const PoojaBooking = require('../models/PoojaBooking');
  const rows = await PoojaBooking.find({ astrologer: req.user._id, paymentStatus: 'paid' })
    .sort({ createdAt: -1 }).limit(100).lean();
  const data = rows.map((b) => ({
    id: String(b._id),
    poojaType: b.poojaType,
    status: b.status,
    price: b.price,
    contactName: b.contactName,
    preferredDate: b.preferredDate,
    createdAt: b.createdAt,
  }));
  res.json({ success: true, data });
});

// ── Admin approval workflow ───────────────────────────────────────────────
/**
 * Admin: list astrologer-submitted store items pending review (products +
 * poojas), or filter by ?status=. Only astrologer-owned items (astrologer != null).
 * GET /admin/store/submissions
 */
exports.adminListSubmissions = asyncHandler(async (req, res) => {
  const status = req.query.status || 'pending';
  const ownerFilter = { astrologer: { $ne: null }, status };
  const [products, poojas] = await Promise.all([
    Product.find(ownerFilter).sort({ createdAt: -1 }).populate('astrologer', 'name').lean(),
    PoojaType.find(ownerFilter).sort({ createdAt: -1 }).populate('astrologer', 'name').lean(),
  ]);
  res.json({ success: true, data: { products, poojas } });
});

/** Approve an astrologer's item, setting commission. PATCH /admin/store/:kind/:id/approve */
exports.adminApprove = asyncHandler(async (req, res) => {
  const Model = req.params.kind === 'pooja' ? PoojaType : Product;
  const commissionPercent = Math.max(0, Math.min(100, Number(req.body.commissionPercent) || 0));
  const item = await Model.findOneAndUpdate(
    { _id: req.params.id, astrologer: { $ne: null } },
    { $set: { status: 'approved', commissionPercent, adminNote: undefined } },
    { new: true }
  ).populate('astrologer', 'name');
  if (!item) throw new AppError('Item not found', 404);
  notifyOwner(item, 'store_item_approved', 'Your store item is live! 🎉', `"${item.name}" is approved and now visible on your storefront.`);
  res.json({ success: true, data: item });
});

/**
 * Admin edits an astrologer's submission (fix name/price/description/etc.)
 * without changing ownership or approval status. PATCH /admin/store/:kind/:id
 */
exports.adminEdit = asyncHandler(async (req, res) => {
  const isPooja = req.params.kind === 'pooja';
  const Model = isPooja ? PoojaType : Product;
  const fields = isPooja
    ? ['name', 'description', 'basePrice', 'maxPersons', 'duration', 'durationUnit', 'durationNote', 'availableFrom', 'availableTo', 'image', 'imagePortrait', 'imageLandscape', 'category', 'isActive', 'manualRating', 'manualReviewCount', 'manualBookedCount']
    : ['name', 'description', 'mrp', 'price', 'stock', 'categoryName', 'category', 'images', 'highlights', 'isActive', 'manualRating', 'manualReviewCount', 'manualSoldCount'];
  const update = {};
  for (const k of fields) if (req.body[k] !== undefined) update[k] = req.body[k];
  // Commission can be tuned here too (admin-only field).
  if (req.body.commissionPercent !== undefined) {
    update.commissionPercent = Math.max(0, Math.min(100, Number(req.body.commissionPercent) || 0));
  }
  const item = await Model.findOneAndUpdate(
    { _id: req.params.id, astrologer: { $ne: null } },
    { $set: update },
    { new: true }
  ).populate('astrologer', 'name');
  if (!item) throw new AppError('Item not found', 404);
  res.json({ success: true, data: item });
});

/** Reject an astrologer's item with a reason. PATCH /admin/store/:kind/:id/reject */
exports.adminReject = asyncHandler(async (req, res) => {
  const Model = req.params.kind === 'pooja' ? PoojaType : Product;
  const note = (req.body.adminNote || '').toString().slice(0, 500);
  const item = await Model.findOneAndUpdate(
    { _id: req.params.id, astrologer: { $ne: null } },
    { $set: { status: 'rejected', adminNote: note } },
    { new: true }
  ).populate('astrologer', 'name');
  if (!item) throw new AppError('Item not found', 404);
  notifyOwner(item, 'store_item_rejected', 'Store item needs changes', note || `"${item.name}" was not approved. Please review and resubmit.`);
  res.json({ success: true, data: item });
});

/** Tell the owning astrologer about an approval/rejection (push + in-app). */
function notifyOwner(item, type, title, body) {
  const ownerId = item.astrologer && (item.astrologer._id || item.astrologer);
  if (!ownerId) return;
  require('../services/notificationService')
    .notify(String(ownerId), { type, title, body, data: { type, kind: type } })
    .catch(() => {});
}

// ── Public storefront ─────────────────────────────────────────────────────
/**
 * Public link-in-bio storefront for an astrologer. Returns the chosen theme,
 * basic profile, and ONLY approved + active products/poojas (no pending/rejected
 * leaks to seekers). :id = AstrologerProfile id.
 */
exports.publicStorefront = asyncHandler(async (req, res) => {
  const profile = await AstrologerProfile.findById(req.params.id)
    .select('user displayName avatar coverPhoto bio storeTheme activeStorefrontLayout expertise followerSeed followerCount rating reviewCount')
    .populate('user', 'name')
    .populate('activeStorefrontLayout', 'spec') // AI-designed layout spec, when one is active
    .lean();
  if (!profile) throw new AppError('Astrologer not found', 404);

  const liveFilter = { astrologer: profile.user, status: 'approved', isActive: true };
  const [products, poojas] = await Promise.all([
    Product.find({ ...liveFilter, stock: { $gt: 0 } }).sort({ createdAt: -1 }).lean(),
    PoojaType.find(liveFilter).sort({ createdAt: -1 }).lean(),
  ]);

  // Localize ALL user-visible dynamic text to the requester's language: the
  // astrologer NAME (transliterated, e.g. "Ravi Kumar" → "रवि कुमार") + BIO, and
  // the product/pooja names + descriptions. Cache-backed so it's instant after
  // the first hit / the admin "Run translation" pre-warm.
  const translateService = require('../services/translateService');
  const { reqLang, localizeEach } = require('../utils/i18nReq');
  const lang = reqLang(req);
  const rawName = profile.displayName || (profile.user && profile.user.name) || 'Astrologer';
  const [name, bio] = await Promise.all([
    translateService.localizeText(rawName, lang),
    translateService.localizeText(profile.bio || '', lang),
    localizeEach(products, lang, ['name', 'description']),
    localizeEach(poojas, lang, ['name', 'description']),
  ]);

  res.json({
    success: true,
    data: {
      profile: {
        id: String(profile._id),
        name,
        avatar: profile.avatar || null,
        coverPhoto: profile.coverPhoto || null,
        bio: bio || '',
        expertise: profile.expertise || [],
        followers: (profile.followerSeed || 0) + (profile.followerCount || 0),
        rating: profile.rating || 0,
        reviewCount: profile.reviewCount || 0,
      },
      theme: profile.storeTheme || 'rudraksh',
      // AI-designed layout spec when one is active; null → app uses `theme`.
      layoutSpec: (profile.activeStorefrontLayout && profile.activeStorefrontLayout.spec) || null,
      products,
      poojas,
    },
  });
});
