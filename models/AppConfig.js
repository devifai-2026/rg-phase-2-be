const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * Singleton (key:'global') holding app-wide presentation toggles the super-admin
 * controls from "App Configuration". Each flag hides/shows a whole Home section
 * in the Flutter app. The app fetches this once on launch (GET /app-config) and
 * skips any section whose flag is false.
 */
// One brand-token set (dark or light). Values are 8-digit ARGB hex strings
// ('#AARRGGBB') matching Flutter's Color(0x...) so the app maps them 1:1. Any
// missing/blank token falls back to the app's compiled default for that mode.
const tokenSet = () => ({
  ground: { type: String },
  ground2: { type: String },
  card: { type: String },
  red: { type: String },
  redDeep: { type: String },
  redSoft: { type: String },
  ink: { type: String },
  muted: { type: String },
  gold: { type: String },
  line: { type: String },
  // Semantic accents (previously hardcoded across screens).
  violet: { type: String },     // AI astrologer accent
  indigo: { type: String },     // AI gradient partner
  aiSurface: { type: String },  // AI card surface
  aiSurface2: { type: String }, // AI card surface (deeper)
  mint: { type: String },       // "always available" accent
  green: { type: String },      // online / positive
  blue: { type: String },       // video / info
});

const appConfigSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'global', unique: true },

    // Home section visibility toggles.
    sections: {
      banners: { type: Boolean, default: true },     // promo carousel
      videos: { type: Boolean, default: true },      // "Astrology Videos" row
      lessons: { type: Boolean, default: true },     // "Astrology Lessons" row
      pooja: { type: Boolean, default: true },        // "Book a Pooja" banner
      nearby: { type: Boolean, default: true },       // "Nearby Astrologers"
      featured: { type: Boolean, default: true },     // "Featured Astrologers"
    },

    // Brand identity shown IN the apps (MaterialApp title, headers, "About",
    // feedback prompts, legal text). This is what makes each tenant's build show
    // ITS name instead of a hardcoded one — set at provisioning from
    // Tenant.branding.displayName and editable by the tenant admin. The apps read
    // it from GET /app-config and substitute it wherever the brand name appears.
    appName: { type: String, default: '' },

    // Brand logo URL, shown IN the apps + the tenant admin login (with the
    // tenant's initials as the fallback when unset). Set at provisioning from
    // Tenant.branding.logoUrl and editable by the tenant admin.
    logoUrl: { type: String, default: '' },

    // Brand theme tokens, editable from the admin Theme Studio. `enabled` gates
    // whether the app uses these at all; when false (or empty) the app keeps its
    // compiled tokens. Each set is dark/light; unset tokens fall back per-token.
    theme: {
      enabled: { type: Boolean, default: false },
      dark: tokenSet(),
      light: tokenSet(),
    },

    // Splash screen. When `image` is set the app shows a single full-screen image
    // splash (light/dark variants optional); otherwise it uses its built-in
    // animated splash. Text fields override the wordmark/tagline when present.
    splash: {
      image: { type: String },       // full-screen splash image (used for both modes if variants blank)
      imageDark: { type: String },   // optional dark-mode variant
      imageLight: { type: String },  // optional light-mode variant
      backgroundColor: { type: String }, // '#AARRGGBB' behind the image while it loads
      fit: { type: String, enum: ['cover', 'contain'], default: 'cover' },
      durationMs: { type: Number, default: 1900 },
    },
  },
  { timestamps: true }
);

// Fetch-or-create the singleton.
appConfigSchema.statics.get = async function () {
  let doc = await this.findOne({ key: 'global' });
  if (!doc) doc = await this.create({ key: 'global' });
  return doc;
};

module.exports = defineModel('AppConfig', appConfigSchema);