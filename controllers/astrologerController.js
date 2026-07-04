const asyncHandler = require('../utils/asyncHandler');
const astrologerService = require('../services/astrologerService');
const AppError = require('../utils/AppError');
const trackService = require('../services/trackService');
const translateService = require('../services/translateService');

/** The requester's preferred language: authed user → ?language= → x-lang header → en. */
function reqLang(req) {
  return (req.user && req.user.language) || req.query.language || req.headers['x-lang'] || 'en';
}

/** Localize one stored-i18n-or-translate-on-read field. Prefers a stored i18n
 *  map value, else translates via the cache-backed path. Returns the source on
 *  English / empty / failure (never English-fallback for a real translation). */
async function localizeField(ctx, src, i18nMap, lang) {
  const text = String(src || '');
  if (!text.trim()) return text;
  const m = i18nMap || {};
  const stored = m.get ? m.get(lang) : m[lang];
  if (stored && stored !== text) return stored;
  return translateService.localizeText(ctx, text, lang);
}

/** Localize a NAME: prefer the stored nameI18n transliteration, else compute it
 *  on the fly via the rule-based engine (GCP won't transliterate proper names,
 *  so the translate-cache path is NOT used here). Returns source on failure. */
function localizeName(src, i18nMap, lang) {
  const text = String(src || '');
  if (!text.trim()) return text;
  const m = i18nMap || {};
  const stored = m.get ? m.get(lang) : m[lang];
  if (stored && stored !== text) return stored;
  try {
    return require('../services/transliterateService').transliterate(text, lang);
  } catch (_) {
    return text;
  }
}

/**
 * Localize an astrologer's user-visible dynamic text into `lang` with NO English
 * fallback. Covers the BIO and the NAME (displayName, transliterated into the
 * requester's script — e.g. "Ravi Kumar" → "रवि कुमार"). The Flutter app reads the
 * name from `displayName` (falling back to user.name), so we localize both.
 * Mutates the plain object in place. No-op for English.
 */
async function localizeAstrologer(ctx, a, lang) {
  if (!a || !lang || lang === 'en') return;
  await Promise.all([
    (async () => { if (a.bio) a.bio = await localizeField(ctx, a.bio, a.bioI18n, lang); })(),
    (async () => {
      // Name is transliterated (Latin proper names aren't translated by GCP), so
      // prefer the stored nameI18n entry; else transliterate on the fly.
      if (a.displayName) a.displayName = localizeName(a.displayName, a.nameI18n, lang);
    })(),
    (async () => {
      // The name can also arrive via the populated user.name fallback.
      if (a.user && a.user.name) a.user.name = localizeName(a.user.name, a.nameI18n, lang);
    })(),
    // Expertise/specialty tags (e.g. "Vedic", "Tarot") shown on the card/detail.
    (async () => {
      if (Array.isArray(a.expertise) && a.expertise.length) {
        a.expertise = await Promise.all(a.expertise.map((e) => translateService.localizeText(ctx, String(e), lang)));
      }
    })(),
  ]);
}

// ── Public ──
// Astrologer login gate: does an account exist for this phone? The app uses
// `exists` to decide between OTP login and sending the person to registration.
exports.checkExists = asyncHandler(async (req, res) => {
  const data = await astrologerService.checkExists(req.ctx, req.params.phone);
  res.json({ success: true, data });
});

// Shared expertise catalog (public). Drives the app + admin pickers so options
// always match and admin-created expertise shows everywhere.
exports.listExpertise = asyncHandler(async (req, res) => {
  const data = await astrologerService.listExpertise(req.ctx);
  res.json({ success: true, data });
});

exports.submitApplication = asyncHandler(async (req, res) => {
  const data = await astrologerService.submitApplication(req.ctx, req.body);
  // Attribute this anonId's visits to an astrologer-apply conversion (fire-and-forget).
  if (req.body.anonId) trackService.attributeConversion(req.ctx, req.body.anonId, 'astrologer_apply');
  res.status(201).json({ success: true, data, message: 'Application received. Our team will contact you.' });
});

exports.listPublic = asyncHandler(async (req, res) => {
  const data = await astrologerService.listPublic(req.ctx, {
    q: req.query.q,
    expertise: req.query.expertise,
    language: req.query.language,
    online: req.query.online,
    featured: req.query.featured,
    maxPrice: req.query.maxPrice,
    city: req.query.city,
    random: req.query.random,
    page: parseInt(req.query.page || '1', 10),
    limit: Math.min(parseInt(req.query.limit || '20', 10), 100),
  });
  const lang = reqLang(req);
  if (Array.isArray(data.items)) await Promise.all(data.items.map((a) => localizeAstrologer(req.ctx, a, lang)));
  res.json({ success: true, data });
});

