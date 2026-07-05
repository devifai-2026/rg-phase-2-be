const asyncHandler = require('../utils/asyncHandler');
const payoutService = require('../services/payoutService');
const escalationService = require('../services/escalationService');
const astrologerService = require('../services/astrologerService');
const walletService = require('../services/walletService');
const auditService = require('../services/auditService');
const notificationService = require('../services/notificationService');
const emit = require('../websockets/emit');
const { randomToken } = require('../utils/hash');
const { toRupees } = require('../utils/money');
const AppError = require('../utils/AppError');

// ── Astrologers ──
exports.listAstrologers = asyncHandler(async (req, res) => {
  const data = await astrologerService.adminList(req.ctx, {
    status: req.query.status,
    page: parseInt(req.query.page || '1', 10),
    limit: Math.min(parseInt(req.query.limit || '20', 10), 100),
  });
  res.json({ success: true, data });
});

exports.updateAstrologer = asyncHandler(async (req, res) => {
  const data = await astrologerService.adminUpdate(req.ctx, req.params.id, req.body, req.user._id);
  res.json({ success: true, data });
});

// ── Withdrawals ──
exports.listWithdrawals = asyncHandler(async (req, res) => {
  const data = await payoutService.adminList(req.ctx, {
    status: req.query.status,
    page: parseInt(req.query.page || '1', 10),
    limit: Math.min(parseInt(req.query.limit || '20', 10), 100),
  });
  res.json({ success: true, data });
});

exports.approveWithdrawal = asyncHandler(async (req, res) => {
  const data = await payoutService.approveWithdrawal(req.ctx, req.params.id, req.user._id, req.body.note);
  res.json({ success: true, data });
});

exports.rejectWithdrawal = asyncHandler(async (req, res) => {
  const data = await payoutService.rejectWithdrawal(req.ctx, req.params.id, req.user._id, req.body.note);
  res.json({ success: true, data });
});

// ── Escalations ──
exports.listEscalations = asyncHandler(async (req, res) => {
  const data = await escalationService.list(req.ctx, {
    status: req.query.status || 'open',
    page: parseInt(req.query.page || '1', 10),
    limit: Math.min(parseInt(req.query.limit || '20', 10), 100),
  });
  res.json({ success: true, data });
});

exports.resolveEscalation = asyncHandler(async (req, res) => {
  await escalationService.resolve(req.ctx, req.params.id, req.user._id, req.body.note);
  res.json({ success: true });
});

// ── Settings ──
exports.getSettings = asyncHandler(async (req, res) => {
  const AdminSettings = req.model('AdminSettings');
  const s = await AdminSettings.get();
  res.json({ success: true, data: s });
});

exports.updateSettings = asyncHandler(async (req, res) => {
  const AdminSettings = req.model('AdminSettings');
  const s = await AdminSettings.get();
  Object.assign(s, req.body);
  await s.save();
  res.json({ success: true, data: s });
});

// ── Users ──
// ── Admin adds a user (with OTP verification) ──
exports.requestUserOtp = asyncHandler(async (req, res) => {
  const authService = require('../services/authService');
  const data = await authService.adminRequestUserOtp(req.ctx, req.body.phone);
  res.json({ success: true, data });
});

exports.createUser = asyncHandler(async (req, res) => {
  const authService = require('../services/authService');
  const user = await authService.adminCreateUser(req.ctx, {
    phone: req.body.phone,
    code: req.body.code,
    name: req.body.name,
    email: req.body.email,
  });
  res.status(201).json({ success: true, data: user.toSafeJSON ? user.toSafeJSON() : user });
});

exports.listUsers = asyncHandler(async (req, res) => {
  const User = req.model('User');
  const Wallet = req.model('Wallet');
  const q = req.query.role ? { role: req.query.role } : { role: 'user' };
  if (req.query.search) {
    q.$or = [{ name: new RegExp(req.query.search, 'i') }, { phone: new RegExp(req.query.search, 'i') }];
  }
  const page = parseInt(req.query.page || '1', 10);
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
  const [users, total] = await Promise.all([
    User.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    User.countDocuments(q),
  ]);
  // Attach wallet balances.
  const wallets = await Wallet.find({ user: { $in: users.map((u) => u._id) } }).lean();
  const byUser = {};
  wallets.forEach((w) => (byUser[String(w.user)] = w));
  const items = users.map((u) => ({
    ...u,
    walletBalance: byUser[String(u._id)]?.balance || 0,
    walletLocked: byUser[String(u._id)]?.lockedBalance || 0,
  }));
  res.json({ success: true, data: { items, total, page, limit } });
});

exports.blockUser = asyncHandler(async (req, res) => {
  const User = req.model('User');
  await User.updateOne({ _id: req.params.id }, { $set: { isBlocked: !!req.body.blocked } });
  res.json({ success: true });
});

/**
 * Permanently delete a (seeker) user and their owned records. Guarded to
 * role:'user' so an astrologer can't be removed via this path (astrologers have
 * their own DELETE /admin/astrologers/:id which tears down the profile too).
 * Best-effort cleanup of wallet + auth tokens; financial/session history is left
 * for audit (it references the id but the account is gone).
 */
exports.deleteUser = asyncHandler(async (req, res) => {
  const User = req.model('User');
  const Wallet = req.model('Wallet');
  const RefreshToken = req.model('RefreshToken');
  const user = await User.findById(req.params.id).select('role');
  if (!user) throw new AppError('User not found', 404);
  if (user.role !== 'user') throw new AppError('Only seeker accounts can be deleted here. Use the Astrologers tab for astrologers.', 400);

  await Promise.all([
    Wallet.deleteOne({ user: user._id }).catch(() => {}),
    RefreshToken.deleteMany({ user: user._id }).catch(() => {}),
  ]);
  await User.deleteOne({ _id: user._id });
  res.json({ success: true });
});

// ── Full 360° user detail ──
exports.userDetail = asyncHandler(async (req, res) => {
  const User = req.model('User');
  const Transaction = req.model('Transaction');
  const Session = req.model('Session');
  const Wallet = req.model('Wallet');
  const Order = req.model('Order');
  const GiftTransaction = req.model('GiftTransaction');
  const Presence = req.model('Presence');
  const Follow = req.model('Follow');
  const Notification = req.model('Notification');
  const id = req.params.id;

  const user = await User.findById(id).lean();
  if (!user) throw new AppError('User not found', 404);

  const [wallet, transactions, sessions, orders, giftsSent, giftsReceived, presence, followingCount, unreadNotifs] = await Promise.all([
    Wallet.findOne({ user: id }).lean(),
    Transaction.find({ user: id }).sort({ createdAt: -1 }).limit(100).lean(),
    Session.find({ user: id }).sort({ createdAt: -1 }).limit(100).populate('astrologer', 'name').lean(),
    Order.find({ user: id }).sort({ createdAt: -1 }).limit(50).lean(),
    GiftTransaction.find({ sender: id }).sort({ createdAt: -1 }).limit(50).populate('gift', 'name').lean(),
    GiftTransaction.find({ receiver: id }).sort({ createdAt: -1 }).limit(50).populate('gift', 'name').lean(),
    // The persistent presence row carries online flag, last-seen + activity rollup.
    Presence.findOne({ user: id }).lean().catch(() => null),
    Follow.countDocuments({ user: id, active: true }).catch(() => 0),
    Notification.countDocuments({ user: id, isRead: false }).catch(() => 0),
  ]);

  const online = !!(presence && presence.online && presence.socketCount > 0);

  // Logged-in devices (push tokens). One row per device; a user may be signed
  // in on several at once. Surface name/model/OS for the admin, but mask the
  // raw FCM token (sensitive) to just its last 8 chars for support reference.
  const devices = (user.fcmTokens || [])
    .map((t) => ({
      platform: t.platform || 'android',
      deviceId: t.deviceId || null,
      deviceName: t.deviceName || null,
      deviceModel: t.deviceModel || null,
      osVersion: t.osVersion || null,
      appVersion: t.appVersion || null,
      addedAt: t.addedAt || null,
      lastUsedAt: t.lastUsedAt || t.addedAt || null,
      tokenTail: t.token ? `…${String(t.token).slice(-8)}` : null,
    }))
    .sort((a, b) => new Date(b.lastUsedAt || 0) - new Date(a.lastUsedAt || 0));

  res.json({
    success: true,
    data: {
      user, // includes preferences, notificationSettings, permissions, location, birthDetails, language, gender, profileCompleted
      online,
      // Presence / activity tracking (from the socket heartbeat).
      presence: presence
        ? {
            online,
            lastSeen: presence.lastSeen,
            socketCount: presence.socketCount || 0,
            activity: presence.activity || {},
          }
        : null,
      wallet: { balance: wallet?.balance || 0, lockedBalance: wallet?.lockedBalance || 0, available: (wallet?.balance || 0) - (wallet?.lockedBalance || 0) },
      transactions,
      sessions, // each has type, status, totalAmount, durationSec, billedMinutes, startedAt/endedAt
      orders,
      addresses: user.addresses || [],
      giftsSent,
      giftsReceived,
      devices, // logged-in devices (push tokens) with name/model/OS
      meta: {
        followingCount,
        unreadNotifs,
        fcmTokens: (user.fcmTokens || []).length,
        joinedAt: user.createdAt,
      },
      stats: {
        totalSessions: sessions.length,
        completedSessions: sessions.filter((s) => s.status === 'completed').length,
        totalSpent: transactions.filter((t) => t.type === 'debit').reduce((s, t) => s + t.amount, 0),
        totalRecharged: transactions.filter((t) => t.source === 'recharge').reduce((s, t) => s + t.amount, 0),
        orders: orders.length,
      },
    },
  });
});

