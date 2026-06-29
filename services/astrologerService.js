const User = require('../models/User');
const AstrologerProfile = require('../models/AstrologerProfile');
const notificationService = require('./notificationService');
const cacheService = require('./cacheService');
const { toRupees } = require('../utils/money');
const AppError = require('../utils/AppError');

// Cache namespace for public astrologer reads. Invalidated on any write below.
const CACHE_NS = 'astro';
// Online status flips often, so the list TTL is short; profiles change rarely.
const LIST_TTL = 20; // seconds
const PROFILE_TTL = 120; // seconds

/** Drop all cached public astrologer reads (list variants + profiles). */
async function invalidateAstroCache() {
  await cacheService.delNamespace(CACHE_NS);
}

/**
 * Case-insensitive de-duplication of a tag list (languages / expertise),
 * preserving the FIRST-seen casing + order. "bengali" + "Bengali" → one entry.
 * Trims blanks. Used on every profile save so the DB never holds duplicates.
 */
function dedupeTags(list) {
  if (!Array.isArray(list)) return list;
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const v = String(raw == null ? '' : raw).trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/** Escape user-supplied text for safe use inside a RegExp. */
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Default expertise the catalog is seeded with (superset of what the admin
// editor + app historically hardcoded). Admin-typed values add to this.
const DEFAULT_EXPERTISE = [
  'Vedic', 'Numerology', 'Vastu', 'Tarot', 'Palmistry', 'KP', 'Lal Kitab',
  'Nadi', 'Prashna', 'Western',
];

/**
 * Upsert each name into the shared Expertise catalog (case-insensitive match on
 * the canonical label). Called whenever an astrologer's expertise is saved so a
 * newly-typed specialization becomes available to everyone. Best-effort.
 */
async function ensureExpertise(names) {
  if (!Array.isArray(names) || names.length === 0) return;
  const Expertise = require('../models/Expertise');
  for (const raw of names) {
    const name = String(raw || '').trim();
    if (!name) continue;
    try {
      await Expertise.updateOne(
        { name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' } },
        { $setOnInsert: { name, isActive: true, sortOrder: 100 } },
        { upsert: true }
      );
    } catch (e) {
      require('../utils/logger').debug('ensureExpertise failed', name, e.message);
    }
  }
}

/**
 * The active expertise catalog (seeded with defaults on first read so the app
 * always gets a populated list). Returns plain display labels, ordered.
 */
async function listExpertise() {
  const Expertise = require('../models/Expertise');
  let rows = await Expertise.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).select('name').lean();
  if (rows.length === 0) {
    await ensureExpertise(DEFAULT_EXPERTISE);
    rows = await Expertise.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).select('name').lean();
  }
  return rows.map((r) => r.name);
}

/**
 * Broadcast an astrologer's live status to every connected user so discover
 * lists/rails update in realtime (no refetch). Cheap public payload only.
 * Also drops the public list cache so any fresh fetch is consistent.
 */
async function broadcastStatus(profileId, { isOnline, currentCallStatus, live, liveSessionId } = {}) {
  try {
    const payload = {
      profileId: String(profileId),
      isOnline: !!isOnline,
      currentCallStatus: currentCallStatus || (isOnline ? 'available' : 'offline'),
    };
    // When the astrologer is broadcasting LIVE, carry an explicit flag (+ the
    // live session id) so user-app cards can show a distinct "Live" state with a
    // Join affordance. The profile's currentCallStatus stays 'busy' so 1-on-1
    // consultation gating is unaffected — `live` is purely a display signal.
    if (live) { payload.live = true; payload.liveSessionId = liveSessionId ? String(liveSessionId) : undefined; }
    require('../websockets/emit').broadcast('astrologer-status', payload);
  } catch (e) {
    require('../utils/logger').warn('broadcastStatus failed', e.message);
  }
}

/** Look up a profile id by its owning user id, then broadcast its status. */
async function broadcastStatusByUser(userId, statusFields) {
  const p = await AstrologerProfile.findOne({ user: userId }).select('_id').lean();
  if (p) await broadcastStatus(p._id, statusFields);
}

/**
 * Astrologer onboarding. Accounts are ADMIN-CREATED: the public signup is just
 * a lead/application (applicationStatus='applied'). Admin later contacts the
 * person, fills rates + admin commission + KYC, then activates.
 */

/**
 * Public: does an astrologer account exist for this phone, and what's its state?
 * Drives the astrologer app's login gate.
 *
 * Returns:
 *   exists           → an ASTROLOGER profile exists for this number.
 *   status / active  → that profile's applicationStatus (active = can sign in).
 *   takenByOtherRole → the number belongs to a non-astrologer account (a plain
 *                      user or an admin). Platform numbers are unique, so the
 *                      app must NOT offer astrologer registration in this case.
 *   role             → that other role ('user' | 'admin' | 'super_admin'), for
 *                      a precise message. Omitted when the number is free.
 * No account leak beyond existence + role + stage.
 */
async function checkExists(rawPhone) {
  const phone = require('../utils/phone').normalizePhone(rawPhone);
  if (!phone) throw new AppError('Enter a valid 10-digit phone number', 400);
  const user = await User.findOne({ phone }).select('role').lean();
  if (!user) return { exists: false, status: null, active: false, takenByOtherRole: false };
  const profile = await AstrologerProfile.findOne({ user: user._id }).select('applicationStatus').lean();
  if (!profile) {
    // Number is in use, but not as an astrologer → registration is blocked.
    return { exists: false, status: null, active: false, takenByOtherRole: true, role: user.role };
  }
  return {
    exists: true,
    status: profile.applicationStatus,
    active: profile.applicationStatus === 'active',
    takenByOtherRole: false,
  };
}

/** Public: submit an astrologer application (lead). No login required. */
async function submitApplication({ name, phone, email, expertise, languages, experienceYears, note, fcmToken }) {
  // Normalize to the canonical stored format (91 + 10 digits) so the same
  // person is found by OTP login (verifyOtp) and the exists-check later.
  phone = require('../utils/phone').normalizePhone(phone);
  if (!phone) throw new AppError('Enter a valid 10-digit phone number', 400);
  // Platform-wide uniqueness: a number already in use (any role/state, incl. a
  // regular user or a rejected applicant) can't be re-registered.
  await User.assertPhoneAvailable(phone);
  const user = await User.create({ name, phone, email });

  // Store the device push token so the "you're approved" notification reaches
  // this device when an admin activates the profile (best-effort).
  if (fcmToken) {
    try { await require('./authService').registerFcmToken(user._id, fcmToken, 'android'); }
    catch (e) { require('../utils/logger').debug('apply fcm store failed', e.message); }
  }

  let profile = await AstrologerProfile.create({
    user: user._id,
    displayName: name,
    expertise: dedupeTags(expertise || []),
    languages: dedupeTags(languages || []),
    experienceYears: experienceYears || 0,
    applicationStatus: 'applied',
    adminNote: note,
    // New profile, no live socket → start offline (explicit, not just default).
    availabilityPreference: false,
    isOnline: false,
    currentCallStatus: 'offline',
  });
  await User.updateOne({ _id: user._id }, { $set: { astrologerProfile: profile._id } });
  await ensureExpertise(expertise); // grow the shared catalog with any new values

  // Live admin-console badge + bell (new astrologer registration to review).
  // Routes to the Applications page in the admin.
  require('../websockets/emit').adminActivity('astrologer_registration', {
    id: profile._id,
    title: `New astrologer registration: ${name || phone}`,
  });

  return { applicationId: profile._id, status: 'applied' };
}

/** Normalize a {enabled, rateRupeesPerMin, adminCutRupeesPerMin} input to whole-rupee rates. */
function buildRates(input) {
  const out = {};
  for (const svc of ['call', 'chat', 'video']) {
    if (input[svc]) {
      const r = input[svc];
      const ratePerMin = r.rateRupeesPerMin != null ? toRupees(r.rateRupeesPerMin) : undefined;
      const adminCutPerMin = r.adminCutRupeesPerMin != null ? toRupees(r.adminCutRupeesPerMin) : undefined;
      if (ratePerMin != null && adminCutPerMin != null && adminCutPerMin > ratePerMin) {
        throw new AppError(`${svc}: admin cut cannot exceed the rate`, 400);
      }
      out[svc] = {};
      if (r.enabled != null) out[svc].enabled = r.enabled;
      if (ratePerMin != null) out[svc].ratePerMin = ratePerMin;
      if (adminCutPerMin != null) out[svc].adminCutPerMin = adminCutPerMin;
    }
  }
  return out;
}

/** Admin: update/activate an astrologer profile (rates, commission, KYC, status). */
async function adminUpdate(profileId, body, adminId) {
  const profile = await AstrologerProfile.findById(profileId);
  if (!profile) throw new AppError('Astrologer profile not found', 404);

  // User-level fields (name/email/phone) live on the User, not the profile —
  // pull them out so they aren't spread onto the profile document.
  const { rates, applicationStatus, name, email, phone: _rawPhone, code, ...rest } = body;
  const bioChanged = rest.bio !== undefined && rest.bio !== profile.bio;
  // Dedupe tag lists case-insensitively before they're spread onto the profile.
  if (rest.languages !== undefined) rest.languages = dedupeTags(rest.languages);
  if (rest.expertise !== undefined) rest.expertise = dedupeTags(rest.expertise);

  Object.assign(profile, rest);

  // Phone change → OTP-verify the new number, enforce platform uniqueness, then
  // update the owning User (the phone is the astrologer's OTP login).
  if (_rawPhone) {
    const newPhone = require('../utils/phone').normalizePhone(_rawPhone);
    if (!newPhone) throw new AppError('Enter a valid 10-digit phone number', 400);
    const owner = await User.findById(profile.user).select('phone');
    if (!owner) throw new AppError('Astrologer user not found', 404);
    if (newPhone !== owner.phone) {
      if (!code) throw new AppError('Phone verification code is required', 400);
      await require('./otpService').verifyOtp(newPhone, code);
      await User.assertPhoneAvailable(newPhone);
      owner.phone = newPhone;
      owner.isPhoneVerified = true;
      await owner.save();
    }
  }
  // Name / email also live on the User.
  if (name !== undefined || email !== undefined) {
    const set = {};
    if (name !== undefined) set.name = name;
    if (email !== undefined) set.email = email;
    if (Object.keys(set).length) await User.updateOne({ _id: profile.user }, { $set: set });
  }

  if (rates) {
    const built = buildRates(rates);
    for (const svc of Object.keys(built)) {
      profile.rates[svc] = { ...profile.rates[svc].toObject?.() || profile.rates[svc], ...built[svc] };
    }
  }

  if (applicationStatus) {
    profile.applicationStatus = applicationStatus;
    if (applicationStatus === 'active') {
      profile.activatedAt = new Date();
      profile.activatedBy = adminId;
      // Promote the user to astrologer role on activation.
      await User.updateOne({ _id: profile.user }, { $set: { role: 'astrologer' } });
      await notificationService.notify(profile.user, {
        type: 'system',
        title: 'You are live!',
        body: 'Your astrologer profile has been approved. Go online to start receiving consultations.',
      });
    }
  }

  await profile.save();
  await ensureExpertise(rest.expertise); // catalog grows with admin-typed values
  // Re-translate bio if it changed.
  if (bioChanged) await translateBio(profile);
  await invalidateAstroCache();
  return profile;
}

/** Admin creates an astrologer directly (manual onboarding). */
async function adminCreate(body, adminId) {
  const { name, email, rates, code, phone: _rawPhone, ...rest } = body;
  // Dedupe tag lists case-insensitively (no "bengali" + "Bengali").
  if (rest.languages !== undefined) rest.languages = dedupeTags(rest.languages);
  if (rest.expertise !== undefined) rest.expertise = dedupeTags(rest.expertise);
  const phone = require('../utils/phone').normalizePhone(_rawPhone);
  if (!phone) throw new AppError('Enter a valid 10-digit phone number', 400);
  // Address + pincode are required at creation (used for nearby-astrologer search).
  if (!rest.location || !rest.location.address || !rest.location.pincode) {
    throw new AppError('Address and pincode are required', 400);
  }
  // The phone is the astrologer's OTP login — verify it before claiming it.
  if (!code) throw new AppError('Phone verification code is required', 400);
  await require('./otpService').verifyOtp(phone, code);
  // Platform-wide uniqueness: the number must not already belong to any account.
  await User.assertPhoneAvailable(phone);
  const user = await User.create({ name, phone, email, role: 'astrologer', isPhoneVerified: true });

  let profile = await AstrologerProfile.create({
    user: user._id,
    displayName: name,
    applicationStatus: 'active',
    kycStatus: rest.kycStatus || 'approved',
    activatedAt: new Date(),
    activatedBy: adminId,
    ...rest,
    rates: rates ? buildRates(rates) : undefined,
    // A brand-new profile has no live socket — it MUST start offline. Pin the
    // presence baseline AFTER ...rest so no admin payload can seed it online.
    availabilityPreference: false,
    isOnline: false,
    currentCallStatus: 'offline',
  });
  await User.updateOne({ _id: user._id }, { $set: { astrologerProfile: profile._id } });
  await ensureExpertise(rest.expertise); // catalog grows with admin-typed values
  // Auto-translate the bio into all languages (insert-time, GCP).
  await translateBio(profile);
  await invalidateAstroCache();
  // System template: welcome notification for the new astrologer (if enabled).
  require('./broadcastService').fireEvent('astrologer_signup', { userId: user._id, vars: { name: name || 'there' } });
  return profile;
}

/** Translate a profile's bio into all supported languages and persist bioI18n. */
async function translateBio(profile) {
  if (!profile.bio) return;
  try {
    const translateService = require('./translateService');
    const map = await translateService.localize(profile.bio); // {en,hi,bn,mr,pa,as}
    delete map.en; // en lives in `bio`
    profile.bioI18n = map;
    await profile.save();
  } catch (e) {
    require('../utils/logger').warn('translateBio failed', e.message);
  }
}

/** Admin removes (deactivates) an astrologer. */
async function adminDelete(profileId, adminId) {
  const profile = await AstrologerProfile.findById(profileId);
  if (!profile) throw new AppError('Astrologer not found', 404);
  profile.applicationStatus = 'suspended';
  profile.isOnline = false;
  profile.currentCallStatus = 'offline';
  await profile.save();
  await User.updateOne({ _id: profile.user }, { $set: { role: 'user' } });
  await invalidateAstroCache();
  await broadcastStatus(profile._id, { isOnline: false, currentCallStatus: 'offline' });
}

/**
 * Admin permanently deletes a NON-ACTIVE application (a lead). Removes the
 * AstrologerProfile and, if the owning User is just a placeholder shell created
 * for this application (role 'user', not phone-verified, no wallet activity),
 * removes that too — freeing the phone number for reuse. Refuses to delete an
 * active astrologer (suspend that via adminDelete instead).
 */
async function adminDeleteApplication(profileId) {
  const profile = await AstrologerProfile.findById(profileId);
  if (!profile) throw new AppError('Application not found', 404);
  if (profile.applicationStatus === 'active') {
    throw new AppError('Cannot delete an active astrologer. Suspend them instead.', 400);
  }
  const userId = profile.user;
  await AstrologerProfile.deleteOne({ _id: profile._id });

  // Clean up the placeholder User only if it never became a real user account.
  const user = await User.findById(userId).select('role isPhoneVerified walletBalance');
  if (user && user.role === 'user' && !user.isPhoneVerified && !(user.walletBalance > 0)) {
    await User.deleteOne({ _id: userId });
  } else if (user) {
    // Keep the user (they're a real account); just unlink the profile.
    await User.updateOne({ _id: userId }, { $unset: { astrologerProfile: '' } });
  }
  await invalidateAstroCache();
}

// Fields hidden from public reads (heavy/private sub-docs).
const PUBLIC_EXCLUDE = '-reviews -recentMisses -kycDocuments -payoutDetails -adminNote';

/** Public list of active, available astrologers (optionally filtered). */
async function listPublic({ q: search, expertise, language, online, featured, maxPrice, city, random, page = 1, limit = 20 } = {}) {
  const term = (search || '').trim();
  // "Nearby" = same city. We match the leading city token (the device's
  // reverse-geocoded label can be "Bengaluru, Karnataka" while the stored
  // city is just "Bengaluru"), case-insensitively.
  const cityTerm = (city || '').split(',')[0].trim();
  const isRandom = random === 'true';

  // Build the shared match filter.
  const cap = Number(maxPrice);
  const buildMatch = () => {
    const q = { applicationStatus: 'active' };
    if (expertise) q.expertise = expertise;
    if (language) q.languages = language;
    if (online === 'true') q.isOnline = true;
    if (featured === 'true') q.isFeatured = true;
    if (cityTerm) q['location.city'] = { $regex: `^${escapeRegex(cityTerm)}$`, $options: 'i' };
    if (term) q.displayName = { $regex: term, $options: 'i' }; // name search
    // Price cap: keep astrologers with at least one ENABLED rate ≤ maxPrice
    // (affordable on any channel).
    if (Number.isFinite(cap) && cap > 0) {
      q.$or = ['call', 'chat', 'video'].map((svc) => ({
        [`rates.${svc}.enabled`]: true,
        [`rates.${svc}.ratePerMin`]: { $lte: cap },
      }));
    }
    return q;
  };

  // Random sample (e.g. the home "Call & Chat" rail): $sample picks `limit`
  // docs uniformly at random from the filtered set. Always live (never cached
  // and not paginated) so the rail varies on each visit.
  const runRandom = async () => {
    const match = buildMatch();
    const rows = await AstrologerProfile.aggregate([
      { $match: match },
      { $sample: { size: limit } },
      { $project: { reviews: 0, recentMisses: 0, kycDocuments: 0, payoutDetails: 0, adminNote: 0 } },
    ]);
    // Populate the `user.name` the same way the find() path does.
    const items = await AstrologerProfile.populate(rows, { path: 'user', select: 'name' });
    return { items, total: items.length, page: 1, limit };
  };

  const run = async () => {
    const q = buildMatch();
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      AstrologerProfile.find(q)
        .select(PUBLIC_EXCLUDE)
        .sort({ isOnline: -1, rating: -1 })
        .skip(skip)
        .limit(limit)
        .populate('user', 'name')
        .lean(),
      AstrologerProfile.countDocuments(q),
    ]);
    return { items, total, page, limit };
  };

  // Random + search variants are high-cardinality / must vary → always live.
  if (isRandom) return runRandom();
  if (term) return run();
  const cacheKey = `list:${expertise || '-'}:${language || '-'}:${online || '-'}:${featured || '-'}:${cityTerm.toLowerCase() || '-'}:${page}:${limit}`;
  return cacheService.withCache(CACHE_NS, cacheKey, LIST_TTL, run);
}

