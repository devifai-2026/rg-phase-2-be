const Product = require('../models/Product');
const PoojaType = require('../models/PoojaType');
const walletService = require('./walletService');
const emit = require('../websockets/emit');
const notificationService = require('./notificationService');
const logger = require('../utils/logger');

/** Astrologer's take-home for a sale: price minus the admin commission %. */
function astrologerShare(amount, commissionPercent) {
  const pct = Math.max(0, Math.min(100, Number(commissionPercent) || 0));
  return Math.round((Number(amount) || 0) * (100 - pct) / 100);
}

/**
 * Credit each astrologer their share for an order's astrologer-owned items.
 * Idempotent per (order, product) via refId, so replays/retries never double-pay.
 * Call AFTER the order is confirmed/paid. Best-effort: never throws into the
 * order flow (a failed credit is logged, not fatal).
 */
async function creditAstrologersForOrder(order) {
  try {
    for (const item of order.items || []) {
      const product = await Product.findById(item.product).select('astrologer commissionPercent name').lean();
      if (!product || !product.astrologer) continue; // global catalog item → no astrologer payout
      const gross = (item.priceSnapshot || 0) * (item.qty || 1);
      const share = astrologerShare(gross, product.commissionPercent);
      if (share < 1) continue;
      const credited = await walletService.credit({
        userId: product.astrologer,
        amount: share,
        source: 'product',
        description: `Store sale: ${product.name || item.nameSnapshot || 'product'}`,
        refId: `order:${order._id}:product:${item.product}:earning`, // idempotency key
        meta: { orderId: String(order._id), productId: String(item.product), qty: item.qty, commissionPercent: product.commissionPercent },
      });
      if (credited) {
        emit.toUser(product.astrologer, 'wallet-updated', await walletService.getBalance(product.astrologer));
        notificationService.notify(product.astrologer, {
          type: 'store_earning',
          title: 'New store sale! 💰',
          body: `You earned ₹${share} from "${product.name || 'a product'}".`,
          data: { type: 'store_earning', orderId: String(order._id), productId: String(item.product) },
        }).catch(() => {});
      }
    }
  } catch (e) {
    logger.warn('creditAstrologersForOrder failed', e.message);
  }
}

/**
 * Credit the astrologer their share for a paid pooja booking. Idempotent per
 * booking. Best-effort.
 */
async function creditAstrologerForBooking(booking) {
  try {
    if (!booking.poojaTypeId) return;
    const pooja = await PoojaType.findById(booking.poojaTypeId).select('astrologer commissionPercent name').lean();
    if (!pooja || !pooja.astrologer) return;
    const share = astrologerShare(booking.price, pooja.commissionPercent);
    if (share < 1) return;
    const credited = await walletService.credit({
      userId: pooja.astrologer,
      amount: share,
      source: 'pooja',
      description: `Pooja booking: ${pooja.name || booking.poojaType || 'pooja'}`,
      refId: `booking:${booking._id}:earning`,
      meta: { bookingId: String(booking._id), poojaId: String(booking.poojaTypeId), commissionPercent: pooja.commissionPercent },
    });
    if (credited) {
      emit.toUser(pooja.astrologer, 'wallet-updated', await walletService.getBalance(pooja.astrologer));
      notificationService.notify(pooja.astrologer, {
        type: 'store_earning',
        title: 'New pooja booking! 💰',
        body: `You earned ₹${share} from "${pooja.name || 'a pooja'}".`,
        data: { type: 'store_earning', bookingId: String(booking._id), poojaId: String(booking.poojaTypeId) },
      }).catch(() => {});
    }
  } catch (e) {
    logger.warn('creditAstrologerForBooking failed', e.message);
  }
}

/** Increment a pooja's real booked count on a paid booking (best-effort). */
async function bumpPoojaBooked(booking) {
  try {
    if (booking.poojaTypeId) await PoojaType.updateOne({ _id: booking.poojaTypeId }, { $inc: { bookedCount: 1 } });
  } catch (_) {/* non-fatal */}
}

module.exports = { creditAstrologersForOrder, creditAstrologerForBooking, bumpPoojaBooked, astrologerShare };
