const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const AstrologerProfile = require('../models/AstrologerProfile');
const otpService = require('./otpService');
const walletService = require('./walletService');
const AdminSettings = require('../models/AdminSettings');
const { signAccess } = require('../utils/token');
const { sha256, randomToken } = require('../utils/hash');
const { normalizePhone } = require('../utils/phone');
const AppError = require('../utils/AppError');
const env = require('../config/env');

async function issueRefresh(user, meta = {}) {
  const raw = randomToken(32);
  const tokenHash = sha256(raw);
  const expiresAt = new Date(Date.now() + env.jwt.refreshTtlDays * 24 * 60 * 60 * 1000);
  await RefreshToken.create({ user: user._id, tokenHash, expiresAt, userAgent: meta.userAgent, ip: meta.ip });
  return raw;
}

async function buildAuthResponse(user, meta) {
  const accessToken = signAccess(user);
  const refreshToken = await issueRefresh(user, meta);
  return { accessToken, refreshToken, user: user.toSafeJSON() };
}

async function requestOtp(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new AppError('Enter a valid 10-digit phone number', 400);
  return otpService.requestOtp(normalized);
}

/** Verify OTP, upsert the user, credit signup bonus on first verify, mint tokens. */
async function verifyOtp(phone, code, meta = {}) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new AppError('Enter a valid 10-digit phone number', 400);
  phone = normalized;
  await otpService.verifyOtp(phone, code);

  let user = await User.findOne({ phone });
  let isNewUser = false;
  if (!user) {
    user = await User.create({ phone, isPhoneVerified: true });
    isNewUser = true;
    // Auto-create the user's astro-themed referral code on signup.
    await require('./referralService').ensureCode(user).catch(() => {});
    // New-user perks — admin can enable either, both, or neither.
    const settings = await AdminSettings.get();
    if (settings.signupBonusEnabled && settings.signupBonus > 0) {
      await walletService.credit({
        userId: user._id,
        amount: settings.signupBonus,
        source: 'bonus',
        description: 'Signup bonus',
        refId: `signup-bonus:${user._id}`,
      });
    }
    if (settings.signupFreeChatEnabled && settings.signupFreeChatMinutes > 0) {
      user.freeChatMinutes = settings.signupFreeChatMinutes;
      await user.save();
    }
    // System template: welcome notification for new users (sent if enabled).
    require('./broadcastService').fireEvent('user_signup', { userId: user._id, vars: { name: user.name || 'there' } });
  } else if (!user.isPhoneVerified) {
    user.isPhoneVerified = true;
    await user.save();
  }

  if (user.isBlocked) throw new AppError('Your account has been blocked by the admin. Please contact support for assistance.', 403);

  const auth = await buildAuthResponse(user, meta);
  return { ...auth, isNewUser };
}

// ── Admin-driven user onboarding (with OTP verification) ──

/** Admin triggers an OTP to a prospective user's phone (dummy 123456 in dev). */
async function adminRequestUserOtp(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new AppError('Enter a valid 10-digit phone number', 400);
  const existing = await User.findOne({ phone: normalized });
  if (existing) throw new AppError('A user with this phone already exists', 409);
  return otpService.requestOtp(normalized);
}

/**
 * Admin creates a user after verifying the OTP. Applies the same signup perks
 * as a real app signup. Does NOT mint tokens — returns the created user only.
 */
async function adminCreateUser({ phone, code, name, email }) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new AppError('Enter a valid 10-digit phone number', 400);
  await otpService.verifyOtp(normalized, code);

  let user = await User.findOne({ phone: normalized });
  if (user) throw new AppError('A user with this phone already exists', 409);

  user = await User.create({
    phone: normalized,
    isPhoneVerified: true,
    name: name || undefined,
    email: email || undefined,
  });

  // Same new-user perks as the public flow (admin chose to apply them).
  const settings = await AdminSettings.get();
  if (settings.signupBonusEnabled && settings.signupBonus > 0) {
    await walletService.credit({
      userId: user._id,
      amount: settings.signupBonus,
      source: 'bonus',
      description: 'Signup bonus',
      refId: `signup-bonus:${user._id}`,
    });
  }
  if (settings.signupFreeChatEnabled && settings.signupFreeChatMinutes > 0) {
    user.freeChatMinutes = settings.signupFreeChatMinutes;
    await user.save();
  }

  return user;
}

