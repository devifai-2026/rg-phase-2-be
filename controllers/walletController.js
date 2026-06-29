const asyncHandler = require('../utils/asyncHandler');
const walletService = require('../services/walletService');
const cacheService = require('../services/cacheService');

exports.getBalance = asyncHandler(async (req, res) => {
  const data = await walletService.getBalance(req.user._id);
  res.json({ success: true, data });
});

/**
 * App "Add money" packs — active recharge templates, ordered for display.
 * Cached in GCP Memorystore (long TTL) since packs are admin-managed and rarely
 * change. The cache is INVALIDATED whenever an admin creates/edits/deletes a
 * template (see adminController), so the app never serves stale packs. Falls
 * through to a direct Mongo read when the cache is off/unavailable.
 */
exports.listRechargeTemplates = asyncHandler(async (req, res) => {
  const items = await cacheService.withCache('recharge', 'active', 3600, async () => {
    const RechargeTemplate = require('../models/RechargeTemplate');
    return RechargeTemplate.find({ isActive: true }).sort({ sortOrder: 1, amount: 1 }).lean();
  });
  res.json({ success: true, data: items });
});

exports.listTransactions = asyncHandler(async (req, res) => {
  const { page, limit, type, source, days } = req.query;
  const data = await walletService.listTransactions(req.user._id, {
    page: parseInt(page || '1', 10),
    limit: Math.min(parseInt(limit || '20', 10), 100),
    type,
    source,
    days: days ? parseInt(days, 10) : undefined,
  });
  res.json({ success: true, data });
});
