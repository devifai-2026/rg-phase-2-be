const asyncHandler = require('../utils/asyncHandler');
const uploadService = require('../services/uploadService');
const AppError = require('../utils/AppError');

// ── Profile photo ──
exports.uploadAvatar = asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError('Image file required (field: image)', 400);
  const { url } = await uploadService.uploadImage(req.file.buffer, `avatar-${req.user._id}`, { tenantSlug: req.tenant && req.tenant.slug });
  req.user.avatar = url;
  await req.user.save();
  res.json({ success: true, data: { avatar: url } });
});

/** Generic image upload (returns a hosted URL to attach anywhere). */
exports.uploadImage = asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError('Image file required (field: image)', 400);
  const result = await uploadService.uploadImage(req.file.buffer, req.file.originalname, { tenantSlug: req.tenant && req.tenant.slug });
  res.json({ success: true, data: result });
});

// ── Address book (e-commerce style) ──
exports.listAddresses = asyncHandler(async (req, res) => {
  res.json({ success: true, data: req.user.addresses });
});

exports.addAddress = asyncHandler(async (req, res) => {
  const addr = req.body;
  // If this is the first address or marked default, make it the sole default.
  if (addr.isDefault || req.user.addresses.length === 0) {
    req.user.addresses.forEach((a) => (a.isDefault = false));
    addr.isDefault = true;
  }
  req.user.addresses.push(addr);
  await req.user.save();
  res.status(201).json({ success: true, data: req.user.addresses });
});

exports.updateAddress = asyncHandler(async (req, res) => {
  const addr = req.user.addresses.id(req.params.addressId);
  if (!addr) throw new AppError('Address not found', 404);
  Object.assign(addr, req.body);
  if (req.body.isDefault) {
    req.user.addresses.forEach((a) => (a.isDefault = String(a._id) === String(addr._id)));
  }
  await req.user.save();
  res.json({ success: true, data: req.user.addresses });
});

exports.deleteAddress = asyncHandler(async (req, res) => {
  const addr = req.user.addresses.id(req.params.addressId);
  if (!addr) throw new AppError('Address not found', 404);
  const wasDefault = addr.isDefault;
  addr.deleteOne();
  if (wasDefault && req.user.addresses.length) req.user.addresses[0].isDefault = true;
  await req.user.save();
  res.json({ success: true, data: req.user.addresses });
});

exports.setDefaultAddress = asyncHandler(async (req, res) => {
  let found = false;
  req.user.addresses.forEach((a) => {
    a.isDefault = String(a._id) === String(req.params.addressId);
    if (a.isDefault) found = true;
  });
  if (!found) throw new AppError('Address not found', 404);
  await req.user.save();
  res.json({ success: true, data: req.user.addresses });
});

// ── Referral ──
const referralService = require('../services/referralService');

/** GET /users/referral — my code, reward amount, friends rewarded, applied state. */
exports.referral = asyncHandler(async (req, res) => {
  const code = await referralService.ensureCode(req.ctx, req.user); // backfill for older users
  const reward = await referralService.rewardAmount(req.ctx);
  res.json({
    success: true,
    data: {
      code,
      reward,
      referralCount: req.user.referralCount || 0,
      hasAppliedCode: !!req.user.referredBy,
      canApplyCode: !req.user.referredBy && !req.user.referralRewarded,
    },
  });
});

/** POST /users/referral/apply { code } — apply a friend's code (new users). */
exports.applyReferral = asyncHandler(async (req, res) => {
  const result = await referralService.applyCode(req.ctx, req.user, req.body.code);
  res.json({ success: true, data: result, message: 'Referral applied! Both of you earn on your first recharge.' });
});