exports.getPublic = asyncHandler(async (req, res) => {
  const data = await astrologerService.getPublic(req.ctx, req.params.id);
  await localizeAstrologer(req.ctx, data, reqLang(req));
  res.json({ success: true, data });
});

/** Follow / unfollow an astrologer (unfollow keeps an optional reason). :id = profile id. */
exports.toggleFollow = asyncHandler(async (req, res) => {
  const Follow = req.model('Follow');
  const AstrologerProfile = req.model('AstrologerProfile');
  const profile = await AstrologerProfile.findById(req.params.id).select('user followerSeed followerCount');
  if (!profile) throw new AppError('Astrologer not found', 404);
  const follow = req.body.follow !== false; // default true

  // Read the prior state so we only move followerCount on a REAL transition
  // (idempotent: re-following / re-unfollowing doesn't double-count).
  const prev = await Follow.findOne({ user: req.user._id, astrologer: profile.user }).select('active');
  const wasActive = !!(prev && prev.active);

  const update = follow
    ? { active: true, $unset: { unfollowReason: '', unfollowedAt: '' }, $setOnInsert: { astrologerProfile: profile._id } }
    : { active: false, unfollowReason: (req.body.reason || '').toString().slice(0, 300), unfollowedAt: new Date() };
  const doc = await Follow.findOneAndUpdate(
    { user: req.user._id, astrologer: profile.user },
    update,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // Keep the denormalized count in sync only when active actually flipped.
  let followerCount = profile.followerCount || 0;
  if (doc.active && !wasActive) {
    const r = await AstrologerProfile.findByIdAndUpdate(profile._id, { $inc: { followerCount: 1 } }, { new: true }).select('followerCount');
    followerCount = r.followerCount;
    // Tell the astrologer they gained a follower (push + in-app). Tapping opens
    // their followers page. Best-effort — never block the follow response.
    const follower = await req.model('User').findById(req.user._id).select('name').lean();
    require('../services/notificationService')
      .notify(req.ctx, profile.user, {
        type: 'new_follower',
        title: 'New follower! 🌟',
        body: `${(follower && follower.name) || 'Someone'} just followed you. Your guidance is reaching more seekers — keep shining!`,
        data: { type: 'new_follower', kind: 'new_follower' },
      })
      .catch(() => {});
  } else if (!doc.active && wasActive) {
    const r = await AstrologerProfile.findByIdAndUpdate(profile._id, { $inc: { followerCount: -1 } }, { new: true }).select('followerCount');
    followerCount = Math.max(0, r.followerCount); // guard against drift below 0
    if (r.followerCount < 0) await AstrologerProfile.updateOne({ _id: profile._id }, { $set: { followerCount: 0 } });
  }
  // Public followers = admin seed floor + real active follows.
  const followers = (profile.followerSeed || 0) + followerCount;
  res.json({ success: true, data: { following: doc.active, followers } });
});

/**
 * Astrologer self-service: my followers list (name, photo, since). Newest first.
 * Drives the astrologer app's Followers page.
 */
exports.myFollowers = asyncHandler(async (req, res) => {
  const Follow = req.model('Follow');
  const page = parseInt(req.query.page || '1', 10);
  const limit = Math.min(parseInt(req.query.limit || '30', 10), 100);
  const skip = (page - 1) * limit;
  const filter = { astrologer: req.user._id, active: true };
  const [rows, total] = await Promise.all([
    Follow.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).populate('user', 'name avatar').lean(),
    Follow.countDocuments(filter),
  ]);
  const items = rows.map((r) => ({
    name: (r.user && r.user.name) || 'Seeker',
    avatar: (r.user && r.user.avatar) || null,
    since: r.updatedAt || r.createdAt,
  }));
  res.json({ success: true, data: { items, total, page, limit } });
});

/**
 * Current user's follow state + the astrologer's public follower count.
 * Lets the profile screen restore the Follow/Unfollow button on open.
 * :id = AstrologerProfile id.
 */
exports.myFollow = asyncHandler(async (req, res) => {
  const Follow = req.model('Follow');
  const AstrologerProfile = req.model('AstrologerProfile');
  const profile = await AstrologerProfile.findById(req.params.id).select('user followerSeed followerCount');
  if (!profile) throw new AppError('Astrologer not found', 404);
  const doc = await Follow.findOne({ user: req.user._id, astrologer: profile.user }).select('active');
  const followers = (profile.followerSeed || 0) + (profile.followerCount || 0);
  res.json({ success: true, data: { following: !!(doc && doc.active), followers } });
});

