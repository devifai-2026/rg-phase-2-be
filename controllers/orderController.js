const asyncHandler = require('../utils/asyncHandler');
const Order = require('../models/Order');
const Product = require('../models/Product');
const payuService = require('../services/payuService');
const notificationService = require('../services/notificationService');
const AppError = require('../utils/AppError');

// Customer-facing copy per status — drives both the push notification and the
// admin timeline label. Keep the keys in sync with the Order status enum.
const STATUS_COPY = {
  confirmed: { label: 'Order confirmed', body: 'Your order is confirmed and being prepared.' },
  packed: { label: 'Order packed', body: 'Your order has been packed and is ready to ship.' },
  shipped: { label: 'Order shipped', body: 'Your order has shipped and is on the way.' },
  out_for_delivery: { label: 'Out for delivery', body: 'Your order is out for delivery today.' },
  delivered: { label: 'Order delivered', body: 'Your order has been delivered. Enjoy! 🙏' },
  cancelled: { label: 'Order cancelled', body: 'Your order has been cancelled.' },
  refunded: { label: 'Order refunded', body: 'Your order has been refunded.' },
};
const statusCopy = (s) => STATUS_COPY[s] || { label: `Order ${s}`, body: `Your order is now ${s}.` };

/** Append a timeline entry (mutates the order; caller saves). */
function pushTimeline(order, status, { label, note } = {}) {
  order.timeline = order.timeline || [];
  order.timeline.push({ status, label: label || statusCopy(status).label, note, at: new Date() });
}

/** Resolve the delivery address from a saved addressId or an inline address. */
function resolveAddress(req) {
  const { addressId } = req.body;
  if (addressId) {
    const saved = req.user.addresses.id(addressId);
    if (!saved) throw new AppError('Address not found', 404);
    return { name: saved.name, phone: saved.phone, line1: saved.line1, line2: saved.line2, city: saved.city, state: saved.state, pincode: saved.pincode };
  }
  if (!req.body.address) throw new AppError('An address or addressId is required', 400);
  return req.body.address;
}

/**
 * Wallet checkout: build the order from the user's CART (or `items` in body),
 * debit the wallet atomically, decrement stock, confirm the order, clear the
 * cart, and generate the invoice. The wallet debit is idempotent on the txnid.
 */
