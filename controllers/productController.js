const asyncHandler = require('../utils/asyncHandler');
const { toRupees } = require('../utils/money');
const AppError = require('../utils/AppError');
const translateService = require('../services/translateService');

/** Requester's language: authed user → ?language= → x-lang header → en. */
function reqLang(req) {
  return (req.user && req.user.language) || req.query.language || req.headers['x-lang'] || 'en';
}

/** Localize a product's name + description into `lang` (translate-on-read+cache,
 *  no English fallback). Mutates the lean object in place. No-op for English. */
async function localizeProduct(ctx, p, lang) {
  if (!p || !lang || lang === 'en') return;
  const [name, description] = await Promise.all([
    translateService.localizeText(ctx, p.name, lang),
    translateService.localizeText(ctx, p.description, lang),
  ]);
  p.name = name;
  if (p.description != null) p.description = description;
}

exports.list = asyncHandler(async (req, res) => {
  const Product = req.model('Product');
  const { category, q, page = '1', limit = '20', all, minPrice, maxPrice, sort } = req.query;
  // Public RudraStore (the global shop): show ONLY admin-owned catalog products
  // (`astrologer: null`), active + in stock. Admin products are authored by the
  // admin so they need NO approval gate (legacy/admin docs have status undefined,
  // not 'approved' — gating on 'approved' wrongly hid all 51 of them). Astrologer-
  // owned storefront products belong on each astrologer's own storefront page
  // (GET /astrologers/:id/storefront) and must NOT leak into the global shop or
  // its category screens. Admin (all=true) still sees everything.
  const filter = all === 'true'
    ? {}
    : { isActive: true, stock: { $gt: 0 }, astrologer: null };
  if (category) filter.category = category;
  // Regex search (partial/prefix friendly) across name + denormalized category.
  const term = (q || '').trim();
  if (term) {
    const rx = { $regex: term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    filter.$or = [{ name: rx }, { categoryName: rx }];
  }
  // Price range (whole rupees).
  if (minPrice != null || maxPrice != null) {
    filter.price = {};
    if (minPrice != null && minPrice !== '') filter.price.$gte = parseInt(minPrice, 10);
    if (maxPrice != null && maxPrice !== '') filter.price.$lte = parseInt(maxPrice, 10);
  }

  // Sort: newest (default) | price-asc | price-desc | rating.
  const sortMap = { price_asc: { price: 1 }, price_desc: { price: -1 }, rating: { rating: -1 } };
  const sortBy = sortMap[sort] || { createdAt: -1 };

  const p = parseInt(page, 10);
  const l = Math.min(parseInt(limit, 10), 100);
  const [items, total] = await Promise.all([
    Product.find(filter).sort(sortBy).skip((p - 1) * l).limit(l).lean(),
    Product.countDocuments(filter),
  ]);
  const lang = reqLang(req);
  await Promise.all(items.map((it) => localizeProduct(req.ctx, it, lang)));
  res.json({ success: true, data: { items, total, page: p, limit: l } });
});

exports.get = asyncHandler(async (req, res) => {
  const Product = req.model('Product');
  const product = await Product.findById(req.params.id).populate('reviews.user', 'name').lean();
  if (!product) throw new AppError('Product not found', 404);
  await localizeProduct(req.ctx, product, reqLang(req));
  res.json({ success: true, data: product });
});

exports.create = asyncHandler(async (req, res) => {
  const Product = req.model('Product');
  const Category = req.model('Category');
  const body = { ...req.body, price: toRupees(req.body.priceRupees) };
  if (req.body.mrpRupees != null) body.mrp = toRupees(req.body.mrpRupees);
  delete body.priceRupees; delete body.mrpRupees;
  if (body.category) {
    const cat = await Category.findById(body.category);
    if (cat) body.categoryName = cat.name;
  }
  const product = await Product.create(body);
  // System template: announce the new product to all users (if enabled).
  require('../services/broadcastService').fireEvent(req.ctx, 'product_added', {
    vars: { productName: product.name, price: product.price },
  });
  res.status(201).json({ success: true, data: product });
});

exports.update = asyncHandler(async (req, res) => {
  const Product = req.model('Product');
  const Category = req.model('Category');
  const body = { ...req.body };
  if (body.priceRupees != null) { body.price = toRupees(body.priceRupees); delete body.priceRupees; }
  if (body.mrpRupees != null) { body.mrp = toRupees(body.mrpRupees); delete body.mrpRupees; }
  if (body.category) {
    const cat = await Category.findById(body.category);
    if (cat) body.categoryName = cat.name;
  }
  const product = await Product.findByIdAndUpdate(req.params.id, body, { new: true });
  if (!product) throw new AppError('Product not found', 404);
  res.json({ success: true, data: product });
});

exports.remove = asyncHandler(async (req, res) => {
  const Product = req.model('Product');
  await Product.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

exports.addReview = asyncHandler(async (req, res) => {
  const Product = req.model('Product');
  const product = await Product.findById(req.params.id);
  if (!product) throw new AppError('Product not found', 404);
  product.reviews = product.reviews.filter((r) => String(r.user) !== String(req.user._id));
  product.reviews.push({ user: req.user._id, rating: req.body.rating, comment: req.body.comment });
  product.reviewCount = product.reviews.length;
  product.rating = product.reviews.reduce((s, r) => s + r.rating, 0) / product.reviews.length;
  await product.save();
  res.json({ success: true, data: { rating: product.rating, reviewCount: product.reviewCount } });
});
