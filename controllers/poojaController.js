const asyncHandler = require('../utils/asyncHandler');
const PoojaBooking = require('../models/PoojaBooking');
const PoojaType = require('../models/PoojaType');
const PoojaCategory = require('../models/PoojaCategory');
const walletService = require('../services/walletService');
const invoiceService = require('../services/invoiceService');
const notificationService = require('../services/notificationService');
const { toRupees } = require('../utils/money');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');
const { reqLang, localizeFields, localizeEach } = require('../utils/i18nReq');

// User-visible pooja fields to localize (name + description; category label too).
const POOJA_I18N = ['name', 'description', 'category.name'];

// Active poojas are those flagged active AND inside their availability window
// (window is optional — empty from/to means always available).
function availableNowMatch() {
  const now = new Date();
  return {
    isActive: true,
    status: 'approved', // exclude astrologer poojas awaiting review (global = approved)
    $and: [
      { $or: [{ availableFrom: null }, { availableFrom: { $exists: false } }, { availableFrom: { $lte: now } }] },
      { $or: [{ availableTo: null }, { availableTo: { $exists: false } }, { availableTo: { $gte: now } }] },
    ],
  };
}

/** GET /poojas/categories — active categories for the app's filter chips. */
exports.listCategories = asyncHandler(async (req, res) => {
  const items = await PoojaCategory.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).select('name').lean();
  await localizeEach(items, reqLang(req), ['name']);
  res.json({ success: true, data: items });
});

/**
 * GET /poojas/types — active, currently-available poojas for the app.
 * Optional query: q (name search), category (id), maxPersons (min capacity),
 * maxPrice. Category is populated so the card can show its label.
 */
exports.listTypes = asyncHandler(async (req, res) => {
  const filter = availableNowMatch();
  if (req.query.category) filter.category = req.query.category;
  if (req.query.q) filter.name = { $regex: String(req.query.q).trim(), $options: 'i' };
  if (req.query.maxPrice) filter.basePrice = { $lte: Number(req.query.maxPrice) };
  // maxPersons filter: poojas that allow AT LEAST this many people.
  if (req.query.maxPersons) filter.maxPersons = { $gte: Number(req.query.maxPersons) };
  const items = await PoojaType.find(filter).populate('category', 'name').sort({ createdAt: -1 }).lean();
  await localizeEach(items, reqLang(req), POOJA_I18N);
  res.json({ success: true, data: items });
});

/**
 * GET /poojas/all — every currently-available pooja, no category/search/price
 * filters. Dedicated "All" feed for the app's default tab.
 */
exports.listAll = asyncHandler(async (req, res) => {
  const items = await PoojaType.find(availableNowMatch()).populate('category', 'name').sort({ createdAt: -1 }).lean();
  await localizeEach(items, reqLang(req), POOJA_I18N);
  res.json({ success: true, data: items });
});

/** GET /poojas/types/:id — single pooja detail. */
exports.getType = asyncHandler(async (req, res) => {
  const item = await PoojaType.findById(req.params.id).populate('category', 'name').lean();
  if (!item || !item.isActive) throw new AppError('Pooja not found', 404);
  await localizeFields(item, reqLang(req), POOJA_I18N);
  res.json({ success: true, data: item });
});

