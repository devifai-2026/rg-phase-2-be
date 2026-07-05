const mongoose = require('mongoose');
const { defineModel } = require('./registry');

const reviewSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    rating: { type: Number, min: 1, max: 5, required: true },
    comment: { type: String, maxlength: 1000 },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

/**
 * Per-service pricing. Rates and the admin cut are BOTH absolute rupees/min
 * (whole rupees). astrologer earns (rate - adminCut) per minute.
 * enabled=false means the astrologer does not offer that service.
 */
const serviceRateSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    ratePerMin: { type: Number, default: 0, min: 0, set: (v) => Math.round(Number(v) || 0) }, // rupees/min user pays
    adminCutPerMin: { type: Number, default: 0, min: 0, set: (v) => Math.round(Number(v) || 0) }, // rupees/min to platform
  },
  { _id: false }
);

const astrologerProfileSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },

    // Public profile
    displayName: { type: String, trim: true },
    // Per-language display name, auto-transliterated by GCP Cloud Translation at
    // create/update. Shape: { hi, bn, mr, pa, as } ('en' is `displayName`). The
    // user app reads the field for its locale, falling back to `displayName`.
    // NOTE: machine transliteration of proper names is approximate; admin can
    // override any entry. Mirrors `bioI18n`.
    nameI18n: { type: Map, of: String, default: undefined },
    bio: { type: String, maxlength: 2000 },
    // Per-language bio, auto-filled by GCP Cloud Translation at create/update.
    // Shape: { hi: '...', bn: '...', mr, pa, as } ('en' is `bio`). App reads the
    // field for the user's locale, falling back to `bio`.
    bioI18n: { type: Map, of: String, default: undefined },
    avatar: { type: String },
    coverPhoto: { type: String }, // wide cover image (FB/LinkedIn-style profile header)
    expertise: [{ type: String }],
    languages: [{ type: String }],
    experienceYears: { type: Number, default: 0 },

    // Followers shown on the profile = followerSeed (admin display floor) +
    // followerCount (real active follows, kept in sync by toggleFollow).
    followerSeed: { type: Number, default: 0 },
    followerCount: { type: Number, default: 0 },

    // Link-in-bio storefront design the astrologer picked (saved from the app).
    // One of a fixed set of templates rendered by the storefront screen. Used as
    // the FALLBACK when no AI-generated layout is active.
    storeTheme: { type: String, enum: ['rudraksh', 'shiva', 'cosmic', 'royal', 'aurora', 'twilight', 'sapphire', 'lotus'], default: 'rudraksh' },

    // The active AI-generated storefront layout (StorefrontLayout). When set, the
    // seeker-facing storefront renders this spec instead of the storeTheme preset.
    // Astrologer + admin can switch it among their (up to 3) generated layouts.
    activeStorefrontLayout: { type: mongoose.Schema.Types.ObjectId, ref: 'StorefrontLayout', default: null },

    // Admin-seeded "gifts received" display (not real transactions). The app shows
    // `giftDisplay.count` as the total gifts; `giftDisplay.items` is an optional
    // breakdown by gift name for the profile's gift strip.
    giftDisplay: {
      count: { type: Number, default: 0 },
      items: [{ name: { type: String }, count: { type: Number, default: 0 } }],
    },

    // Location — used later for "nearby astrologers" discovery in the app.
    location: {
      address: { type: String },
      city: { type: String },
      state: { type: String },
      pincode: { type: String, index: true },
      lat: { type: Number },
      lng: { type: Number },
    },

    // ── Admin-created onboarding state machine ──────────────────────────
    // Astrologer submits only a signup form (lead). Admin contacts manually,
    // fills details + rates + admin cuts, then activates.
    applicationStatus: {
      type: String,
      enum: ['applied', 'contacted', 'details_filled', 'active', 'rejected', 'suspended'],
      default: 'applied',
      index: true,
    },
    appliedAt: { type: Date, default: Date.now },
    activatedAt: { type: Date },
    activatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    adminNote: { type: String },

    // KYC — entirely OPTIONAL. Filled by admin (or astrologer). Never gates
    // onboarding or going live; purely a compliance record.
    kycStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    kyc: {
      aadhaarNumber: { type: String, trim: true },
      panNumber: { type: String, trim: true, uppercase: true },
    },
    kycDocuments: {
      aadhaar: { type: String },      // Aadhaar card image
      pan: { type: String },          // PAN card image
      bankPassbook: { type: String }, // Bank passbook / cheque image
    },

    // ── Per-service rates + absolute admin commission (set by admin) ─────
    rates: {
      call: { type: serviceRateSchema, default: () => ({}) },
      chat: { type: serviceRateSchema, default: () => ({}) },
      video: { type: serviceRateSchema, default: () => ({}) },
    },

    // Payout bank/UPI details (filled by admin/astrologer)
    payoutDetails: {
      upi: { type: String },
      accountNumber: { type: String },
      ifsc: { type: String },
      beneficiaryName: { type: String },
    },

    // ── Live presence / availability ────────────────────────────────────
    // Presence is DERIVED from two inputs, never set ad-hoc:
    //   effective online = availabilityPreference (their saved toggle)
    //                      AND the device is REACHABLE (lastReachableAt is fresh,
    //                      within env.presence.reachableTtlMs — default 5 min).
    // `availabilityPreference` is the astrologer's INTENT — it survives app
    // restarts/reconnects so connecting never silently flips them online.
    // Reachability is refreshed by (a) the live socket heartbeat and (b) a silent
    // FCM `presence_ping` the device ACKs even when the app is killed — so an
    // app-killed-but-internet-ON astrologer STAYS online, while a device with no
    // internet stops refreshing and auto-flips offline after the TTL.
    // `isOnline` / `currentCallStatus` are the computed truth the apps read;
    // always write them via presenceService.recomputeAstrologerPresence().
    availabilityPreference: { type: Boolean, default: false },
    isOnline: { type: Boolean, default: false, index: true },
    currentCallStatus: { type: String, enum: ['available', 'busy', 'offline'], default: 'offline', index: true },
    lastOnlineAt: { type: Date },
    // Last time the device proved it has working connectivity — refreshed by the
    // socket heartbeat AND the FCM presence-ping ACK. Gates derived `isOnline`.
    lastReachableAt: { type: Date },

    // Self-requested short break. While `breakUntil` is in the future the
    // astrologer is shown BUSY to seekers (they can't be reached) without ending
    // their online intent. Cleared automatically once the time passes (presence
    // recompute treats an expired break as no break).
    breakUntil: { type: Date, default: null },

    // Throttle for the "a user is waiting for you" nudge — when a seeker taps
    // "notify me" while this astrologer is busy/offline, we push them a nudge to
    // come online, but at most once per env.notifyMe.astroNudgeThrottleMs so a
    // burst of waiting seekers can't spam them. Timestamp of the last such nudge.
    lastWaitingNudgeAt: { type: Date, default: null },

    // Cooldown for the "your astrologer is online" heads-up sent to FOLLOWERS.
    // An astrologer flapping online/offline must not spam followers — we send at
    // most one follower alert per env.presence.followerAlertCooldownMs (default
    // 5 min). Timestamp of the last follower online-alert we sent.
    lastFollowerOnlineAlertAt: { type: Date, default: null },

    // Curated "featured astrologers" section in the app.
    isFeatured: { type: Boolean, default: false, index: true },
    // Whether this astrologer participates in the new-user free-chat program.
    acceptsFreeChat: { type: Boolean, default: false },

    // ── Reputation ──────────────────────────────────────────────────────
    rating: { type: Number, default: 0 },
    reviewCount: { type: Number, default: 0 },
    reviews: [reviewSchema],

    // ── Lifetime stats ──────────────────────────────────────────────────
    totalSessions: { type: Number, default: 0 },
    totalMinutes: { type: Number, default: 0 },
    totalEarnings: { type: Number, default: 0, set: (v) => Math.round(Number(v) || 0) }, // rupees (astrologer share)

    // ── Miss/reject tracking for escalation ─────────────────────────────
    // We keep recent miss/reject timestamps; escalationService prunes & counts
    // them against a rolling window.
    recentMisses: [{ type: Date }],
    totalMissed: { type: Number, default: 0 },
    totalRejected: { type: Number, default: 0 },
  },
  { timestamps: true }
);

astrologerProfileSchema.index({ isOnline: 1, currentCallStatus: 1 });
astrologerProfileSchema.index({ expertise: 1 });

/** Whether this astrologer can currently receive a request for a service. */
astrologerProfileSchema.methods.canReceive = function (serviceType) {
  const rate = this.rates && this.rates[serviceType];
  return (
    this.applicationStatus === 'active' &&
    this.isOnline &&
    this.currentCallStatus === 'available' &&
    !!rate &&
    rate.enabled &&
    rate.ratePerMin > 0
  );
};

module.exports = defineModel('AstrologerProfile', astrologerProfileSchema);