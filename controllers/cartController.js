const asyncHandler = require('../utils/asyncHandler');
const Cart = require('../models/Cart');
const Product = require('../models/Product');
const AppError = require('../utils/AppError');

/**
 * Persistent per-user cart. Prices/stock/availability are ALWAYS resolved from
 * the live Product (never trusted from the stored cart). Inactive/deleted
 * products are dropped from the response. Returns a hydrated view + totals.
 */
async function hydrate(cart) {
  const out = { items: [], subtotal: 0, mrpTotal: 0, count: 0 };
  if (!cart || !cart.items.length) return out;
  const ids = cart.items.map((i) => i.product);
  const products = await Product.find({ _id: { $in: ids }, isActive: true }).lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  for (const it of cart.items) {
    const p = byId.get(String(it.product));
    if (!p) continue; // product gone / inactive → skip
    const qty = Math.min(it.qty, p.stock > 0 ? p.stock : it.qty); // clamp to stock
    const lineTotal = p.price * qty;
    out.items.push({
      product: p._id,
      name: p.name,
      image: (p.images && p.images[0]) || null,
      price: p.price,
      mrp: p.mrp || 0,
      stock: p.stock,
      qty,
      lineTotal,
    });
    out.subtotal += lineTotal;
    out.mrpTotal += (p.mrp || p.price) * qty;
    out.count += qty;
  }
  return out;
}

async function getOrCreate(userId) {
  let cart = await Cart.findOne({ user: userId });
  if (!cart) cart = await Cart.create({ user: userId, items: [] });
  return cart;
}

/** GET /cart — the user's hydrated cart. */
exports.get = asyncHandler(async (req, res) => {
  const cart = await Cart.findOne({ user: req.user._id });
  res.json({ success: true, data: await hydrate(cart) });
});

/** POST /cart/items { productId, qty } — add (or increment) an item. */
exports.addItem = asyncHandler(async (req, res) => {
  const { productId } = req.body;
  const qty = Math.max(1, parseInt(req.body.qty || '1', 10));
  const product = await Product.findById(productId);
  if (!product || !product.isActive) throw new AppError('Product unavailable', 400);
  if (product.stock < 1) throw new AppError('Out of stock', 409);

  const cart = await getOrCreate(req.user._id);
  const line = cart.items.find((i) => String(i.product) === String(productId));
  const nextQty = (line ? line.qty : 0) + qty;
  if (nextQty > product.stock) throw new AppError(`Only ${product.stock} in stock`, 409);
  if (line) line.qty = nextQty;
  else cart.items.push({ product: productId, qty });
  await cart.save();
  res.status(201).json({ success: true, data: await hydrate(cart) });
});

/** PATCH /cart/items/:productId { qty } — set absolute quantity (0 removes). */
exports.updateItem = asyncHandler(async (req, res) => {
  const { productId } = req.params;
  const qty = parseInt(req.body.qty, 10);
  const cart = await getOrCreate(req.user._id);
  const line = cart.items.find((i) => String(i.product) === String(productId));
  if (!line) throw new AppError('Item not in cart', 404);
  if (!qty || qty < 1) {
    cart.items = cart.items.filter((i) => String(i.product) !== String(productId));
  } else {
    const product = await Product.findById(productId);
    if (!product || !product.isActive) throw new AppError('Product unavailable', 400);
    if (qty > product.stock) throw new AppError(`Only ${product.stock} in stock`, 409);
    line.qty = qty;
  }
  await cart.save();
  res.json({ success: true, data: await hydrate(cart) });
});

/** DELETE /cart/items/:productId — remove a line. */
exports.removeItem = asyncHandler(async (req, res) => {
  const { productId } = req.params;
  const cart = await getOrCreate(req.user._id);
  cart.items = cart.items.filter((i) => String(i.product) !== String(productId));
  await cart.save();
  res.json({ success: true, data: await hydrate(cart) });
});

/** DELETE /cart — empty the cart. */
exports.clear = asyncHandler(async (req, res) => {
  await Cart.findOneAndUpdate({ user: req.user._id }, { $set: { items: [] } }, { upsert: true });
  res.json({ success: true, data: await hydrate(null) });
});

// Exposed so the order/checkout flow can read + clear the cart server-side.
exports.hydrate = hydrate;
exports.getOrCreate = getOrCreate;