async function getPublic(profileId) {
  const cached = await cacheService.withCache(CACHE_NS, `profile:${profileId}`, PROFILE_TTL, async () => {
    const profile = await AstrologerProfile.findById(profileId)
      .select('-recentMisses -kycDocuments -payoutDetails -adminNote')
      .populate('user', 'name')
      .lean();
    // Return null (not throw) so a 404 isn't cached as an error object.
    if (!profile || profile.applicationStatus !== 'active') return null;
    return profile;
  });
  if (!cached) throw new AppError('Astrologer not found', 404);
  // Live broadcast state is checked FRESH (not cached) — a profile cached as
  // 'busy' otherwise wouldn't tell the detail screen this is a LIVE session it
  // can join. Attach live + liveSessionId so the app shows "Live · tap to join".
  try {
    const LiveSession = require('../models/LiveSession');
    const ls = await LiveSession.findOne({ astrologerProfile: profileId, status: 'live' }).select('_id').lean();
    if (ls) return { ...cached, live: true, liveSessionId: String(ls._id) };
  } catch (_) { /* best-effort — fall through to the plain profile */ }
  return cached;
}

/**
 * Astrologer self-service: edit own profile (editable subset only). Rates,
 * commission, KYC and display name remain admin-controlled. `language` is the
 * UI language and is saved on the User (mirrors the device choice). Re-translates
 * the bio if it changed. Returns the fresh profile.
 */
