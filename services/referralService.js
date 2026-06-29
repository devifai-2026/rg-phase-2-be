const User = require('../models/User');
const AdminSettings = require('../models/AdminSettings');
const walletService = require('./walletService');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

// Astro-themed code prefixes → e.g. STAR7K2, COSMIC9X, RAASHI4F.
const ASTRO_WORDS = ['STAR', 'COSMIC', 'RAASHI', 'KUNDLI', 'NAKSHA', 'GRAHA', 'SHANI', 'SURYA', 'CHANDRA', 'RAHU', 'GURU', 'MANGAL'];
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous O/0/I/1

function randomSuffix(n = 4) {
  let s = '';
  for (let i = 0; i < n; i++) s += CHARS[Math.floor(Math.random() * CHARS.length)];
  return s;
}

/** Generate a unique astro-themed referral code. */
async function generateUniqueCode() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const word = ASTRO_WORDS[Math.floor(Math.random() * ASTRO_WORDS.length)];
    const code = `${word}${randomSuffix(4)}`;
    const exists = await User.exists({ referralCode: code });
    if (!exists) return code;
  }
  // Fallback: longer suffix to virtually guarantee uniqueness.
  return `STAR${randomSuffix(7)}`;
}

/** Ensure a user has a referral code (auto-created on signup; idempotent). */
async function ensureCode(user) {
  if (user.referralCode) return user.referralCode;
  const code = await generateUniqueCode();
  user.referralCode = code;
  await user.save();
  return code;
}

/** The reward each side gets, from admin settings (default ₹50). */
async function rewardAmount() {
  try {
    const s = await AdminSettings.get();
    return s.referralReward != null ? Number(s.referralReward) : 50;
  } catch (_) {
    return 50;
  }
}

/**
 * Apply a referral code to a user (only valid for a brand-new user who hasn't
 * recharged yet and has no referrer). Stores referredBy; the actual credit
 * happens on the referee's FIRST successful recharge.
 */
async function applyCode(user, rawCode) {
  const code = (rawCode || '').trim().toUpperCase();
  if (!code) throw new AppError('Enter a referral code', 400);
  if (user.referredBy) throw new AppError('A referral code is already applied', 409);
  if (user.referralCode === code) throw new AppError("You can't use your own code", 400);

  const referrer = await User.findOne({ referralCode: code });
  if (!referrer) throw new AppError('Invalid referral code', 404);

  user.referredBy = referrer._id;
  await user.save();
  return { referrerName: referrer.name || 'A friend' };
}

/**
 * Called after a user's wallet recharge succeeds. If this was their FIRST
 * recharge and they were referred, credit BOTH the referee and the referrer.
 * Idempotent via the `referralRewarded` flag + per-side refIds.
 */
async function onFirstRecharge(userId) {
  try {
    const user = await User.findById(userId);
    if (!user || !user.referredBy || user.referralRewarded) return;

    const amount = await rewardAmount();
    if (amount < 1) { user.referralRewarded = true; await user.save(); return; }

    // Credit the referee (the new user who just recharged).
    await walletService.credit({
      userId: user._id, amount, source: 'bonus',
      description: 'Referral reward', refId: `ref-referee:${user._id}`,
    });
    // Credit the referrer.
    await walletService.credit({
      userId: user.referredBy, amount, source: 'bonus',
      description: "Referral reward — a friend you invited recharged", refId: `ref-referrer:${user._id}`,
    });
    await User.updateOne({ _id: user.referredBy }, { $inc: { referralCount: 1 } });

    user.referralRewarded = true;
    await user.save();

    require('./notificationService').notify(user.referredBy, {
      type: 'system', title: 'You earned a referral reward! 🎉',
      body: `A friend you invited made their first recharge. ₹${amount} added to your wallet.`,
    }).catch(() => {});
  } catch (e) {
    logger.warn('referral reward failed', e.message);
  }
}

module.exports = { ensureCode, applyCode, onFirstRecharge, rewardAmount, generateUniqueCode };
