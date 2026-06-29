const bcrypt = require('bcryptjs');
const OtpRequest = require('../models/OtpRequest');
const waBridge = require('./waBridgeService');
const { randomInt } = require('../utils/hash');
const AppError = require('../utils/AppError');
const env = require('../config/env');
const logger = require('../utils/logger');

function genCode() {
  // env.isDev uses a fixed code for easy testing; prod is random 6-digit.
  if (env.isDev) return env.otp.devCode;
  let code = '';
  for (let i = 0; i < env.otp.length; i++) code += randomInt(0, 9);
  return code;
}

/** Send (or resend) an OTP to a phone with throttling. */
async function requestOtp(phone) {
  const now = Date.now();

  // Per-phone throttle (cooldown + hourly cap) — production only, so dev/testing
  // isn't blocked. IP-level limiting also skips in dev (see middlewares/rateLimit).
  if (env.isProd) {
    const latest = await OtpRequest.findOne({ phone }).sort({ createdAt: -1 });
    if (latest && latest.lastSentAt && now - latest.lastSentAt.getTime() < env.otp.resendCooldownSec * 1000) {
      throw new AppError('Please wait before requesting another code', 429);
    }
    const oneHourAgo = new Date(now - 60 * 60 * 1000);
    const recentCount = await OtpRequest.countDocuments({ phone, createdAt: { $gte: oneHourAgo } });
    if (recentCount >= env.otp.maxSendsPerHour) {
      throw new AppError('Too many OTP requests this hour', 429);
    }
  }

  const code = genCode();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(now + env.otp.ttlSec * 1000);

  // Invalidate any still-live OTPs for this phone, then create a fresh one.
  await OtpRequest.updateMany({ phone, consumed: false }, { $set: { consumed: true } });
  await OtpRequest.create({ phone, codeHash, expiresAt, lastSentAt: new Date(), sendCount: 1 });

  if (env.isDev) {
    logger.info('[OTP DEV] code generated', { phone, code });
  } else {
    await waBridge.sendText({ to: phone, message: `${code} is your Rudraganga verification code. It is valid for 10 minutes.` });
  }

  return { message: 'OTP sent', expiresInSec: env.otp.ttlSec, devCode: env.isDev ? code : undefined };
}

/** Verify a submitted code. Returns true on success; throws otherwise. */
async function verifyOtp(phone, code) {
  const otp = await OtpRequest.findOne({ phone, consumed: false }).sort({ createdAt: -1 }).select('+codeHash');
  if (!otp) throw new AppError('No active OTP. Please request a new one.', 400);
  if (otp.expiresAt.getTime() < Date.now()) throw new AppError('OTP expired. Please request a new one.', 400);
  if (otp.attempts >= env.otp.maxVerifyAttempts) throw new AppError('Too many attempts. Request a new OTP.', 429);

  const ok = await bcrypt.compare(String(code), otp.codeHash);
  if (!ok) {
    await OtpRequest.updateOne({ _id: otp._id }, { $inc: { attempts: 1 } });
    throw new AppError('Incorrect code', 400);
  }

  await OtpRequest.updateOne({ _id: otp._id }, { $set: { consumed: true } });
  return true;
}

module.exports = { requestOtp, verifyOtp };
