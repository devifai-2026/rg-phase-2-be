const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/storefrontDesignService');

// "Let the Stars design your storefront" — astrologer-facing.

exports.usage = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await svc.usage(req.ctx, req.user._id) });
});

exports.generate = asyncHandler(async (req, res) => {
  const data = await svc.generate(req.ctx, req.user._id);
  res.status(201).json({ success: true, data });
});

exports.list = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await svc.list(req.ctx, req.user._id) });
});

exports.setActive = asyncHandler(async (req, res) => {
  const data = await svc.setActive(req.ctx, req.user._id, req.body.layoutId);
  res.json({ success: true, data });
});