async function updateMyProfile(userId, body) {
  const profile = await AstrologerProfile.findOne({ user: userId });
  if (!profile) throw new AppError('Astrologer profile not found', 404);

  const { language, profileCompleted, ...editable } = body;
  // Dedupe tag lists case-insensitively before persisting (no "bengali" + "Bengali").
  if (editable.languages !== undefined) editable.languages = dedupeTags(editable.languages);
  if (editable.expertise !== undefined) editable.expertise = dedupeTags(editable.expertise);
  const allowed = ['bio', 'avatar', 'coverPhoto', 'expertise', 'languages', 'experienceYears'];
  const bioChanged = editable.bio !== undefined && editable.bio !== profile.bio;
  for (const k of allowed) {
    if (editable[k] !== undefined) profile[k] = editable[k];
  }
  await profile.save();
  if (editable.expertise !== undefined) await ensureExpertise(editable.expertise);
  if (bioChanged) await translateBio(profile);

  // UI language + onboarding-done flag live on the User.
  const userSet = {};
  if (language) userSet.language = language;
  if (profileCompleted !== undefined) userSet.profileCompleted = profileCompleted;
  if (Object.keys(userSet).length) await User.updateOne({ _id: userId }, { $set: userSet });

  await invalidateAstroCache();
  return profile;
}

