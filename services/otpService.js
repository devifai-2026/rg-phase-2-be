const bcrypt = require('bcryptjs');
const waBridge = require('./waBridgeService');
const { randomInt } = require('../utils/hash');
const AppError = require('../utils/AppError');
const env = require('../config/env');
const logger = require('../utils/logger');
const { defaultContext } = require('../utils/tenantContext');

function genCode() {
  // env.isDev uses a fixed code for easy testing; prod is random 6-digit.
  if (env.isDev) return env.otp.devCode;
  let code = '';
  for (let i = 0; i < env.otp.length; i++) code += randomInt(0, 9);
  return code;
}

/** Send (or resend) an OTP to a phone with throttling. */
async function requestOtp(ctx, phone) {
  ctx = ctx || defaultContext();
  const OtpRequest = ctx.model('OtpRequest');
  const now = Date.now();

  // Rate limiting removed from the platform — no per-phone cooldown / hourly cap.

  const code = genCode();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(now + env.otp.ttlSec * 1000);

  // Invalidate any still-live OTPs for this phone, then create a fresh one.
  await OtpRequest.updateMany({ phone, consumed: false }, { $set: { consumed: true } });
  await OtpRequest.create({ phone, codeHash, expiresAt, lastSentAt: new Date(), sendCount: 1 });

  // Deliver the code over WhatsApp WITHOUT blocking the HTTP response. The OTP
  // is already persisted above, so the app can proceed to the verify screen the
  // instant we reply — the WhatsApp message arrives a moment later. WABridge has
  // been intermittently slow (~15s), and awaiting it here made the whole
  // request time out → the app showed "no connection" even though the OTP was
  // valid. Fire-and-forget + log failures instead.
  if (env.isDev) {
    logger.info('[OTP DEV] code generated', { phone, code });
  } else {
    const deliver = env.waBridge.otpTemplateId
      // Template body: "Hello, here is your {{1}} for Rudraganga App {{2}} ..."
      // {{1}} = the literal word "OTP", {{2}} = the actual code (in that order).
      ? waBridge.sendTemplate({ to: phone, templateId: env.waBridge.otpTemplateId, variables: ['OTP', code] })
      : waBridge.sendText({
          to: phone,
          message: `${code} is your Rudraganga verification code. It is valid for ${Math.ceil(env.otp.ttlSec / 60)} minutes.`,
        });
    deliver.catch((e) => logger.error('OTP WhatsApp send failed', { phone, error: e.message }));
  }

  return { message: 'OTP sent', expiresInSec: env.otp.ttlSec, devCode: env.isDev ? code : undefined };
}

/** Verify a submitted code. Returns true on success; throws otherwise. */
async function verifyOtp(ctx, phone, code) {
  ctx = ctx || defaultContext();
  const OtpRequest = ctx.model('OtpRequest');
  const otp = await OtpRequest.findOne({ phone, consumed: false }).sort({ createdAt: -1 }).select('+codeHash');
  if (!otp) throw new AppError('No active OTP. Please request a new one.', 400);
  if (otp.expiresAt.getTime() < Date.now()) throw new AppError('OTP expired. Please request a new one.', 400);
  // Rate limiting removed — no max-verify-attempts cap.

  const ok = await bcrypt.compare(String(code), otp.codeHash);
  if (!ok) {
    await OtpRequest.updateOne({ _id: otp._id }, { $inc: { attempts: 1 } });
    throw new AppError('Incorrect code', 400);
  }

  await OtpRequest.updateOne({ _id: otp._id }, { $set: { consumed: true } });
  return true;
}

module.exports = { requestOtp, verifyOtp };