exports.checkoutWallet = asyncHandler(async (req, res) => {
  const address = resolveAddress(req);

  // Source the lines from the server cart unless explicit items are passed.
  let items = req.body.items;
  const cartCtrl = require('./cartController');
  let cart = null;
  if (!items || !items.length) {
    cart = await cartCtrl.getOrCreate(req.user._id);
    const view = await cartCtrl.hydrate(cart);
    if (!view.items.length) throw new AppError('Your cart is empty', 400);
    items = view.items.map((i) => ({ productId: i.product, qty: i.qty }));
  }

  // Re-validate every line against the live product (price + stock).
  const built = [];
  let subtotal = 0;
  for (const it of items) {
    const product = await Product.findById(it.productId);
    if (!product || !product.isActive) throw new AppError(`Product unavailable: ${it.productId}`, 400);
    if (product.stock < it.qty) throw new AppError(`Insufficient stock for ${product.name}`, 409);
    built.push({ product: product._id, nameSnapshot: product.name, priceSnapshot: product.price, qty: it.qty });
    subtotal += product.price * it.qty;
  }
  if (subtotal < 1) throw new AppError('Invalid order total', 400);

  // Re-validate the coupon server-side (never trust a client-sent discount).
  let discount = 0, couponId, couponCode;
  if (req.body.couponCode) {
    const cart = { items: built.map((b) => ({ product: b.product, price: b.priceSnapshot, qty: b.qty })), subtotal };
    try {
      const res2 = await require('../services/offersService').validateCoupon({ code: req.body.couponCode, userId: req.user._id, cart });
      if (res2 && res2.discount > 0) { discount = res2.discount; couponId = res2.couponId; couponCode = req.body.couponCode; }
    } catch (_) {/* invalid coupon → ignore, charge full */}
  }

  // Apply admin-configured store charges (delivery/gst/shipping/platform) on
  // the item subtotal. All default off → no charges until an admin enables them.
  const charges = await require('./storeChargesController').getOrCreate();
  const { lines, total: chargesTotal } = charges.computeFor(subtotal);
  const total = Math.max(1, subtotal - discount + chargesTotal);

  const txnid = payuService.newTxnId('ord');
  const order = await Order.create({
    user: req.user._id, items: built, address,
    subtotal, charges: lines, chargesTotal, discount, couponId, couponCode, total,
    paymentId: txnid, status: 'created', paymentStatus: 'pending',
  });

  // Atomic wallet debit (throws 402 if insufficient; idempotent on refId).
  const walletService = require('../services/walletService');
  try {
    await walletService.debit({
      userId: req.user._id, amount: total, source: 'product',
      description: `Store order ${String(order._id).slice(-6)}`, refId: txnid,
      meta: { orderId: String(order._id) },
    });
  } catch (e) {
    order.paymentStatus = 'failed';
    await order.save();
    throw e; // 402 insufficient balance bubbles to the client
  }

  // Paid → decrement stock + bump real soldCount (guarded), confirm, invoice,
  // clear cart, notify.
  if (!order.stockDecremented) {
    for (const item of order.items) {
      await Product.updateOne(
        { _id: item.product, stock: { $gte: item.qty } },
        { $inc: { stock: -item.qty, soldCount: item.qty } }
      );
    }
    order.stockDecremented = true;
  }
  order.paymentStatus = 'paid';
  order.status = 'confirmed';
  pushTimeline(order, 'paid', { label: 'Payment received', note: 'Paid from wallet' });
  pushTimeline(order, 'confirmed');
  await order.save();

  // Consume the coupon (usage counters) once the order is paid.
  if (order.couponId) {
    require('../services/offersService').consumeCoupon(order.couponId, req.user._id).catch(() => {});
  }

  if (cart) { cart.items = []; await cart.save(); } // empty the server cart
  else { await require('../models/Cart').findOneAndUpdate({ user: req.user._id }, { $set: { items: [] } }); }

  // Auto-credit any astrologer-owned items' sellers (idempotent; non-fatal).
  require('../services/storeEarningsService').creditAstrologersForOrder(order).catch(() => {});

  require('../services/invoiceService').createForOrder(order).catch((err) => require('../utils/logger').warn('invoice gen failed', err.message));
  const confirmCopy = statusCopy('confirmed');
  notificationService.notify(req.user._id, {
    type: 'order_status', title: confirmCopy.label,
    body: 'Paid from your wallet. Your order is confirmed.',
    data: { orderId: String(order._id), status: 'confirmed' },
  }).catch(() => {});
  // Live admin-console badge + bell.
  require('../websockets/emit').adminActivity('order', { id: order._id, title: `New order ₹${order.total}` });

  res.status(201).json({ success: true, data: { order } });
});

/** Create an order from cart items and start a PayU payment. */
exports.create = asyncHandler(async (req, res) => {
  const { items, addressId } = req.body;
  // Resolve a saved address by id, else use the inline address.
  let address = req.body.address;
  if (addressId) {
    const saved = req.user.addresses.id(addressId);
    if (!saved) throw new AppError('Address not found', 404);
    address = { name: saved.name, phone: saved.phone, line1: saved.line1, line2: saved.line2, city: saved.city, state: saved.state, pincode: saved.pincode };
  }
  if (!address) throw new AppError('An address or addressId is required', 400);

  const built = [];
  let total = 0;
  for (const it of items) {
    const product = await Product.findById(it.productId);
    if (!product || !product.isActive) throw new AppError(`Product unavailable: ${it.productId}`, 400);
    if (product.stock < it.qty) throw new AppError(`Insufficient stock for ${product.name}`, 409);
    built.push({ product: product._id, nameSnapshot: product.name, priceSnapshot: product.price, qty: it.qty });
    total += product.price * it.qty;
  }

  const txnid = payuService.newTxnId('ord');
  const order = await Order.create({ user: req.user._id, items: built, address, total, paymentId: txnid, status: 'created', paymentStatus: 'pending' });

  const payment = payuService.buildPaymentRequest({
    txnid,
    amountRupees: total,
    productinfo: 'Store Order',
    firstname: req.user.name || 'User',
    email: req.user.email || 'user@example.com',
    phone: req.user.phone,
    udf: ['order', String(order._id)],
  });

  res.status(201).json({ success: true, data: { order, payment } });
});