/**
 * Astrologer dashboard stats: per-service consultation tallies (sessions /
 * minutes / earnings for chat/call/video) from completed sessions, plus
 * this-month earnings. Balance comes from the wallet endpoint separately.
 */
async function myStats(userId) {
  const Session = require('../models/Session');
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  // Per-service totals over all completed sessions for this astrologer.
  const byService = await Session.aggregate([
    { $match: { astrologer: userId, status: 'completed' } },
    {
      $group: {
        _id: '$type',
        sessions: { $sum: 1 },
        minutes: { $sum: '$billedMinutes' },
        earnings: { $sum: '$astrologerEarning' },
      },
    },
  ]);

  const empty = { sessions: 0, minutes: 0, earnings: 0 };
  const stats = { chat: { ...empty }, call: { ...empty }, video: { ...empty } };
  for (const row of byService) {
    if (stats[row._id]) {
      stats[row._id] = { sessions: row.sessions, minutes: row.minutes, earnings: row.earnings };
    }
  }

  // This-month earnings (completed sessions ended this month).
  const monthAgg = await Session.aggregate([
    { $match: { astrologer: userId, status: 'completed', endedAt: { $gte: monthStart } } },
    { $group: { _id: null, earnings: { $sum: '$astrologerEarning' } } },
  ]);
  const thisMonthEarnings = monthAgg.length ? monthAgg[0].earnings : 0;

  return { stats, thisMonthEarnings };
}