/** Rotate refresh token; detect reuse and revoke the whole family. */
async function refresh(rawToken, meta = {}) {
  if (!rawToken) throw new AppError('Refresh token required', 400);
  const tokenHash = sha256(rawToken);
  const record = await RefreshToken.findOne({ tokenHash });
  if (!record) throw new AppError('Invalid refresh token', 401);

  if (record.revokedAt) {
    // Reuse of a revoked token => compromise. Revoke all tokens for the user.
    await RefreshToken.updateMany({ user: record.user, revokedAt: null }, { $set: { revokedAt: new Date() } });
    throw new AppError('Refresh token reuse detected. Please log in again.', 401);
  }
  if (record.expiresAt.getTime() < Date.now()) throw new AppError('Refresh token expired', 401);

  const user = await User.findById(record.user);
  if (!user || user.isBlocked) throw new AppError('Account unavailable', 401);

  const newRaw = randomToken(32);
  const newHash = sha256(newRaw);
  const expiresAt = new Date(Date.now() + env.jwt.refreshTtlDays * 24 * 60 * 60 * 1000);
  await RefreshToken.create({ user: user._id, tokenHash: newHash, expiresAt, userAgent: meta.userAgent, ip: meta.ip });
  await RefreshToken.updateOne({ _id: record._id }, { $set: { revokedAt: new Date(), replacedBy: newHash } });

  return { accessToken: signAccess(user), refreshToken: newRaw };
}

async function logout(rawToken) {
  if (!rawToken) return;
  await RefreshToken.updateOne({ tokenHash: sha256(rawToken) }, { $set: { revokedAt: new Date() } });
}

async function me(userId) {
  const user = await User.findById(userId).populate('astrologerProfile');
  if (!user) throw new AppError('User not found', 404);
  return user;
}

/**
 * Register (or refresh) this device's push token. Supports multi-device: one
 * row per device in `fcmTokens`. We dedup by the stable `deviceId` when the
 * client supplies one (the FCM token rotates but the device doesn't), so a
 * re-login or token refresh on the same phone UPDATES its row in place instead
 * of piling up duplicates. Without a deviceId we fall back to deduping by token
 * (old behaviour). Also captures the device name/model/OS for the admin panel.
 *
 * @param {object} [device] { deviceId, deviceName, deviceModel, osVersion, appVersion }
 */
async function registerFcmToken(userId, token, platform = 'android', device = {}) {
  const now = new Date();
  const clip = (s, n) => (s == null ? undefined : String(s).slice(0, n));
  const entry = {
    token,
    platform,
    deviceId: clip(device.deviceId, 128),
    deviceName: clip(device.deviceName, 120),
    deviceModel: clip(device.deviceModel, 120),
    osVersion: clip(device.osVersion, 60),
    appVersion: clip(device.appVersion, 40),
    addedAt: now,
    lastUsedAt: now,
  };

  // Drop any prior row for this device (matched by deviceId when available, and
  // always by this exact token to avoid a stale duplicate after rotation),
  // then push the fresh entry. Two pulls because $or inside $pull on the same
  // array key in one update isn't reliable across re-registers.
  const pull = { fcmTokens: { token } };
  await User.updateOne({ _id: userId }, { $pull: pull });
  if (entry.deviceId) {
    await User.updateOne({ _id: userId }, { $pull: { fcmTokens: { deviceId: entry.deviceId } } });
  }
  await User.updateOne({ _id: userId }, { $push: { fcmTokens: entry } });
}

async function removeFcmToken(userId, token) {
  await User.updateOne({ _id: userId }, { $pull: { fcmTokens: { token } } });
}

module.exports = { requestOtp, verifyOtp, adminRequestUserOtp, adminCreateUser, refresh, logout, me, registerFcmToken, removeFcmToken };
