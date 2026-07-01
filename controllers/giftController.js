const asyncHandler = require('../utils/asyncHandler');
const Gift = require('../models/Gift');
const GiftTransaction = require('../models/GiftTransaction');
const AdminSettings = require('../models/AdminSettings');
const walletService = require('../services/walletService');
const notificationService = require('../services/notificationService');
const emit = require('../websockets/emit');
const { randomToken } = require('../utils/hash');
const AppError = require('../utils/AppError');
const { reqLang, localizeEach } = require('../utils/i18nReq');

exports.list = asyncHandler(async (req, res) => {
  const items = await Gift.find(req.query.all === 'true' ? {} : { isActive: true }).sort({ tokenCost: 1 });
  // Attach the resolved ₹ cost (tokenCost × giftTokenRupees) so the app can do a
  // pre-send balance check without knowing the token rate. Non-breaking: just an
  // extra field on each item.
  const settings = await AdminSettings.get();
  const rate = settings.giftTokenRupees || 1;
  const data = items.map((g) => ({ ...g.toObject(), rupeeCost: g.tokenCost * rate }));
  // Localize gift NAMES to the requester's language (user-visible in the sheet).
  await localizeEach(data, reqLang(req), ['name']);
  res.json({ success: true, data });
});

/** Send a gift: debit sender wallet (tokens -> paise), credit receiver.
 *  `sessionId`     → 1-on-1 chat/call/video gift (emits to session room).
 *  `liveSessionId` → live-broadcast superchat (emits to the live room + tallies). */
exports.send = asyncHandler(async (req, res) => {
  const { giftId, receiverId, sessionId, liveSessionId } = req.body;
  if (String(receiverId) === String(req.user._id)) throw new AppError('Cannot gift yourself', 400);

  const gift = await Gift.findById(giftId);
  if (!gift || !gift.isActive) throw new AppError('Gift not available', 404);

  const settings = await AdminSettings.get();
  const amountRupees = gift.tokenCost * settings.giftTokenRupees;
  const ref = randomToken(8);

  // Debit sender (atomic, never-negative).
  await walletService.debit({
    userId: req.user._id,
    amount: amountRupees,
    source: 'gift',
    description: `Sent gift: ${gift.name}`,
    refId: `gift-out:${ref}`,
    meta: { giftId, receiverId },
  });

  // Credit receiver.
  await walletService.credit({
    userId: receiverId,
    amount: amountRupees,
    source: 'gift',
    description: `Received gift: ${gift.name}`,
    refId: `gift-in:${ref}`,
    meta: { giftId, senderId: String(req.user._id) },
  });

  // Link the gift to its session (for in-chat gifts) so it shows in context.
  let relatedSession;
  let sessionAlias;
  if (sessionId) {
    const Session = require('../models/Session');
    const sess = await Session.findOne({ sessionId }).select('_id seekerAlias');
    if (sess) { relatedSession = sess._id; sessionAlias = sess.seekerAlias; }
  }

  const gt = await GiftTransaction.create({
    sender: req.user._id,
    receiver: receiverId,
    gift: gift._id,
    tokensSpent: gift.tokenCost,
    amountRupees,
    relatedSession,
  });

  // Realtime updates.
  emit.toUser(req.user._id, 'wallet-updated', await walletService.getBalance(req.user._id));
  emit.toUser(receiverId, 'wallet-updated', await walletService.getBalance(receiverId));
  // In-chat gift → live bubble for both sides. Identity stays the alias so the
  // astrologer never sees the sender's real id/name.
  if (sessionId) {
    emit.toSession(sessionId, 'gift-received', {
      sessionId,
      gift: gift.name,
      image: gift.image,
      emoji: gift.emoji,
      fromAlias: sessionAlias || 'Seeker',
    });
  }
  // Live-broadcast superchat → bump the running tally + bubble it to the whole
  // room under the sender's REAL name (a live room is public, not anonymous).
  if (liveSessionId) {
    const LiveSession = require('../models/LiveSession');
    const ls = await LiveSession.findByIdAndUpdate(
      liveSessionId,
      { $inc: { superchatTotal: amountRupees, giftCount: 1 } },
      { new: true }
    ).select('_id superchatTotal');
    if (ls) {
      emit.toLive(ls._id, 'live-gift', {
        liveSessionId: String(ls._id),
        gift: gift.name,
        image: gift.image,
        emoji: gift.emoji,
        amountRupees,
        fromName: req.user.name || 'Guest',
        superchatTotal: ls.superchatTotal,
      });
    }
  }
  await notificationService.notify(receiverId, {
    type: 'gift_received',
    title: 'You received a gift!',
    body: `${gift.name}`,
    data: { giftId: String(gift._id) },
  });

  res.status(201).json({ success: true, data: gt });
});

/**
 * Public: gifts an astrologer has received, aggregated by gift type.
 * :id = AstrologerProfile id. Returns { total, items:[{name,image,emoji,count}] }.
 */
exports.receivedForAstrologer = asyncHandler(async (req, res) => {
  const AstrologerProfile = require('../models/AstrologerProfile');
  const profile = await AstrologerProfile.findById(req.params.id).select('user');
  if (!profile) throw new AppError('Astrologer not found', 404);

  const rows = await GiftTransaction.aggregate([
    { $match: { receiver: profile.user } },
    { $group: { _id: '$gift', count: { $sum: 1 } } },
    { $lookup: { from: 'gifts', localField: '_id', foreignField: '_id', as: 'gift' } },
    { $unwind: '$gift' },
    { $project: { _id: 0, count: 1, name: '$gift.name', image: '$gift.image', emoji: '$gift.emoji' } },
    { $sort: { count: -1 } },
  ]);
  const total = rows.reduce((s, r) => s + r.count, 0);
  res.json({ success: true, data: { total, items: rows } });
});

// ── Admin CRUD ──
exports.create = asyncHandler(async (req, res) => {
  const gift = await Gift.create(req.body);
  res.status(201).json({ success: true, data: gift });
});
exports.update = asyncHandler(async (req, res) => {
  const gift = await Gift.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!gift) throw new AppError('Gift not found', 404);
  res.json({ success: true, data: gift });
});
exports.remove = asyncHandler(async (req, res) => {
  await Gift.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});
