const asyncHandler = require('../utils/asyncHandler');
const authService = require('../services/authService');

const meta = (req) => ({ userAgent: req.headers['user-agent'], ip: req.ip });

exports.requestOtp = asyncHandler(async (req, res) => {
  const data = await authService.requestOtp(req.body.phone);
  res.json({ success: true, data });
});

exports.verifyOtp = asyncHandler(async (req, res) => {
  const data = await authService.verifyOtp(req.body.phone, req.body.code, meta(req));
  res.json({ success: true, data });
});

exports.refresh = asyncHandler(async (req, res) => {
  const data = await authService.refresh(req.body.refreshToken, meta(req));
  res.json({ success: true, data });
});

exports.logout = asyncHandler(async (req, res) => {
  await authService.logout(req.body.refreshToken);
  res.json({ success: true });
});

exports.me = asyncHandler(async (req, res) => {
  const user = await authService.me(req.user._id);
  res.json({ success: true, data: user });
});

exports.updateMe = asyncHandler(async (req, res) => {
  Object.assign(req.user, req.body);
  await req.user.save();
  res.json({ success: true, data: req.user.toSafeJSON() });
});

exports.registerFcmToken = asyncHandler(async (req, res) => {
  const { token, platform, deviceId, deviceName, deviceModel, osVersion, appVersion } = req.body;
  await authService.registerFcmToken(req.user._id, token, platform, {
    deviceId,
    deviceName,
    deviceModel,
    osVersion,
    appVersion,
  });
  res.json({ success: true });
});

exports.removeFcmToken = asyncHandler(async (req, res) => {
  await authService.removeFcmToken(req.user._id, req.body.token);
  res.json({ success: true });
});