// ── Full astrologer detail (earnings, withdrawals, gifts, reviews, sessions) ──
exports.astrologerFull = asyncHandler(async (req, res) => {
  const Session = req.model('Session');
  const AstrologerProfile = req.model('AstrologerProfile');
  const Wallet = req.model('Wallet');
  const WithdrawalRequest = req.model('WithdrawalRequest');
  const GiftTransaction = req.model('GiftTransaction');
  const Review = req.model('Review');
  const presenceService = require('../services/presenceService');

  const profile = await AstrologerProfile.findById(req.params.id).populate('user', 'name phone email isBlocked permissions language').lean();
  if (!profile) throw new AppError('Astrologer not found', 404);
  const uid = profile.user._id;

  const [wallet, withdrawals, gifts, reviews, sessions, online, sessionAgg] = await Promise.all([
    Wallet.findOne({ user: uid }).lean(),
    WithdrawalRequest.find({ astrologer: uid }).sort({ createdAt: -1 }).limit(50).lean(),
    GiftTransaction.find({ receiver: uid }).sort({ createdAt: -1 }).limit(50).populate('gift', 'name').populate('sender', 'name').lean(),
    Review.find({ astrologer: uid }).sort({ createdAt: -1 }).limit(50).populate('user', 'name').lean(),
    Session.find({ astrologer: uid }).sort({ createdAt: -1 }).limit(100).populate('user', 'name').lean(),
    presenceService.isOnline(req.ctx, uid).catch(() => false),
    Session.aggregate([{ $match: { astrologer: uid, status: 'completed' } }, { $group: { _id: '$type', count: { $sum: 1 }, earnings: { $sum: '$astrologerEarning' }, minutes: { $sum: '$billedMinutes' } } }]),
  ]);

  const byType = {};
  sessionAgg.forEach((s) => (byType[s._id] = { count: s.count, earnings: s.earnings, minutes: s.minutes }));

  res.json({
    success: true,
    data: {
      profile, online,
      wallet: { balance: wallet?.balance || 0, lockedBalance: wallet?.lockedBalance || 0, available: (wallet?.balance || 0) - (wallet?.lockedBalance || 0) },
      withdrawals, gifts, reviews, sessions, byType,
      stats: {
        totalConsultations: sessions.filter((s) => s.status === 'completed').length,
        totalGiftsReceived: gifts.length,
        totalReviews: reviews.length,
      },
    },
  });
});

// ── Support tickets ──
const supportService = require('../services/supportService');
exports.listTickets = asyncHandler(async (req, res) => {
  const data = await supportService.adminList(req.ctx, {
    status: req.query.status,
    page: parseInt(req.query.page || '1', 10),
    limit: Math.min(parseInt(req.query.limit || '20', 10), 100),
  });
  res.json({ success: true, data });
});
exports.replyTicket = asyncHandler(async (req, res) => {
  const data = await supportService.reply(req.ctx, { ticketId: req.params.id, senderId: req.user._id, fromRole: 'admin', message: req.body.message, isAdmin: true });
  res.json({ success: true, data });
});
exports.setTicketStatus = asyncHandler(async (req, res) => {
  const data = await supportService.setStatus(req.ctx, { ticketId: req.params.id, status: req.body.status, adminId: req.user._id });
  res.json({ success: true, data });
});

// ── Site content (Contact Us / CMS) ──
const contentCtrl = require('./contentController');
exports.contentList = contentCtrl.adminList;
exports.contentUpsert = contentCtrl.upsert;

// ── Transactions ledger (all users) ──
function txnMatch(q) {
  const m = {};
  if (q.type) m.type = q.type;
  if (q.status) m.status = q.status;
  if (q.source) m.source = { $in: String(q.source).split(',') };
  if (q.userId) m.user = q.userId;
  if (q.dateFrom || q.dateTo) {
    m.createdAt = {};
    if (q.dateFrom) m.createdAt.$gte = new Date(q.dateFrom);
    if (q.dateTo) { const d = new Date(q.dateTo); d.setHours(23, 59, 59, 999); m.createdAt.$lte = d; }
  }
  return m;
}

exports.listTransactions = asyncHandler(async (req, res) => {
  const User = req.model('User');
  const Transaction = req.model('Transaction');
  const match = txnMatch(req.query);
  const page = parseInt(req.query.page || '1', 10);
  const limit = Math.min(parseInt(req.query.limit || '25', 10), 200);

  // Optional user search (name/phone) → resolve to ids.
  if (req.query.search) {
    const users = await User.find({ $or: [{ name: new RegExp(req.query.search, 'i') }, { phone: new RegExp(req.query.search, 'i') }] }).select('_id').limit(200);
    match.user = { $in: users.map((u) => u._id) };
  }

  const [items, total] = await Promise.all([
    Transaction.find(match).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('user', 'name phone'),
    Transaction.countDocuments(match),
  ]);
  res.json({ success: true, data: { items, total, page, limit } });
});