/**
 * User asks to be notified when a busy/offline astrologer is available for a
 * service. Idempotent: re-requesting the same (user, astrologer, service)
 * reuses the pending row. :id = AstrologerProfile id.
 */
exports.notifyWhenAvailable = asyncHandler(async (req, res) => {
  const NotifyRequest = req.model('NotifyRequest');
  const AstrologerProfile = req.model('AstrologerProfile');
  const profile = await AstrologerProfile.findById(req.params.id).select('user');
  if (!profile) throw new AppError('Astrologer not found', 404);
  const service = req.body.service;
  if (!['call', 'chat', 'video'].includes(service)) throw new AppError('Invalid service', 400);

  // Detect whether a pending request already existed so the client can show
  // "you'll be notified" vs a fresh confirmation (idempotent either way).
  const existing = await NotifyRequest.findOne({ user: req.user._id, astrologer: profile.user, service, status: 'pending' }).select('_id');
  const doc = await NotifyRequest.findOneAndUpdate(
    { user: req.user._id, astrologer: profile.user, service, status: 'pending' },
    { $setOnInsert: { astrologerProfile: profile._id } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // A genuinely NEW waiter (not a repeat tap) → nudge the astrologer that
  // someone is waiting, so they're pulled back online. Only fires on a fresh
  // request; the notify-me button only appears when the astrologer is busy/
  // offline, so this covers both. Throttled + fire-and-forget inside the service.
  if (!existing) {
    require('../services/presenceService').nudgeAstrologerWaiting(req.ctx, profile.user).catch(() => {});
  }

  res.status(201).json({ success: true, data: { ...doc.toObject(), alreadyRequested: !!existing } });
});

/**
 * Which services the current user has a PENDING notify-me request for on this
 * astrologer. Lets the profile screen restore the "you'll be notified" state on
 * open. :id = AstrologerProfile id. Returns { services: ['chat', ...] }.
 */
exports.myNotifyRequests = asyncHandler(async (req, res) => {
  const NotifyRequest = req.model('NotifyRequest');
  const AstrologerProfile = req.model('AstrologerProfile');
  const profile = await AstrologerProfile.findById(req.params.id).select('user');
  if (!profile) throw new AppError('Astrologer not found', 404);
  const rows = await NotifyRequest.find({ user: req.user._id, astrologer: profile.user, status: 'pending' }).select('service');
  res.json({ success: true, data: { services: rows.map((r) => r.service) } });
});

// ── Astrologer self-service ──
exports.setOnline = asyncHandler(async (req, res) => {
  const data = await astrologerService.setOnline(req.ctx, req.user._id, req.body.online);
  res.json({ success: true, data: { isOnline: data.isOnline, currentCallStatus: data.currentCallStatus } });
});

/**
 * Reachability ACK — the astrologer's device proves it has working internet by
 * ACKing a silent FCM `presence_ping` (or on any app foreground). Refreshes
 * lastReachableAt so a killed-but-online device stays online; a device with no
 * internet can't call this, so its window lapses and reconcile flips it offline.
 * Must be light + idempotent: called from the headless FCM background isolate.
 */
exports.presenceAck = asyncHandler(async (req, res) => {
  const presenceService = require('../services/presenceService');
  const data = await presenceService.markReachable(req.ctx, req.user._id);
  res.json({ success: true, data: data || {} });
});

/** Astrologer reads their saved payout (bank / UPI) details. */
exports.getPayoutDetails = asyncHandler(async (req, res) => {
  const AstrologerProfile = req.model('AstrologerProfile');
  const profile = await AstrologerProfile.findOne({ user: req.user._id }).select('payoutDetails').lean();
  if (!profile) throw new AppError('No astrologer profile', 404);
  res.json({ success: true, data: profile.payoutDetails || {} });
});

/**
 * Astrologer adds/edits their bank account / UPI. Saves INSTANTLY (usable for
 * the next withdrawal) and notifies the admin (no approval gate). Requires at
 * least an account number (+IFSC) or a UPI id.
 */
exports.savePayoutDetails = asyncHandler(async (req, res) => {
  const { accountNumber, ifsc, beneficiaryName, upi } = req.body || {};
  if (!accountNumber && !upi) throw new AppError('Enter a bank account or a UPI id', 400);
  if (accountNumber && !ifsc) throw new AppError('IFSC is required with a bank account', 400);

  const AstrologerProfile = req.model('AstrologerProfile');
  const payoutDetails = {
    accountNumber: (accountNumber || '').trim() || undefined,
    ifsc: (ifsc || '').trim().toUpperCase() || undefined,
    beneficiaryName: (beneficiaryName || '').trim() || undefined,
    upi: (upi || '').trim() || undefined,
  };
  const profile = await AstrologerProfile.findOneAndUpdate(
    { user: req.user._id },
    { $set: { payoutDetails } },
    { new: true }
  ).select('payoutDetails displayName');
  if (!profile) throw new AppError('No astrologer profile', 404);

  // Notify admin (live badge + bell). Mask the account in the title.
  const masked = payoutDetails.accountNumber
    ? `••••${payoutDetails.accountNumber.slice(-4)}`
    : payoutDetails.upi;
  require('../websockets/emit').adminActivity('bank_account', {
    id: profile._id,
    title: `${profile.displayName || 'An astrologer'} updated payout details (${masked})`,
  });

  res.json({ success: true, data: profile.payoutDetails });
});

exports.myProfile = asyncHandler(async (req, res) => {
  const AstrologerProfile = req.model('AstrologerProfile');
  const profile = await AstrologerProfile.findOne({ user: req.user._id })
    .populate('user', 'name phone email language profileCompleted');
  if (!profile) throw new AppError('No astrologer profile', 404);

  // Surface the astrologer's LIVE reputation (their own profile tab reads these):
  //   followers = admin seed + real active follows (followerCount)
  //   giftCount = real gifts actually received (GiftTransaction), not the seed
  //   rating/reviewCount already live on the doc (recomputed on each new review)
  const GiftTransaction = req.model('GiftTransaction');
  const realGiftCount = await GiftTransaction.countDocuments({ receiver: req.user._id });

  const data = profile.toObject();
  data.followers = (profile.followerSeed || 0) + (profile.followerCount || 0);
  // Total gifts shown = the admin display seed + real gifts received.
  data.giftCount = ((profile.giftDisplay && profile.giftDisplay.count) || 0) + realGiftCount;
  res.json({ success: true, data });
});

// Astrologer edits their own editable fields (bio/expertise/languages/
// experience/photos) + UI language. Rates/commission/KYC/name stay admin-only.
exports.updateMyProfile = asyncHandler(async (req, res) => {
  const data = await astrologerService.updateMyProfile(req.ctx, req.user._id, req.body);
  res.json({ success: true, data });
});

// Dashboard consultation stats (per-service + this-month earnings).
exports.myStats = asyncHandler(async (req, res) => {
  const data = await astrologerService.myStats(req.ctx, req.user._id);
  res.json({ success: true, data });
});

// ── Admin ──
exports.adminList = asyncHandler(async (req, res) => {
  const data = await astrologerService.adminList(req.ctx, {
    status: req.query.status,
    page: parseInt(req.query.page || '1', 10),
    limit: Math.min(parseInt(req.query.limit || '20', 10), 100),
  });
  res.json({ success: true, data });
});

exports.adminUpdate = asyncHandler(async (req, res) => {
  const data = await astrologerService.adminUpdate(req.ctx, req.params.id, req.body, req.user._id);
  res.json({ success: true, data });
});

// Admin requests an OTP to verify an astrologer's phone before create / phone
// change (dev code 123456). The number must be free — surfaced early here so the
// admin sees the conflict before typing the code.
exports.adminRequestAstrologerOtp = asyncHandler(async (req, res) => {
  const { normalizePhone } = require('../utils/phone');
  const phone = normalizePhone(req.body.phone);
  if (!phone) throw new AppError('Enter a valid 10-digit phone number', 400);
  await req.model('User').assertPhoneAvailable(phone);
  const data = await require('../services/otpService').requestOtp(req.ctx, phone);
  res.json({ success: true, data });
});

// Admin manually creates an astrologer (skips the public lead flow).
exports.adminCreate = asyncHandler(async (req, res) => {
  const data = await astrologerService.adminCreate(req.ctx, req.body, req.user._id);
  res.status(201).json({ success: true, data });
});

exports.adminDelete = asyncHandler(async (req, res) => {
  await astrologerService.adminDelete(req.ctx, req.params.id, req.user._id);
  res.json({ success: true });
});

// Permanently delete a non-active application (lead) + its placeholder user.
exports.adminDeleteApplication = asyncHandler(async (req, res) => {
  await astrologerService.adminDeleteApplication(req.ctx, req.params.id);
  res.json({ success: true });
});

exports.adminDetail = asyncHandler(async (req, res) => {
  const AstrologerProfile = req.model('AstrologerProfile');
  const data = await AstrologerProfile.findById(req.params.id).populate('user', 'name phone email isBlocked');
  if (!data) throw new AppError('Astrologer not found', 404);
  res.json({ success: true, data });
});