/**
 * Astrologer self-service: toggle online (HTTP path; mirrors the `set-online`
 * socket event). Persists their availability INTENT and lets presenceService
 * derive the public truth (intent AND a live socket) + emit the one canonical
 * `astrologer-status` broadcast — keeping HTTP and socket paths identical.
 */
async function setOnline(userId, online) {
  const profile = await AstrologerProfile.findOne({ user: userId });
  if (!profile) throw new AppError('Astrologer profile not found', 404);
  if (profile.applicationStatus !== 'active') throw new AppError('Profile not yet activated', 403);
  // Block going offline mid-consultation — the seeker is connected and being
  // billed; the astrologer must end the session first. (Going online is always
  // allowed.)
  if (!online) {
    const Session = require('../models/Session');
    const inSession = await Session.exists({ astrologer: userId, status: { $in: ['accepted', 'ongoing'] } });
    if (inSession) throw new AppError('You are in a consultation. End it before going offline.', 409);
  }
  // Going online: the authenticated app making THIS call is itself a live client,
  // so assert connected:true rather than racing a Presence-store lookup (debug
  // sockets reconnect constantly; a momentary socketCount=0 must not flip them
  // back to offline and clobber the socket path's correct result). Going offline:
  // intent forces offline regardless, so leave the connection signal to derive.
  const result = await require('./presenceService').recomputeAstrologerPresence(
    userId,
    online ? { preference: true, connected: true } : { preference: false }
  );
  return { isOnline: result.isOnline, currentCallStatus: result.currentCallStatus };
}

/** Admin: list applications by status. */
async function adminList({ status, page = 1, limit = 20 } = {}) {
  const q = status ? { applicationStatus: status } : {};
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    AstrologerProfile.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('user', 'name phone email isBlocked'),
    AstrologerProfile.countDocuments(q),
  ]);
  return { items, total, page, limit };
}

module.exports = { checkExists, submitApplication, adminUpdate, adminCreate, adminDelete, adminDeleteApplication, updateMyProfile, myStats, listExpertise, ensureExpertise, listPublic, getPublic, setOnline, adminList, buildRates, broadcastStatus, broadcastStatusByUser };