exports.transactionsSummary = asyncHandler(async (req, res) => {
  const User = req.model('User');
  const Transaction = req.model('Transaction');
  const match = txnMatch(req.query);
  if (req.query.search) {
    const users = await User.find({ $or: [{ name: new RegExp(req.query.search, 'i') }, { phone: new RegExp(req.query.search, 'i') }] }).select('_id').limit(200);
    match.user = { $in: users.map((u) => u._id) };
  }
  const [byType, bySource] = await Promise.all([
    Transaction.aggregate([{ $match: match }, { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
    Transaction.aggregate([{ $match: match }, { $group: { _id: '$source', total: { $sum: '$amount' } } }]),
  ]);
  const moneyIn = byType.find((t) => t._id === 'credit')?.total || 0;
  const moneyOut = byType.find((t) => t._id === 'debit')?.total || 0;
  const count = byType.reduce((s, t) => s + t.count, 0);
  const platformEarnings = bySource.find((s) => s._id === 'earning')?.total || 0;
  const sourceMap = {};
  bySource.forEach((s) => (sourceMap[s._id] = s.total));
  res.json({ success: true, data: { moneyIn, moneyOut, platformEarnings, count, bySource: sourceMap } });
});

// ── Dashboard / earnings ──
exports.dashboard = asyncHandler(async (req, res) => {
  const User = req.model('User');
  const Product = req.model('Product');
  const Session = req.model('Session');
  const Transaction = req.model('Transaction');
  const Order = req.model('Order');
  const PoojaBooking = req.model('PoojaBooking');
  const AstrologerProfile = req.model('AstrologerProfile');
  const WithdrawalRequest = req.model('WithdrawalRequest');
  const Escalation = req.model('Escalation');
  const SupportTicket = req.model('SupportTicket');

  // Window is admin-selectable (7/30/90 days); default 30. KPIs labelled "month"
  // are really "selected window".
  const Presence = req.model('Presence');
  const Banner = req.model('Banner');
  const Video = req.model('Video');

  const days = Math.min(parseInt(req.query.days || '30', 10), 365);
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const startYesterday = new Date(startToday); startYesterday.setDate(startYesterday.getDate() - 1);
  const monthAgo = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const prevMonth = new Date(Date.now() - 2 * days * 24 * 60 * 60 * 1000);
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [
    activeUsers, onlineAstro, pendingOrders, lowStock,
    todayRev, yesterdayRev, monthRev, prevMonthRev,
    paidOrders, poojaRev,
    pendingKyc, pendingWithdrawals, openEscalations, openTickets,
    rechargeAgg, withdrawalAgg,
    topAstro, ordersByStatusAgg,
  ] = await Promise.all([
    User.countDocuments({ role: 'user', isBlocked: false }),
    AstrologerProfile.countDocuments({ isOnline: true, applicationStatus: 'active' }),
    Order.countDocuments({ status: { $in: ['created', 'paid', 'processing'] } }),
    Product.countDocuments({ stock: { $lt: 10 }, isActive: true }),
    Session.aggregate([{ $match: { status: 'completed', endedAt: { $gte: startToday } } }, { $group: { _id: null, gross: { $sum: '$totalAmount' }, admin: { $sum: '$adminEarning' } } }]),
    Session.aggregate([{ $match: { status: 'completed', endedAt: { $gte: startYesterday, $lt: startToday } } }, { $group: { _id: null, admin: { $sum: '$adminEarning' } } }]),
    Session.aggregate([{ $match: { status: 'completed', endedAt: { $gte: monthAgo } } }, { $group: { _id: null, gross: { $sum: '$totalAmount' }, admin: { $sum: '$adminEarning' } } }]),
    Session.aggregate([{ $match: { status: 'completed', endedAt: { $gte: prevMonth, $lt: monthAgo } } }, { $group: { _id: null, admin: { $sum: '$adminEarning' } } }]),
    Order.aggregate([{ $match: { paymentStatus: 'paid' } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
    PoojaBooking.aggregate([{ $match: { paymentStatus: 'paid' } }, { $group: { _id: null, total: { $sum: '$price' } } }]),
    AstrologerProfile.countDocuments({ kycStatus: 'pending' }),
    WithdrawalRequest.countDocuments({ status: 'pending' }),
    Escalation.countDocuments({ status: 'open' }),
    SupportTicket.countDocuments({ status: { $in: ['open', 'in_progress'] } }),
    Transaction.aggregate([{ $match: { source: 'recharge', status: 'completed', createdAt: { $gte: monthAgo } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Transaction.aggregate([{ $match: { source: 'withdrawal', status: 'completed', createdAt: { $gte: monthAgo } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Session.aggregate([
      { $match: { status: 'completed', endedAt: { $gte: monthAgo } } },
      { $group: { _id: '$astrologer', earnings: { $sum: '$astrologerEarning' }, sessions: { $sum: 1 } } },
      { $sort: { earnings: -1 } }, { $limit: 5 },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
      { $project: { earnings: 1, sessions: 1, name: { $arrayElemAt: ['$u.name', 0] } } },
    ]),
    Order.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);

  const trend = await Session.aggregate([
    { $match: { status: 'completed', endedAt: { $gte: monthAgo } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$endedAt' } }, revenue: { $sum: '$adminEarning' }, gross: { $sum: '$totalAmount' } } },
    { $sort: { _id: 1 } },
  ]);

  const byType = await Session.aggregate([{ $match: { status: 'completed' } }, { $group: { _id: '$type', total: { $sum: '$totalAmount' } } }]);
  const distribution = { call: 0, chat: 0, video: 0, ecommerce: paidOrders[0]?.total || 0, pooja: poojaRev[0]?.total || 0 };
  byType.forEach((d) => (distribution[d._id] = d.total));

  const ordersByStatus = {};
  ordersByStatusAgg.forEach((o) => (ordersByStatus[o._id] = o.count));

  const recharge = rechargeAgg[0]?.total || 0;
  const withdrawal = withdrawalAgg[0]?.total || 0;
  const pending = { kyc: pendingKyc, withdrawals: pendingWithdrawals, escalations: openEscalations, tickets: openTickets, lowStock };

  // New users per day over the window + sessions per day.
  const [newUsers, sessionsTrend] = await Promise.all([
    User.aggregate([
      { $match: { role: 'user', createdAt: { $gte: monthAgo } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    Session.aggregate([
      { $match: { status: 'completed', endedAt: { $gte: monthAgo } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$endedAt' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : (cur > 0 ? 100 : 0));

  // ── User Activity / engagement (from the socket-driven Presence rollup) ──
  const [onlineUsersNow, activeToday, engagementAgg, recentlyActive, contentCounts] = await Promise.all([
    Presence.countDocuments({ role: 'user', online: true, socketCount: { $gt: 0 } }),
    Presence.countDocuments({ role: 'user', lastSeen: { $gte: startToday } }),
    Presence.aggregate([
      { $match: { role: 'user' } },
      { $group: { _id: null, visits: { $sum: '$activity.visits' }, pageViews: { $sum: '$activity.pageViews' }, searches: { $sum: '$activity.searches' }, tracked: { $sum: 1 } } },
    ]),
    Presence.find({ role: 'user', lastSeen: { $gte: last24h } })
      .sort({ lastSeen: -1 }).limit(8).populate('user', 'name phone avatar').lean(),
    Promise.all([
      Banner.countDocuments({ isActive: true }),
      Video.countDocuments({ kind: 'video', isActive: true }),
      Video.countDocuments({ kind: 'lesson', isActive: true }),
    ]),
  ]);

  const eng = engagementAgg[0] || {};
  const engagement = {
    onlineUsersNow,
    activeToday,
    totalVisits: eng.visits || 0,
    totalPageViews: eng.pageViews || 0,
    totalSearches: eng.searches || 0,
    trackedUsers: eng.tracked || 0,
    avgPageViews: eng.tracked ? Math.round((eng.pageViews || 0) / eng.tracked) : 0,
  };
  const recentActive = (recentlyActive || []).filter((p) => p.user).map((p) => ({
    id: String(p.user._id),
    name: p.user.name || 'Unnamed',
    phone: p.user.phone,
    avatar: p.user.avatar,
    online: !!(p.online && p.socketCount > 0),
    lastSeen: p.lastSeen,
    lastPage: p.activity?.lastPage || null,
    pageViews: p.activity?.pageViews || 0,
    searches: p.activity?.searches || 0,
  }));
  const content = { banners: contentCounts[0], videos: contentCounts[1], lessons: contentCounts[2] };

  res.json({
    success: true,
    data: {
      engagement,
      recentActive,
      content,
      kpis: {
        revenueToday: todayRev[0]?.admin || 0,
        revenueTodayDelta: pct(todayRev[0]?.admin || 0, yesterdayRev[0]?.admin || 0),
        revenueMonth: monthRev[0]?.admin || 0,
        revenueMonthDelta: pct(monthRev[0]?.admin || 0, prevMonthRev[0]?.admin || 0),
        grossToday: todayRev[0]?.gross || 0,
        netFlow: recharge - withdrawal,
        activeUsers,
        onlineAstrologers: onlineAstro,
        pendingOrders,
        lowStockCount: lowStock,
        pendingTotal: pendingKyc + pendingWithdrawals + openEscalations + openTickets,
        pending,
      },
      windowDays: days,
      revenueTrend: trend.map((t) => ({ date: t._id, revenue: t.revenue, gross: t.gross })),
      serviceDistribution: distribution,
      ordersByStatus,
      newUsersTrend: newUsers.map((t) => ({ date: t._id, count: t.count })),
      sessionsTrend: sessionsTrend.map((t) => ({ date: t._id, count: t.count })),
      topAstrologers: topAstro.map((a) => ({ id: String(a._id), name: a.name || 'Unknown', earnings: a.earnings, sessions: a.sessions })),
    },
  });
});

// ── Astrologers leaderboard (ranked by earnings/sessions over a window) ──
exports.leaderboard = asyncHandler(async (req, res) => {
  const Session = req.model('Session');
  const AstrologerProfile = req.model('AstrologerProfile');
  const days = parseInt(req.query.days || '30', 10);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const agg = await Session.aggregate([
    { $match: { status: 'completed', endedAt: { $gte: since } } },
    { $group: { _id: '$astrologer', earnings: { $sum: '$astrologerEarning' }, gross: { $sum: '$totalAmount' }, sessions: { $sum: 1 }, minutes: { $sum: '$billedMinutes' } } },
    { $sort: { earnings: -1 } },
    { $limit: 100 },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
    { $lookup: { from: 'astrologerprofiles', localField: '_id', foreignField: 'user', as: 'p' } },
    { $project: { earnings: 1, gross: 1, sessions: 1, minutes: 1, name: { $arrayElemAt: ['$u.name', 0] }, avatar: { $arrayElemAt: ['$p.avatar', 0] }, rating: { $arrayElemAt: ['$p.rating', 0] } } },
  ]);

  res.json({ success: true, data: agg.map((a, i) => ({ rank: i + 1, id: String(a._id), name: a.name || 'Unknown', avatar: a.avatar, earnings: a.earnings, gross: a.gross, sessions: a.sessions, minutes: a.minutes, rating: a.rating || 0 })) });
});

// ── Low-stock products (dashboard inventory alerts) ──
exports.lowStock = asyncHandler(async (req, res) => {
  const Product = req.model('Product');
  const threshold = parseInt(req.query.threshold || '10', 10);
  const items = await Product.find({ stock: { $lt: threshold }, isActive: true }).sort({ stock: 1 }).limit(50);
  res.json({ success: true, data: items });
});

// ── Pack-only wallet recharge (bypasses PayU; credits directly) ──
// The admin picks a RechargeTemplate; the user is credited EXACTLY that pack's
// `tokens` value (advertised value incl. bonus) — no free-form amount.
exports.rechargeUser = asyncHandler(async (req, res) => {
  const User = req.model('User');
  const RechargeTemplate = req.model('RechargeTemplate');
  const { userId, templateId, reason } = req.body;
  const target = await User.findById(userId);
  if (!target) throw new AppError('User not found', 404);

  const pack = await RechargeTemplate.findById(templateId);
  if (!pack || pack.isActive === false) throw new AppError('Invalid recharge pack', 400);
  const amount = pack.tokens; // exact value credited (whole rupees, incl. bonus)
  const packLabel = pack.name || `₹${pack.amount}`;

  const txn = await walletService.credit(req.ctx, {
    userId,
    amount,
    source: 'admin_manual',
    description: reason || `Recharge: ${packLabel} pack`,
    refId: `admin-recharge:${randomToken(8)}`,
    meta: { by: String(req.user._id), reason, templateId: String(pack._id), paidValue: pack.amount, creditedValue: pack.tokens },
  });

  emit.toUser(userId, 'wallet-updated', await walletService.getBalance(req.ctx, userId));
  await notificationService.notify(req.ctx, userId, {
    type: 'wallet',
    title: 'Recharge successful',
    body: `₹${amount} added to your wallet (${packLabel} pack).`,
    data: { amount, templateId: String(pack._id) },
  });
  await auditService.log(req.ctx, {
    actor: req.user,
    action: 'wallet.recharge',
    targetType: 'user',
    target: userId,
    summary: `${req.user.name || req.user.role} recharged ${target.name || target.phone} with the ${packLabel} pack (₹${amount})${reason ? ' — ' + reason : ''}`,
    meta: { amount, templateId: String(pack._id), reason },
    ip: req.ip,
  });
  res.json({ success: true, data: { transaction: txn } });
});

// ── Live monitors ──
// A chat is "live" once the astrologer has accepted (room open) and while both
// are connected (ongoing). Both states show with a green heartbeat in the admin.
exports.liveChats = asyncHandler(async (req, res) => {
  const Session = req.model('Session');
  const items = await Session.find({ type: 'chat', status: { $in: ['accepted', 'ongoing'] } })
    .sort({ startedAt: -1, acceptedAt: -1 })
    .populate('user', 'name phone')
    .populate('astrologer', 'name')
    .lean();
  res.json({ success: true, data: items });
});

// ── Storefront designs: view + switch an astrologer's AI-generated layouts ──
// :id is the astrologer's USER id (StorefrontLayout.astrologer / the user ref).
exports.listStorefrontLayouts = asyncHandler(async (req, res) => {
  const svc = require('../services/storefrontDesignService');
  res.json({ success: true, data: await svc.list(req.ctx, req.params.id) });
});

exports.setStorefrontLayout = asyncHandler(async (req, res) => {
  const svc = require('../services/storefrontDesignService');
  const data = await svc.setActive(req.ctx, req.params.id, req.body.layoutId);
  res.json({ success: true, data });
});

// Admin Feedback tab: astrologer-authored post-service + post-live feedback,
// paginated + filterable, with averages per dimension.
exports.listServiceFeedback = asyncHandler(async (req, res) => {
  const serviceFeedbackService = require('../services/serviceFeedbackService');
  const { page, limit, serviceType, kind, astrologerId, minRating, from, to } = req.query;
  const data = await serviceFeedbackService.adminList(req.ctx, {
    page: parseInt(page, 10) || 1,
    limit: Math.min(parseInt(limit, 10) || 20, 100),
    serviceType,
    kind,
    astrologerId,
    minRating,
    from,
    to,
  });
  res.json({ success: true, data });
});

exports.activeCalls = asyncHandler(async (req, res) => {
  const Session = req.model('Session');
  const items = await Session.find({ type: { $in: ['call', 'video'] }, status: 'ongoing' })
    .sort({ startedAt: -1 })
    .populate('user', 'name phone')
    .populate('astrologer', 'name');
  res.json({ success: true, data: items });
});

exports.callLogs = asyncHandler(async (req, res) => {
  const Session = req.model('Session');
  const q = { type: { $in: ['call', 'video'] } };
  if (req.query.astrologer) q.astrologer = req.query.astrologer;
  const page = parseInt(req.query.page || '1', 10);
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
  const [items, total] = await Promise.all([
    Session.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('user', 'name').populate('astrologer', 'name'),
    Session.countDocuments(q),
  ]);
  res.json({ success: true, data: { items, total, page, limit } });
});

exports.sessionMessages = asyncHandler(async (req, res) => {
  const ChatMessage = req.model('ChatMessage');
  const items = await ChatMessage.find({ sessionId: req.params.sessionId }).sort({ timestamp: 1 }).populate('sender', 'name');
  res.json({ success: true, data: items });
});

/**
 * Build the Mongo match for chat-history queries from the admin filters.
 * Shared by chatLogs (table) and chatAnalytics (graphs) so both apply the same
 * scope. Filters: user (id), astrologer (id), q (name/phone of either party),
 * from/to (createdAt range). History = chat sessions, any status.
 */
async function buildChatMatch(User, query = {}) {
  const match = { type: 'chat' };
  if (query.user) match.user = query.user;
  if (query.astrologer) match.astrologer = query.astrologer;
  // Free-text search matches either the seeker OR the astrologer by name/phone.
  if (query.q && String(query.q).trim()) {
    const rx = new RegExp(String(query.q).trim(), 'i');
    const ids = (await User.find({ $or: [{ name: rx }, { phone: rx }] }).select('_id').limit(500).lean()).map((u) => u._id);
    match.$or = [{ user: { $in: ids } }, { astrologer: { $in: ids } }];
  }
  if (query.from || query.to) {
    match.createdAt = {};
    if (query.from) match.createdAt.$gte = new Date(query.from);
    if (query.to) match.createdAt.$lte = new Date(query.to);
  }
  return match;
}

/**
 * Chat history (paginated, newest first) with filters. Each row carries its
 * duration + money split so the admin can audit. Live chats (accepted/ongoing)
 * are excluded by default — they live in the "Active" panel; pass
 * includeLive=true to show them too (e.g. an "all" view).
 */
exports.chatLogs = asyncHandler(async (req, res) => {
  const Session = req.model('Session');
  const User = req.model('User');
  const match = await buildChatMatch(User, req.query);
  if (req.query.includeLive !== 'true') {
    match.status = { $nin: ['accepted', 'ongoing'] };
  }
  const page = parseInt(req.query.page || '1', 10);
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
  const [items, total] = await Promise.all([
    Session.find(match)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select('sessionId type status user astrologer seekerAlias startedAt endedAt createdAt durationSec billedMinutes totalAmount adminEarning astrologerEarning endReason')
      .populate('user', 'name phone')
      .populate('astrologer', 'name')
      .lean(),
    Session.countDocuments(match),
  ]);
  res.json({ success: true, data: { items, total, page, limit } });
});

/**
 * Chat analytics for the monitor dashboard graphs. Honors the same filters as
 * chatLogs. Returns:
 *   totals  { chats, completed, adminEarned, astrologerEarned, userSpent,
 *             totalMinutes, avgDurationSec }
 *   daily   [{ day, chats, adminEarned, astrologerEarned, avgDurationSec }]
 * Only COMPLETED chats contribute to money/duration (live/missed/cancelled
 * have no settled amount), but `chats` counts every chat in range.
 */
exports.chatAnalytics = asyncHandler(async (req, res) => {
  const Session = req.model('Session');
  const User = req.model('User');
  const match = await buildChatMatch(User, req.query);
  const completedMatch = { ...match, status: 'completed' };

  const [totalsAgg, completedAgg, daily] = await Promise.all([
    // Every chat in range (any status) — for the volume count.
    Session.aggregate([{ $match: match }, { $group: { _id: null, chats: { $sum: 1 } } }]),
    // Settled money + duration come only from completed chats.
    Session.aggregate([
      { $match: completedMatch },
      {
        $group: {
          _id: null,
          completed: { $sum: 1 },
          adminEarned: { $sum: '$adminEarning' },
          astrologerEarned: { $sum: '$astrologerEarning' },
          userSpent: { $sum: '$totalAmount' },
          totalSec: { $sum: '$durationSec' },
        },
      },
    ]),
    // Per-day series (completed chats) for the time-series graphs.
    Session.aggregate([
      { $match: completedMatch },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          chats: { $sum: 1 },
          adminEarned: { $sum: '$adminEarning' },
          astrologerEarned: { $sum: '$astrologerEarning' },
          totalSec: { $sum: '$durationSec' },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const t = totalsAgg[0] || { chats: 0 };
  const c = completedAgg[0] || { completed: 0, adminEarned: 0, astrologerEarned: 0, userSpent: 0, totalSec: 0 };
  const totals = {
    chats: t.chats || 0,
    completed: c.completed || 0,
    adminEarned: c.adminEarned || 0,
    astrologerEarned: c.astrologerEarned || 0,
    userSpent: c.userSpent || 0,
    totalMinutes: Math.round((c.totalSec || 0) / 60),
    avgDurationSec: c.completed ? Math.round((c.totalSec || 0) / c.completed) : 0,
  };
  const dailySeries = daily.map((d) => ({
    day: d._id,
    chats: d.chats || 0,
    adminEarned: d.adminEarned || 0,
    astrologerEarned: d.astrologerEarned || 0,
    avgDurationSec: d.chats ? Math.round((d.totalSec || 0) / d.chats) : 0,
  }));
  res.json({ success: true, data: { totals, daily: dailySeries } });
});

// ── Audit logs (super admin) ──
exports.auditLogs = asyncHandler(async (req, res) => {
  const data = await auditService.list(req.ctx, {
    page: parseInt(req.query.page || '1', 10),
    limit: Math.min(parseInt(req.query.limit || '30', 10), 100),
    action: req.query.action,
    scope: req.query.scope || 'users', // default: only app-user-affecting actions
  });
  res.json({ success: true, data });
});

// ── Pooja catalog (managed pooja types) ──
// ── Recharge templates (app "Add money" packs) ──
exports.listRechargeTemplates = asyncHandler(async (req, res) => {
  const RechargeTemplate = req.model('RechargeTemplate');
  const items = await RechargeTemplate.find().sort({ sortOrder: 1, amount: 1 });
  res.json({ success: true, data: items });
});
// Invalidate the app-facing recharge-packs cache after any write so users see
// admin changes immediately (cache otherwise holds for its TTL).
const bustRechargeCache = () => require('../services/cacheService').delNamespace('recharge').catch(() => {});

exports.createRechargeTemplate = asyncHandler(async (req, res) => {
  const RechargeTemplate = req.model('RechargeTemplate');
  const item = await RechargeTemplate.create(req.body);
  bustRechargeCache();
  res.status(201).json({ success: true, data: item });
});
exports.updateRechargeTemplate = asyncHandler(async (req, res) => {
  const RechargeTemplate = req.model('RechargeTemplate');
  const item = await RechargeTemplate.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!item) throw new AppError('Recharge template not found', 404);
  bustRechargeCache();
  res.json({ success: true, data: item });
});
exports.deleteRechargeTemplate = asyncHandler(async (req, res) => {
  const RechargeTemplate = req.model('RechargeTemplate');
  await RechargeTemplate.findByIdAndDelete(req.params.id);
  bustRechargeCache();
  res.json({ success: true });
});

exports.listPoojaTypes = asyncHandler(async (req, res) => {
  const PoojaType = req.model('PoojaType');
  const items = await PoojaType.find().populate('category', 'name').sort({ createdAt: -1 });
  res.json({ success: true, data: items });
});
// availableTo is picked as a calendar date (midnight). Treat it as the WHOLE
// day by pushing it to 23:59:59.999 so a pooja stays bookable through its last
// day, not just up to that day's midnight.
function normalizeWindow(body) {
  if (body && body.availableTo) {
    const d = new Date(body.availableTo);
    if (!isNaN(d)) { d.setHours(23, 59, 59, 999); body.availableTo = d; }
  }
  return body;
}

exports.createPoojaType = asyncHandler(async (req, res) => {
  const PoojaType = req.model('PoojaType');
  if (!req.body.category) throw new AppError('Category is required', 400);
  if (!req.body.imagePortrait && !req.body.imageLandscape && !req.body.image) {
    throw new AppError('Add at least one image (portrait or landscape)', 400);
  }
  const item = await PoojaType.create(normalizeWindow(req.body));
  res.status(201).json({ success: true, data: item });
});
exports.updatePoojaType = asyncHandler(async (req, res) => {
  const PoojaType = req.model('PoojaType');
  const item = await PoojaType.findByIdAndUpdate(req.params.id, normalizeWindow(req.body), { new: true });
  if (!item) throw new AppError('Pooja type not found', 404);
  res.json({ success: true, data: item });
});
exports.deletePoojaType = asyncHandler(async (req, res) => {
  const PoojaType = req.model('PoojaType');
  await PoojaType.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

// ── Pooja categories (admin-managed; poojas bind to one) ──
exports.listPoojaCategories = asyncHandler(async (req, res) => {
  const PoojaCategory = req.model('PoojaCategory');
  const items = await PoojaCategory.find().sort({ sortOrder: 1, name: 1 });
  res.json({ success: true, data: items });
});
exports.createPoojaCategory = asyncHandler(async (req, res) => {
  const PoojaCategory = req.model('PoojaCategory');
  if (!req.body.name || !req.body.name.trim()) throw new AppError('Category name is required', 400);
  const item = await PoojaCategory.create(req.body);
  res.status(201).json({ success: true, data: item });
});
exports.updatePoojaCategory = asyncHandler(async (req, res) => {
  const PoojaCategory = req.model('PoojaCategory');
  const item = await PoojaCategory.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!item) throw new AppError('Category not found', 404);
  res.json({ success: true, data: item });
});
exports.deletePoojaCategory = asyncHandler(async (req, res) => {
  const PoojaCategory = req.model('PoojaCategory');
  const PoojaType = req.model('PoojaType');
  // Unbind any poojas pointing at this category so they don't dangle.
  await PoojaType.updateMany({ category: req.params.id }, { $unset: { category: 1 } });
  await PoojaCategory.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

// ── Payment gateway config (active gateway + per-gateway keys + live/test) ──
exports.getPaymentGateway = asyncHandler(async (req, res) => {
  const PaymentGatewayConfig = req.model('PaymentGatewayConfig');
  const doc = await PaymentGatewayConfig.get();
  res.json({ success: true, data: doc });
});
// Required credential fields per gateway — used to block activating a gateway
// (or saving) without its keys.
const GATEWAY_REQUIRED = {
  payu: ['key', 'salt'],
  razorpay: ['keyId', 'keySecret'],
  cashfree: ['appId', 'secretKey'],
};
const GATEWAY_LABEL = { payu: 'PayU', razorpay: 'Razorpay', cashfree: 'Cashfree' };

// Changing payment gateways is sensitive → require an OTP sent to the
// logged-in admin's own phone. Step 1: request the code.
exports.requestPaymentGatewayOtp = asyncHandler(async (req, res) => {
  const otpService = require('../services/otpService');
  const phone = req.user.phone;
  if (!phone) throw new AppError('Your admin account has no phone number for OTP', 400);
  const data = await otpService.requestOtp(req.ctx, phone);
  // Don't leak the masked-but-present devCode in prod; otpService already omits it there.
  res.json({ success: true, data: { message: 'OTP sent to your registered number', expiresInSec: data.expiresInSec, devCode: data.devCode } });
});

exports.updatePaymentGateway = asyncHandler(async (req, res) => {
  const PaymentGatewayConfig = req.model('PaymentGatewayConfig');
  const otpService = require('../services/otpService');
  const b = req.body || {};

  // Step 2: verify the OTP (to the admin's phone) before any change commits.
  if (!b.otp) throw new AppError('OTP required to change payment gateway', 400);
  await otpService.verifyOtp(req.ctx, req.user.phone, String(b.otp)); // throws on invalid/expired

  const doc = await PaymentGatewayConfig.get();

  // Merge per-gateway blocks first (only provided fields, so blanks don't wipe keys).
  for (const g of ['payu', 'razorpay', 'cashfree']) {
    if (b[g]) doc[g] = { ...(doc[g].toObject?.() ?? doc[g]), ...b[g] };
  }

  // Determine the gateway that WILL be active after this save and require its keys.
  const nextActive = b.active || doc.active;
  const required = GATEWAY_REQUIRED[nextActive] || [];
  const block = doc[nextActive] || {};
  const missing = required.filter((f) => !String(block[f] || '').trim());
  if (missing.length) {
    throw new AppError(
      `Add ${GATEWAY_LABEL[nextActive]} keys (${missing.join(', ')}) before making it the active gateway`,
      400,
      { gateway: nextActive, missing }
    );
  }

  doc.active = nextActive;
  await doc.save();
  res.json({ success: true, data: doc });
});

// ── Agora credentials (App ID + REST key/secret; secret encrypted at rest) ──
// The secret is never returned in full except via the OTP-gated reveal below.
exports.getAgoraConfig = asyncHandler(async (req, res) => {
  const AgoraConfig = req.model('AgoraConfig');
  const { decrypt, mask } = require('../utils/secretCrypto');
  const doc = await AgoraConfig.get();
  const secret = decrypt(doc.restSecret);
  // App Certificate is also encrypted at rest — surface only its presence + a
  // masked preview here (the full value comes via the OTP-gated reveal).
  const cert = doc.appCertificate ? decrypt(doc.appCertificate) : '';
  res.json({
    success: true,
    data: {
      appId: doc.appId,
      restKey: doc.restKey,
      secretMasked: mask(secret),     // dotted preview for the field
      hasSecret: !!secret,
      certMasked: mask(cert),         // dotted preview for the App Certificate
      hasCertificate: !!cert,
      updatedAt: doc.updatedAt,
    },
  });
});

// Step 1: send an OTP to the logged-in admin's phone (for save OR reveal).
exports.requestAgoraOtp = asyncHandler(async (req, res) => {
  const otpService = require('../services/otpService');
  const phone = req.user.phone;
  if (!phone) throw new AppError('Your admin account has no phone number for OTP', 400);
  const data = await otpService.requestOtp(req.ctx, phone);
  res.json({ success: true, data: { message: 'OTP sent to your registered number', expiresInSec: data.expiresInSec, devCode: data.devCode } });
});

// Step 2 (save): verify OTP, then persist. Only provided fields change; the
// secret is re-encrypted when supplied (blank secret keeps the existing one).
exports.updateAgoraConfig = asyncHandler(async (req, res) => {
  const AgoraConfig = req.model('AgoraConfig');
  const otpService = require('../services/otpService');
  const { encrypt } = require('../utils/secretCrypto');
  const b = req.body || {};

  if (!b.otp) throw new AppError('OTP required to change Agora credentials', 400);
  await otpService.verifyOtp(req.ctx, req.user.phone, String(b.otp)); // throws on invalid/expired

  const doc = await AgoraConfig.get();
  if (b.appId !== undefined) doc.appId = String(b.appId).trim();
  if (b.restKey !== undefined) doc.restKey = String(b.restKey).trim();
  // Only overwrite secrets when a new non-empty value is sent (encrypted at rest).
  if (b.restSecret !== undefined && String(b.restSecret).trim() !== '') {
    doc.restSecret = encrypt(String(b.restSecret).trim());
  }
  // App Certificate — signs RTC tokens for Secured-mode projects (required for
  // real call/video media). Encrypted at rest like restSecret.
  if (b.appCertificate !== undefined && String(b.appCertificate).trim() !== '') {
    doc.appCertificate = encrypt(String(b.appCertificate).trim());
  }
  doc.updatedBy = req.user._id;
  await doc.save();

  const { decrypt, mask } = require('../utils/secretCrypto');
  const cert = doc.appCertificate ? decrypt(doc.appCertificate) : '';
  res.json({ success: true, data: {
    appId: doc.appId,
    restKey: doc.restKey,
    secretMasked: mask(decrypt(doc.restSecret)),
    hasSecret: !!decrypt(doc.restSecret),
    certMasked: mask(cert),
    hasCertificate: !!cert,
    updatedAt: doc.updatedAt,
  } });
});

// Reveal the full secret (OTP-gated) — powers the "unmask eye" button.
exports.revealAgoraSecret = asyncHandler(async (req, res) => {
  const AgoraConfig = req.model('AgoraConfig');
  const otpService = require('../services/otpService');
  const { decrypt } = require('../utils/secretCrypto');
  const code = (req.body || {}).otp;
  if (!code) throw new AppError('OTP required to reveal the secret', 400);
  await otpService.verifyOtp(req.ctx, req.user.phone, String(code));
  const doc = await AgoraConfig.get();
  // Reveal both encrypted-at-rest values behind the single OTP gate: the REST
  // secret and the App Certificate (needed to verify token signing creds).
  res.json({
    success: true,
    data: {
      restSecret: decrypt(doc.restSecret),
      appCertificate: doc.appCertificate ? decrypt(doc.appCertificate) : '',
    },
  });
});

// ── VedicAstroAPI credentials (apiKey encrypted at rest; save + reveal OTP-gated) ──
// vedicAstroService reads these at runtime (DB first, env fallback). The key is
// never returned in full except via the OTP-gated reveal below.
exports.getVedicAstroConfig = asyncHandler(async (req, res) => {
  const VedicAstroConfig = req.model('VedicAstroConfig');
  const { decrypt, mask } = require('../utils/secretCrypto');
  const doc = await VedicAstroConfig.get();
  const apiKey = decrypt(doc.apiKey);
  res.json({
    success: true,
    data: {
      apiKeyMasked: mask(apiKey),   // dotted preview for the field
      hasApiKey: !!apiKey,
      updatedAt: doc.updatedAt,
    },
  });
});

// Step 1: send an OTP to the logged-in admin's phone (for save OR reveal).
exports.requestVedicAstroOtp = asyncHandler(async (req, res) => {
  const otpService = require('../services/otpService');
  const phone = req.user.phone;
  if (!phone) throw new AppError('Your admin account has no phone number for OTP', 400);
  const data = await otpService.requestOtp(req.ctx, phone);
  res.json({ success: true, data: { message: 'OTP sent to your registered number', expiresInSec: data.expiresInSec, devCode: data.devCode } });
});

// Step 2 (save): verify OTP, then persist. Only provided fields change; the key
// is re-encrypted when supplied (a blank key keeps the existing one).
exports.updateVedicAstroConfig = asyncHandler(async (req, res) => {
  const VedicAstroConfig = req.model('VedicAstroConfig');
  const otpService = require('../services/otpService');
  const { encrypt, decrypt, mask } = require('../utils/secretCrypto');
  const b = req.body || {};

  if (!b.otp) throw new AppError('OTP required to change VedicAstro credentials', 400);
  await otpService.verifyOtp(req.ctx, req.user.phone, String(b.otp)); // throws on invalid/expired

  const doc = await VedicAstroConfig.get();
  // Only overwrite the key when a new non-empty value is sent (encrypted at rest).
  if (b.apiKey !== undefined && String(b.apiKey).trim() !== '') {
    doc.apiKey = encrypt(String(b.apiKey).trim());
  }
  doc.updatedBy = req.user._id;
  await doc.save();

  const apiKey = decrypt(doc.apiKey);
  res.json({ success: true, data: {
    apiKeyMasked: mask(apiKey),
    hasApiKey: !!apiKey,
    updatedAt: doc.updatedAt,
  } });
});

// Reveal the full API key (OTP-gated) — powers the "unmask eye" button.
exports.revealVedicAstroSecret = asyncHandler(async (req, res) => {
  const VedicAstroConfig = req.model('VedicAstroConfig');
  const otpService = require('../services/otpService');
  const { decrypt } = require('../utils/secretCrypto');
  const code = (req.body || {}).otp;
  if (!code) throw new AppError('OTP required to reveal the key', 400);
  await otpService.verifyOtp(req.ctx, req.user.phone, String(code));
  const doc = await VedicAstroConfig.get();
  res.json({ success: true, data: { apiKey: decrypt(doc.apiKey) } });
});

// DIAGNOSTIC: live Agora channel state for a session — is the channel created,
// and who is in it (broadcaster vs audience)? The ground truth for debugging
// "timer runs but no audio/video". Run during an ONGOING call. Reuses the
// recording REST creds (customerId/customerSecret).
exports.agoraChannelDiagnostics = asyncHandler(async (req, res) => {
  const recordingService = require('../services/recordingService');
  const data = await recordingService.channelDiagnostics(req.ctx, req.params.sessionId);
  res.json({ success: true, data });
});

// ── Firebase / GA4 analytics (native admin charts via the GA4 Data API) ──
exports.gaAnalytics = asyncHandler(async (req, res) => {
  const ga = require('../services/gaService');
  if (!ga.enabled()) { // GA4 is platform-global config — no ctx
    // Not configured yet → tell the admin UI to show the setup hint + deep links.
    return res.json({ success: true, data: { configured: false } });
  }
  const { startDate, endDate } = req.query;
  const [overview, realtime] = await Promise.all([
    ga.overview({ startDate, endDate }),
    ga.realtime(),
  ]);
  res.json({ success: true, data: { configured: true, ...overview, realtime } });
});

// ── Invoice templates (admin-managed branding for invoice PDFs) ──
exports.listInvoiceTemplates = asyncHandler(async (req, res) => {
  const InvoiceTemplate = req.model('InvoiceTemplate');
  const items = await InvoiceTemplate.find().sort({ isDefault: -1, createdAt: 1 });
  res.json({ success: true, data: items });
});
exports.createInvoiceTemplate = asyncHandler(async (req, res) => {
  const InvoiceTemplate = req.model('InvoiceTemplate');
  if (!req.body.name) throw new AppError('Template name is required', 400);
  const item = await InvoiceTemplate.create(req.body);
  if (item.isDefault) await InvoiceTemplate.updateMany({ _id: { $ne: item._id } }, { $set: { isDefault: false } });
  res.status(201).json({ success: true, data: item });
});
exports.updateInvoiceTemplate = asyncHandler(async (req, res) => {
  const InvoiceTemplate = req.model('InvoiceTemplate');
  const item = await InvoiceTemplate.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!item) throw new AppError('Template not found', 404);
  // Exactly one default.
  if (req.body.isDefault) await InvoiceTemplate.updateMany({ _id: { $ne: item._id } }, { $set: { isDefault: false } });
  res.json({ success: true, data: item });
});
exports.deleteInvoiceTemplate = asyncHandler(async (req, res) => {
  const InvoiceTemplate = req.model('InvoiceTemplate');
  await InvoiceTemplate.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

// Preview a template by rendering a SAMPLE invoice PDF (streamed inline).
// Accepts a saved template id (?id=) OR ad-hoc template fields in the query/body
// (design, businessName, logo, address…) so the admin can preview before saving.
exports.previewInvoiceTemplate = asyncHandler(async (req, res) => {
  const InvoiceTemplate = req.model('InvoiceTemplate');
  const invoicePdfService = require('../services/invoicePdfService');
  const src = { ...req.query, ...req.body };
  let tpl;
  if (src.id) tpl = await InvoiceTemplate.findById(src.id);
  if (!tpl) {
    tpl = {
      design: Number(src.design) || 1,
      businessName: src.businessName || 'Rudraganga',
      logo: src.logo, addressLine1: src.addressLine1, addressLine2: src.addressLine2,
      city: src.city, state: src.state, pincode: src.pincode,
      phone: src.phone, email: src.email, gstin: src.gstin, footerNote: src.footerNote,
    };
  }
  const sample = {
    invoiceNo: 'RG-INV-2026-000123',
    issuedAt: new Date(),
    billTo: { name: 'Subhojit Dutta', phone: '+91 87774 68277', line1: '221B Park Street', city: 'Kolkata', state: 'WB', pincode: '700016' },
    items: [
      { name: 'Lakshmi Pooja (for Ramesh, Sita)', qty: 1, unitPrice: 1100, lineTotal: 1100 },
      { name: 'Navagraha Shanti Pooja', qty: 1, unitPrice: 2100, lineTotal: 2100 },
    ],
    subtotal: 3200, discount: 200, total: 3000,
  };
  const buffer = await invoicePdfService.render(sample, tpl); // pure renderer — takes no ctx
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', 'inline; filename="invoice-preview.pdf"');
  res.send(buffer);
});

// ── Invoices (list + regenerate PDF) ──
exports.listInvoices = asyncHandler(async (req, res) => {
  const Invoice = req.model('Invoice');
  const page = parseInt(req.query.page || '1', 10);
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const q = {};
  if (req.query.refType) q.refType = req.query.refType;
  const [items, total] = await Promise.all([
    Invoice.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('user', 'name phone').lean(),
    Invoice.countDocuments(q),
  ]);
  res.json({ success: true, data: { items, total, page, limit } });
});
// Re-enqueue PDF generation for an invoice (e.g. after editing the template).
exports.regenerateInvoicePdf = asyncHandler(async (req, res) => {
  const Invoice = req.model('Invoice');
  const jobService = require('../services/jobService');
  const inv = await Invoice.findById(req.params.id);
  if (!inv) throw new AppError('Invoice not found', 404);
  inv.pdfStatus = 'pending';
  await inv.save();
  await jobService.enqueue(req.ctx, { type: 'invoice_pdf', payload: { invoiceId: String(inv._id) }, dedupeKey: `invoice-pdf:${inv._id}:regen:${Date.now()}` });
  res.json({ success: true });
});

// ── Pooja bookings (all users' app bookings) ──
exports.listPoojaBookings = asyncHandler(async (req, res) => {
  const PoojaBooking = req.model('PoojaBooking');
  const q = req.query.status ? { status: req.query.status } : {};
  const page = parseInt(req.query.page || '1', 10);
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const [items, total] = await Promise.all([
    PoojaBooking.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)
      .populate('user', 'name phone').populate('astrologer', 'name'),
    PoojaBooking.countDocuments(q),
  ]);
  res.json({ success: true, data: { items, total, page, limit } });
});
exports.updatePoojaBooking = asyncHandler(async (req, res) => {
  const PoojaBooking = req.model('PoojaBooking');
  const booking = await PoojaBooking.findById(req.params.id);
  if (!booking) throw new AppError('Booking not found', 404);
  if (req.body.status) booking.status = req.body.status;
  if (req.body.astrologerId !== undefined) booking.astrologer = req.body.astrologerId || undefined;
  await booking.save();
  await notificationService.notify(req.ctx, booking.user, {
    type: 'pooja_status', title: 'Pooja booking update', body: `Your pooja booking is now ${booking.status}.`,
    data: { bookingId: String(booking._id), status: booking.status },
  });
  res.json({ success: true, data: booking });
});

// ── AI personas (admin-managed AI astrologer cards) ──
exports.listPersonas = asyncHandler(async (req, res) => {
  const AiPersona = req.model('AiPersona');
  const items = await AiPersona.find().sort({ sortOrder: 1, createdAt: -1 });
  res.json({ success: true, data: items });
});
exports.createPersona = asyncHandler(async (req, res) => {
  const AiPersona = req.model('AiPersona');
  const item = await AiPersona.create(req.body);
  res.status(201).json({ success: true, data: item });
});
exports.updatePersona = asyncHandler(async (req, res) => {
  const AiPersona = req.model('AiPersona');
  const item = await AiPersona.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!item) throw new AppError('Persona not found', 404);
  res.json({ success: true, data: item });
});
exports.deletePersona = asyncHandler(async (req, res) => {
  const AiPersona = req.model('AiPersona');
  await AiPersona.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

// ── Admin management (super admin only): list / create / delete admins ──
exports.listAdmins = asyncHandler(async (req, res) => {
  const User = req.model('User');
  const items = await User.find({ role: { $in: ['admin', 'super_admin'] } }).sort({ createdAt: -1 });
  res.json({ success: true, data: items });
});

exports.createAdmin = asyncHandler(async (req, res) => {
  const User = req.model('User');
  const { name, email, code, role = 'admin' } = req.body;
  const phone = require('../utils/phone').normalizePhone(req.body.phone);
  if (!phone) throw new AppError('Enter a valid 10-digit phone number', 400);
  if (!['admin', 'super_admin'].includes(role)) throw new AppError('Invalid admin role', 400);
  // Verify the phone via OTP (dev: 123456) before claiming it.
  if (!code) throw new AppError('Phone verification code is required', 400);
  await require('../services/otpService').verifyOtp(req.ctx, phone, code);
  // Platform-wide uniqueness: a number already used by any account (user,
  // astrologer or another admin) can't be reused for an admin.
  await User.assertPhoneAvailable(phone);
  const user = await User.create({ name, phone, email, role, isPhoneVerified: true });
  await auditService.log(req.ctx, { actor: req.user, action: 'admin.create', targetType: 'admin', target: user._id, summary: `${req.user.name || 'Super Admin'} created ${role} ${name || phone}`, ip: req.ip });
  res.status(201).json({ success: true, data: user });
});

exports.deleteAdmin = asyncHandler(async (req, res) => {
  const User = req.model('User');
  if (String(req.params.id) === String(req.user._id)) throw new AppError('You cannot remove yourself', 400);
  const user = await User.findById(req.params.id);
  if (!user || !['admin', 'super_admin'].includes(user.role)) throw new AppError('Admin not found', 404);
  // Demote to a normal user rather than hard-delete (preserves audit/history).
  user.role = 'user';
  await user.save();
  await auditService.log(req.ctx, { actor: req.user, action: 'admin.delete', targetType: 'admin', target: user._id, summary: `${req.user.name || 'Super Admin'} removed admin ${user.name || user.phone}`, ip: req.ip });
  res.json({ success: true });
});

// ── Danger Prompts (LLM SYSTEM prompts; editing changes AI behaviour platform-
// wide, so the tab is OTP-gated). The OTP is sent to a FIXED guardian number
// (not the acting admin's phone). In dev the code is returned for convenience.
const PROMPT_OTP_PHONE = '8777468277';

exports.requestPromptOtp = asyncHandler(async (req, res) => {
  const otpService = require('../services/otpService');
  const data = await otpService.requestOtp(req.ctx, PROMPT_OTP_PHONE);
  res.json({
    success: true,
    data: {
      message: `OTP sent to ${PROMPT_OTP_PHONE}`,
      phone: PROMPT_OTP_PHONE,
      expiresInSec: data.expiresInSec,
      devCode: data.devCode, // present in dev only
    },
  });
});

exports.listPrompts = asyncHandler(async (req, res) => {
  const promptService = require('../services/promptService');
  const data = await promptService.listForAdmin(req.ctx);
  res.json({ success: true, data });
});

// Save (or revert) a prompt override. OTP-verified against the guardian number.
exports.updatePrompt = asyncHandler(async (req, res) => {
  const otpService = require('../services/otpService');
  const promptService = require('../services/promptService');
  const { key, system, otp } = req.body || {};
  if (!key) throw new AppError('Prompt key required', 400);
  if (!otp) throw new AppError('OTP required to change a prompt', 400);
  await otpService.verifyOtp(req.ctx, PROMPT_OTP_PHONE, String(otp)); // throws on invalid/expired
  await promptService.saveOverride(req.ctx, key, system, req.user._id);
  await auditService.log(req.ctx, {
    actor: req.user, action: 'prompt.update', targetType: 'prompt', target: key,
    summary: `${req.user.name || 'Admin'} edited the "${key}" AI prompt`, ip: req.ip,
  }).catch(() => {});
  const data = await promptService.listForAdmin(req.ctx);
  res.json({ success: true, data });
});

// ── AI: scheduled reminders + chat recaps (admin visibility) ──
// Every reminder the AI extracted + the astrologer confirmed (mantra recurring /
// one-off event), with its reason and schedule. Admin-only oversight.
exports.listReminders = asyncHandler(async (req, res) => {
  const ScheduledReminder = req.model('ScheduledReminder');
  const { status, type, page = '1', limit = '50' } = req.query;
  const q = {};
  if (status) q.status = status;
  if (type) q.type = type;
  const p = parseInt(page, 10);
  const l = Math.min(parseInt(limit, 10), 200);
  const [items, total] = await Promise.all([
    ScheduledReminder.find(q).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
      .populate('user', 'name phone').populate('astrologer', 'name').lean(),
    ScheduledReminder.countDocuments(q),
  ]);
  res.json({ success: true, data: { items, total, page: p, limit: l } });
});

// AI chat recaps (summary + suggestions + reminders + status). Admin oversight of
// what the AI produced and what the astrologer published.
exports.listRecaps = asyncHandler(async (req, res) => {
  const SessionRecap = req.model('SessionRecap');
  const { status, page = '1', limit = '50' } = req.query;
  const q = {};
  if (status) q.status = status;
  const p = parseInt(page, 10);
  const l = Math.min(parseInt(limit, 10), 200);
  const [items, total] = await Promise.all([
    SessionRecap.find(q).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
      .populate('user', 'name phone').populate('astrologer', 'name')
      .populate('suggestions.product', 'name price images').lean(),
    SessionRecap.countDocuments(q),
  ]);
  res.json({ success: true, data: { items, total, page: p, limit: l } });
});

// ── LLM Logs (every AI call: resolved prompt + real input + output + tokens) ──
exports.listAiLogs = asyncHandler(async (req, res) => {
  const AiLog = req.model('AiLog');
  const { feature, astrologer, page = '1', limit = '50' } = req.query;
  const q = {};
  if (feature) q.feature = feature;
  if (astrologer) q.astrologer = astrologer;
  const p = parseInt(page, 10);
  const l = Math.min(parseInt(limit, 10), 200);
  const [items, total] = await Promise.all([
    AiLog.find(q).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
      .populate('astrologer', 'name').populate('user', 'name').lean(),
    AiLog.countDocuments(q),
  ]);
  res.json({ success: true, data: { items, total, page: p, limit: l } });
});

// ── AI Notifications: scheduled reminders (mantra/event) + re-engagement cues,
// merged into one timeline so admins see everything the AI scheduled to fire. ──
exports.listAiNotifications = asyncHandler(async (req, res) => {
  const ScheduledReminder = req.model('ScheduledReminder');
  const ReengagementCue = req.model('ReengagementCue');
  const { status } = req.query;
  const [reminders, cues] = await Promise.all([
    ScheduledReminder.find(status ? { status } : {}).sort({ createdAt: -1 }).limit(300)
      .populate('user', 'name phone').populate('astrologer', 'name').lean(),
    ReengagementCue.find({}).sort({ createdAt: -1 }).limit(300)
      .populate('user', 'name phone').populate('astrologer', 'name').lean(),
  ]);
  const items = [
    ...reminders.map((r) => ({
      _id: String(r._id), kind: r.type, // 'mantra' | 'event'
      title: r.title, reason: r.reason, notifyText: r.notifyText,
      schedule: r.type === 'mantra' ? `Daily ${r.timeOfDay || ''} · ${r.firedCount || 0}/${r.totalOccurrences || 14}` : (r.date ? new Date(r.date).toLocaleDateString('en-IN') : '—'),
      nextRunAt: r.nextRunAt, status: r.status, user: r.user, astrologer: r.astrologer,
      sessionId: r.sessionId, createdAt: r.createdAt,
    })),
    ...cues.map((c) => ({
      _id: String(c._id), kind: 'followup',
      title: c.topic, reason: 'Future-prediction check-in', notifyText: c.notifyText,
      schedule: c.dueDate ? new Date(c.dueDate).toLocaleDateString('en-IN') : '—',
      nextRunAt: c.dueDate, status: c.status, user: c.user, astrologer: c.astrologer,
      sessionId: undefined, createdAt: c.createdAt,
    })),
  ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ success: true, data: { items, total: items.length } });
});

// ── AI Marketing Agent (engagement push generator + scheduler) ──
exports.getMarketingConfig = asyncHandler(async (req, res) => {
  const MarketingConfig = req.model('MarketingConfig');
  const MarketingNotif = req.model('MarketingNotif');
  const cfg = await MarketingConfig.get();
  const [activeUsers, activeAstro, pending] = await Promise.all([
    MarketingNotif.countDocuments({ status: 'active', audience: 'users' }),
    MarketingNotif.countDocuments({ status: 'active', audience: 'astrologers' }),
    MarketingNotif.countDocuments({ status: 'pending' }),
  ]);
  res.json({ success: true, data: {
    enabled: cfg.enabled, frequency: cfg.frequency, fixedTimes: cfg.fixedTimes,
    lastRunAt: cfg.lastRunAt, pool: { activeUsers, activeAstro, pending },
  } });
});

exports.updateMarketingConfig = asyncHandler(async (req, res) => {
  const MarketingConfig = req.model('MarketingConfig');
  const cfg = await MarketingConfig.get();
  const b = req.body || {};
  if (b.enabled !== undefined) cfg.enabled = !!b.enabled;
  if (b.frequency && ['every5', 'every10', 'fixed'].includes(b.frequency)) cfg.frequency = b.frequency;
  if (Array.isArray(b.fixedTimes)) cfg.fixedTimes = b.fixedTimes.filter((t) => /^\d{2}:\d{2}$/.test(t));
  cfg.updatedBy = req.user._id;
  await cfg.save();
  res.json({ success: true, data: { enabled: cfg.enabled, frequency: cfg.frequency, fixedTimes: cfg.fixedTimes } });
});

// Generate a fresh review batch (default 30, split users/astrologers).
exports.generateMarketing = asyncHandler(async (req, res) => {
  const marketingService = require('../services/marketingService');
  const total = Math.min(parseInt(req.body?.total || '30', 10) || 30, 60);
  const lang = req.body?.lang || undefined; // '' / undefined = model's default mix
  const out = await marketingService.generate(req.ctx, { total, adminId: req.user._id, lang });
  res.json({ success: true, data: out });
});

// Admin Save/Reject of pending generated lines.
exports.reviewMarketing = asyncHandler(async (req, res) => {
  const marketingService = require('../services/marketingService');
  const { saveIds = [], rejectIds = [] } = req.body || {};
  const out = await marketingService.review(req.ctx, { saveIds, rejectIds });
  res.json({ success: true, data: out });
});

// List the pool (filter by status/audience).
exports.listMarketing = asyncHandler(async (req, res) => {
  const marketingService = require('../services/marketingService');
  const items = await marketingService.list(req.ctx, { status: req.query.status, audience: req.query.audience });
  res.json({ success: true, data: { items } });
});

// Manually fire one send cycle now (test).
exports.runMarketingNow = asyncHandler(async (req, res) => {
  const marketingService = require('../services/marketingService');
  const sent = await marketingService.sendCycle(req.ctx);
  res.json({ success: true, data: { sent } });
});

// ── Translation: kick off a full pass in the BACKGROUND (returns immediately) ──
// The admin polls /translation/status to see "running" + the result, so the UI
// reflects progress even after navigating away and back.
exports.runTranslation = asyncHandler(async (req, res) => {
  const translateService = require('../services/translateService');
  if (!translateService.configured()) { // global GCP config — no ctx
    return res.json({ success: true, data: { configured: false, running: false, message: 'GCP Translate not configured' } });
  }
  const state = translateService.startFullTranslation(req.ctx);
  res.json({ success: true, data: state });
});

// Translation status: GCP config + cached count + the live run state
// (running / startedAt / lastResult), so the UI restores "running" on return.
exports.translationStatus = asyncHandler(async (req, res) => {
  const translateService = require('../services/translateService');
  const TranslationCache = req.model('TranslationCache');
  const cached = await TranslationCache.countDocuments({}).catch(() => 0);
  res.json({ success: true, data: {
    configured: translateService.configured(), // global GCP config — no ctx
    languages: translateService.LANGUAGES,
    cachedTranslations: cached,
    run: translateService.getRunState(), // global run state — no ctx
  } });
});

// Translation run history — the audit table on the admin Translation page.
exports.translationRuns = asyncHandler(async (req, res) => {
  const TranslationRun = req.model('TranslationRun');
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const runs = await TranslationRun.find({}).sort({ createdAt: -1 }).limit(limit).lean();
  res.json({ success: true, data: runs });
});