// Invoice for an order (admin or the owning user).
exports.getInvoice = asyncHandler(async (req, res) => {
  const invoiceService = require('../services/invoiceService');
  const order = await Order.findById(req.params.id);
  if (!order) throw new AppError('Order not found', 404);
  // Owner or admin only (the admin route is already admin-guarded; the user
  // route relies on this check).
  if (req.user.role !== 'admin' && String(order.user) !== String(req.user._id)) {
    throw new AppError('Not authorized', 403);
  }
  let invoice = await invoiceService.getByOrder(order._id);
  // Backfill: if paid but no invoice yet (e.g. created before this feature), generate now.
  if (!invoice && order.paymentStatus === 'paid') invoice = await invoiceService.createForOrder(order);
  if (!invoice) throw new AppError('Invoice not available until the order is paid', 404);
  // Resolve the branding template so callers (admin print, app) can render it.
  // Falls back to the active/default template when the invoice predates stamping.
  let template = null;
  if (invoice.template) {
    template = await require('../models/InvoiceTemplate').findById(invoice.template);
  }
  if (!template) template = await invoiceService.defaultTemplate();
  res.json({ success: true, data: { ...invoice.toObject(), template } });
});

exports.listMine = asyncHandler(async (req, res) => {
  const items = await Order.find({ user: req.user._id }).sort({ createdAt: -1 });
  res.json({ success: true, data: items });
});

exports.get = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) throw new AppError('Order not found', 404);
  if (String(order.user) !== String(req.user._id) && req.user.role !== 'admin') throw new AppError('Not authorized', 403);
  res.json({ success: true, data: order });
});

// Build the Mongo filter from admin query params (shared by list + analytics).
function buildOrderFilter(query) {
  const q = { paymentStatus: 'paid' };
  if (query.status) q.status = query.status;
  if (query.from || query.to) {
    q.createdAt = {};
    if (query.from) q.createdAt.$gte = new Date(query.from);
    if (query.to) { const end = new Date(query.to); end.setHours(23, 59, 59, 999); q.createdAt.$lte = end; }
  }
  return q;
}

// ── Admin: lifecycle ──
exports.adminList = asyncHandler(async (req, res) => {
  // Only paid orders reach fulfillment (no COD; unpaid checkouts are hidden).
  const q = buildOrderFilter(req.query);
  let items = await Order.find(q).sort({ createdAt: -1 }).limit(500).populate('user', 'name phone');
  // Free-text search across order id / customer / pincode (post-filter — small set).
  const term = (req.query.q || '').trim().toLowerCase();
  if (term) {
    items = items.filter((o) => {
      const hay = [
        String(o._id), o.user?.name, o.user?.phone, o.address?.pincode, o.address?.city, o.couponCode,
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(term);
    });
  }
  res.json({ success: true, data: items });
});

// ── Admin: orders analytics (KPIs + time series + repeat-customer retention) ──
exports.adminAnalytics = asyncHandler(async (req, res) => {
  const match = buildOrderFilter(req.query);
  const orders = await Order.find(match).select('total status createdAt user').lean();

  const orderCount = orders.length;
  const revenue = orders.reduce((s, o) => s + (o.total || 0), 0);
  const aov = orderCount ? Math.round(revenue / orderCount) : 0;

  // Status breakdown.
  const byStatus = {};
  for (const o of orders) byStatus[o.status] = (byStatus[o.status] || 0) + 1;

  // Daily revenue + order count series (YYYY-MM-DD).
  const dayMap = {};
  for (const o of orders) {
    const d = new Date(o.createdAt).toISOString().slice(0, 10);
    dayMap[d] = dayMap[d] || { date: d, revenue: 0, orders: 0 };
    dayMap[d].revenue += o.total || 0;
    dayMap[d].orders += 1;
  }
  const series = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date));

  // Repeat-customer retention: how many customers ordered 1×, 2×, 3×, 4+ times
  // (within the filtered window), plus the top repeat buyers.
  const perUser = {};
  for (const o of orders) {
    const u = String(o.user);
    perUser[u] = perUser[u] || { user: u, orders: 0, spent: 0 };
    perUser[u].orders += 1;
    perUser[u].spent += o.total || 0;
  }
  const buckets = { '1': 0, '2': 0, '3': 0, '4+': 0 };
  for (const u of Object.values(perUser)) {
    const n = u.orders;
    buckets[n >= 4 ? '4+' : String(n)] += 1;
  }
  const totalCustomers = Object.keys(perUser).length;
  const repeatCustomers = Object.values(perUser).filter((u) => u.orders >= 2).length;
  const repeatRate = totalCustomers ? Math.round((repeatCustomers / totalCustomers) * 100) : 0;

  // Top repeat buyers (most orders, then most spent) — hydrate names.
  const topUsers = Object.values(perUser).filter((u) => u.orders >= 2)
    .sort((a, b) => b.orders - a.orders || b.spent - a.spent).slice(0, 10);
  const User = require('../models/User');
  const names = await User.find({ _id: { $in: topUsers.map((u) => u.user) } }).select('name phone').lean();
  const nameMap = Object.fromEntries(names.map((n) => [String(n._id), n.name || n.phone || '—']));
  const topRepeat = topUsers.map((u) => ({ user: u.user, name: nameMap[u.user] || '—', orders: u.orders, spent: u.spent }));

  res.json({
    success: true,
    data: {
      kpis: { orderCount, revenue, aov, totalCustomers, repeatCustomers, repeatRate },
      byStatus,
      series,
      retentionBuckets: buckets,
      topRepeat,
    },
  });
});

