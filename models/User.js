const mongoose = require('mongoose');

// One row per logged-in device. A user may be signed in on several devices at
// once, so this is an array — each entry pairs the device's push token with a
// stable hardware id and human-readable name/model so the admin console can
// show *which* phones an account is using. Deduped by `deviceId` on register
// (token rotates, the device stays the same), falling back to `token`.
const fcmTokenSchema = new mongoose.Schema(
  {
    token: { type: String, required: true },
    platform: { type: String, enum: ['ios', 'android', 'web'], default: 'android' },
    // Stable per-install device identifier (Android ID / iOS identifierForVendor
    // / web fingerprint). Used to dedup tokens for the same physical device.
    deviceId: { type: String },
    deviceName: { type: String }, // user-facing label, e.g. "Subho's iPhone", "Pixel 7"
    deviceModel: { type: String }, // e.g. "iPhone15,3", "SM-G991B"
    osVersion: { type: String }, // e.g. "Android 14", "iOS 17.5"
    appVersion: { type: String }, // e.g. "1.0.0 (42)"
    addedAt: { type: Date, default: Date.now },
    lastUsedAt: { type: Date, default: Date.now }, // refreshed on every re-register
  },
  { _id: false }
);

// E-commerce style address book: multiple addresses, typed, one default.
const addressSchema = new mongoose.Schema(
  {
    label: { type: String, enum: ['home', 'work', 'other'], default: 'home' },
    name: { type: String },
    phone: { type: String },
    line1: { type: String, required: true },
    line2: { type: String },
    city: { type: String, required: true },
    state: { type: String, required: true },
    pincode: { type: String, required: true },
    isDefault: { type: Boolean, default: false },
  },
  { _id: true, timestamps: true }
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, maxlength: 100 },
    phone: { type: String, required: true, unique: true, trim: true, index: true },
    email: { type: String, lowercase: true, trim: true, sparse: true },
    role: { type: String, enum: ['user', 'astrologer', 'admin', 'super_admin'], default: 'user', index: true },

    gender: { type: String, enum: ['male', 'female', 'other'], default: undefined },
    // Preferred app language (ISO code) — mirrors the device choice, synced to DB
    // so it follows the account across devices. en|hi|bn|mr|pa|as.
    language: { type: String, default: 'en' },

    birthDetails: {
      dob: { type: Date },
      time: { type: String }, // "HH:mm"
      timeKnown: { type: Boolean, default: true }, // false => user doesn't know their time of birth
      place: { type: String },
      lat: { type: Number },
      lng: { type: Number },
      tz: { type: Number, default: 5.5 },
    },

    avatar: { type: String }, // profile photo URL
    // Approximate device location (for "nearby astrologers"). Captured with
    // consent after OTP; coarse lat/lng + reverse-geocoded city.
    location: {
      lat: { type: Number },
      lng: { type: Number },
      city: { type: String },
      updatedAt: { type: Date },
    },
    // Last-known device permission grants (saved after the mandatory prompt).
    permissions: {
      notifications: { type: Boolean, default: false },
      microphone: { type: Boolean, default: false },
      camera: { type: Boolean, default: false },
      photos: { type: Boolean, default: false },
      location: { type: Boolean, default: false },
    },
    // Astrology display preferences (Set Preferences screen).
    preferences: {
      chartStyle: { type: String, enum: ['north', 'south'], default: 'north' },
      monthSystem: { type: String, enum: ['amanta', 'purnimanta'], default: 'amanta' },
      themeMode: { type: String, enum: ['light', 'dark', 'system'], default: 'system' },
      language: { type: String, default: 'en' },
      ayanamsa: { type: String, enum: ['lahiri', 'kp_new', 'kp_old', 'raman', 'kp_khullar'], default: 'lahiri' },
    },
    // Notification preferences (Notification Settings screen).
    notificationSettings: {
      frequency: { type: String, enum: ['once_a_day', 'twice_a_day', 'all', 'never'], default: 'once_a_day' },
      topics: [{ type: String }], // e.g. cricket, share_market, bollywood, magazine, follow, festivals, horoscope
    },

    // Set true once the user finishes (or skips) onboarding — drives the
    // "complete your profile" nudge on Home.
    profileCompleted: { type: Boolean, default: false },

    isPhoneVerified: { type: Boolean, default: false },
    isBlocked: { type: Boolean, default: false },

    // New-user free-chat perk: minutes remaining (granted once on signup).
    freeChatMinutes: { type: Number, default: 0 },

    // ── Referral ── auto-generated astro-themed code shared with friends;
    // referredBy = the code's owner (set when this user applies a code).
    referralCode: { type: String, unique: true, sparse: true, index: true },
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    referralRewarded: { type: Boolean, default: false }, // both parties credited on first recharge
    referralCount: { type: Number, default: 0 }, // friends who recharged via my code

    addresses: [addressSchema],

    fcmTokens: [fcmTokenSchema],

    astrologerProfile: { type: mongoose.Schema.Types.ObjectId, ref: 'AstrologerProfile' },
  },
  { timestamps: true }
);

userSchema.index({ 'fcmTokens.token': 1 });

userSchema.methods.toSafeJSON = function () {
  const o = this.toObject();
  delete o.__v;
  return o;
};

/**
 * Platform-wide phone uniqueness guard. A number belongs permanently to its
 * first identity — once it exists in ANY role (user/astrologer/admin) it can't
 * be reused for a different one. Call before claiming a phone for a new
 * astrologer or admin. Throws a 409 with a role-aware message if taken.
 * `phone` must already be normalized (91 + 10 digits).
 */
userSchema.statics.assertPhoneAvailable = async function (phone) {
  const existing = await this.findOne({ phone }).select('role astrologerProfile').lean();
  if (!existing) return;
  // An astrologer applicant keeps role 'user' until activation, so check for a
  // profile too — otherwise the message would mislabel an application as a user.
  let where = {
    user: 'a user',
    astrologer: 'an astrologer',
    admin: 'an admin',
    super_admin: 'an admin',
  }[existing.role] || 'another account';
  if (existing.role === 'user' && existing.astrologerProfile) where = 'an astrologer application';
  const AppError = require('../utils/AppError');
  throw new AppError(`This phone number is already registered as ${where} on the platform`, 409);
};

module.exports = mongoose.model('User', userSchema);