exports.create = asyncHandler(async (req, res) => {
  // Resolve the pooja (when booked by id) so we can trust its price + maxPersons
  // instead of the client's claim.
  let poojaDoc = null;
  if (req.body.poojaTypeId) {
    poojaDoc = await PoojaType.findById(req.body.poojaTypeId).populate('category', 'name');
    if (!poojaDoc || !poojaDoc.isActive) throw new AppError('Pooja not found or unavailable', 404);
  }

  // Price comes from the server-side pooja when booked by id; else fall back to
  // the legacy client-supplied amount.
  const price = poojaDoc ? poojaDoc.basePrice : toRupees(req.body.priceRupees);

  // Validate family members against the pooja's capacity.
  const familyMembers = Array.isArray(req.body.familyMembers)
    ? req.body.familyMembers.map((s) => String(s || '').trim()).filter(Boolean)
    : [];
  const maxPersons = poojaDoc ? (poojaDoc.maxPersons || 0) : 0;
  if (familyMembers.length > maxPersons) {
    throw new AppError(`This pooja allows up to ${maxPersons} member${maxPersons === 1 ? '' : 's'}`, 400);
  }

  const poojaName = poojaDoc ? poojaDoc.name : req.body.poojaType;
  if (!poojaName) throw new AppError('poojaTypeId or poojaType is required', 400);

  // Wallet-only model: poojas are paid by DEDUCTING from the user's wallet —
  // there is no separate PayU checkout here (PayU only ever recharges the
  // wallet). Block early with the current balance so the app can prompt a
  // recharge before we create a dangling booking.
  if (price > 0) {
    const bal = await walletService.getBalance(req.user._id);
    if ((bal.balance || 0) < price) {
      throw new AppError('Insufficient wallet balance', 402, {
        required: price, balance: bal.balance || 0, shortfall: price - (bal.balance || 0),
      });
    }
  }

  const booking = await PoojaBooking.create({
    user: req.user._id,
    // Prefer an explicit astrologerId; otherwise inherit the pooja's owner (so
    // astrologer-listed poojas attribute the booking + earnings to their owner).
    astrologer: req.body.astrologerId || (poojaDoc ? poojaDoc.astrologer : undefined),
    poojaType: poojaName,
    poojaTypeId: poojaDoc ? poojaDoc._id : undefined,
    contactName: req.body.contactName || req.user.name,
    contactPhone: req.body.contactPhone || req.user.phone,
    familyMembers,
    preferredDate: req.body.preferredDate,
    price,
    paymentStatus: 'pending',
    specialInstructions: req.body.specialInstructions,
  });

  // Deduct the price from the wallet (free pooja → no debit). debit() is atomic
  // + idempotent on refId and throws 402 if the balance dropped since the check.
  if (price > 0) {
    try {
      await walletService.debit({
        userId: req.user._id,
        amount: price,
        source: 'pooja',
        description: `Pooja booking — ${poojaName}`,
        refId: `pooja:${booking._id}`,
        meta: { bookingId: String(booking._id), poojaName },
      });
    } catch (e) {
      // Couldn't pay → roll the booking back so it doesn't dangle as pending.
      await PoojaBooking.deleteOne({ _id: booking._id });
      throw e; // 402 with balance details bubbles to the app
    }
  }

  booking.paymentStatus = 'paid';
  booking.status = 'confirmed';
  await booking.save();

  // Bump real booked count + auto-credit the astrologer (if astrologer-listed).
  require('../services/storeEarningsService').bumpPoojaBooked(booking).catch(() => {});
  require('../services/storeEarningsService').creditAstrologerForBooking(booking).catch(() => {});

  // Generate the invoice (PDF rendered async via the invoice_pdf job).
  // Best-effort — never block the booking response on invoicing.
  invoiceService.createForPooja(booking).catch((e) => logger.warn('pooja invoice failed', e.message));

  res.status(201).json({ success: true, data: { booking } });
});

exports.listMine = asyncHandler(async (req, res) => {
  const items = await PoojaBooking.find({ user: req.user._id }).sort({ createdAt: -1 });
  res.json({ success: true, data: items });
});

exports.get = asyncHandler(async (req, res) => {
  const b = await PoojaBooking.findById(req.params.id);
  if (!b) throw new AppError('Booking not found', 404);
  res.json({ success: true, data: b });
});

exports.updateStatus = asyncHandler(async (req, res) => {
  const b = await PoojaBooking.findById(req.params.id);
  if (!b) throw new AppError('Booking not found', 404);
  // Astrologer assigned to it, or an admin, may update status.
  if (req.user.role !== 'admin' && String(b.astrologer) !== String(req.user._id)) {
    throw new AppError('Not authorized', 403);
  }
  b.status = req.body.status;
  await b.save();
  await notificationService.notify(b.user, {
    type: 'pooja_status',
    title: 'Pooja booking update',
    body: `Your pooja booking is now ${b.status}.`,
    data: { bookingId: String(b._id), status: b.status },
  });
  res.json({ success: true, data: b });
});