// Forward-only fulfillment workflow (cancel/refund allowed from non-terminal).
const ORDER_FLOW = ['confirmed', 'packed', 'shipped', 'out_for_delivery', 'delivered'];
exports.updateStatus = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) throw new AppError('Order not found', 404);
  const next = req.body.status;

  if (next === 'cancelled' || next === 'refunded') {
    if (['delivered'].includes(order.status)) throw new AppError(`Cannot ${next} a delivered order`, 409);
  } else {
    const curIdx = ORDER_FLOW.indexOf(order.status);
    const nextIdx = ORDER_FLOW.indexOf(next);
    if (nextIdx === -1) throw new AppError('Invalid status', 400);
    if (nextIdx < curIdx) throw new AppError(`Cannot move order backward from ${order.status} to ${next}`, 409);
  }
  order.status = next;
  pushTimeline(order, next);

  // Restock + nothing-to-refund-here (wallet not used for store) on cancel.
  if (next === 'cancelled' && order.stockDecremented) {
    for (const item of order.items) {
      await Product.updateOne({ _id: item.product }, { $inc: { stock: item.qty } });
    }
    order.stockDecremented = false;
  }
  await order.save();

  // Fire a customer notification on every status change.
  const copy = statusCopy(next);
  await notificationService.notify(order.user, {
    type: 'order_status',
    title: copy.label,
    body: copy.body,
    data: { orderId: String(order._id), status: next },
  });
  res.json({ success: true, data: order });
});

// ── Order support ("Need help" from the order detail screen) ──
const OrderSupport = require('../models/OrderSupport');
const orderNo = (id) => { const s = String(id); return s.length > 6 ? s.slice(-6).toUpperCase() : s.toUpperCase(); };

/** User: raise a help request for one of their orders. */
exports.createSupport = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) throw new AppError('Order not found', 404);
  if (String(order.user) !== String(req.user._id)) throw new AppError('Not authorized', 403);

  const ticket = await OrderSupport.create({
    order: order._id,
    user: req.user._id,
    category: req.body.category || 'other',
    message: req.body.message,
    contactPhone: req.body.contactPhone || req.user.phone,
    orderNoSnapshot: orderNo(order._id),
    status: 'new',
  });

  // Surface on the live admin console (badge/bell), same as new orders.
  require('../websockets/emit').adminActivity('order_support', {
    id: ticket._id, title: `Help needed · order #${ticket.orderNoSnapshot}`,
  });

  res.status(201).json({ success: true, data: ticket });
});

/** Admin: list order-support requests (optionally filtered by status). */
exports.adminListSupport = asyncHandler(async (req, res) => {
  const q = {};
  if (req.query.status && ['new', 'done'].includes(req.query.status)) q.status = req.query.status;
  const items = await OrderSupport.find(q)
    .sort({ createdAt: -1 })
    .limit(300)
    .populate('user', 'name phone')
    .populate('order', 'total status');
  res.json({ success: true, data: items });
});

/** Admin: flip a request's status (new ↔ done). */
exports.adminSetSupportStatus = asyncHandler(async (req, res) => {
  const ticket = await OrderSupport.findById(req.params.id);
  if (!ticket) throw new AppError('Support request not found', 404);
  ticket.status = req.body.status;
  if (req.body.status === 'done') { ticket.resolvedAt = new Date(); ticket.resolvedBy = req.user._id; }
  else { ticket.resolvedAt = undefined; ticket.resolvedBy = undefined; }
  await ticket.save();
  res.json({ success: true, data: ticket });
});
