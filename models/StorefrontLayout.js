const mongoose = require('mongoose');

/**
 * An AI-generated storefront DESIGN SPEC for one astrologer ("Let the Stars
 * design your storefront"). Limited to 3 lifetime generations per astrologer.
 * All generations are kept so the astrologer (and admin) can switch the active
 * one; AstrologerProfile.activeStorefrontLayout points at the live one.
 *
 * `spec` is the validated JSON theme (mobile-only, astrology-scoped) the user
 * app renders with prebuilt widgets — never executed code. The motif is an
 * inline, sanitised SVG string drawn via flutter_svg.
 */
const storefrontLayoutSchema = new mongoose.Schema(
  {
    astrologer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, default: 'Design' }, // AI-given evocative theme name
    spec: {
      name: String,
      bgGradient: [String], // [topDark, bottomDarker]
      shades: [String], // [surface, surfaceRaised, hairline]
      accent: String,
      accent2: String,
      onAccent: String,
      motifSvg: String, // inline astrology line-art SVG (sanitised; legacy/fallback)
      heroImage: String, // GCS URL of the AI-generated astrology hero banner (preferred)
      cardStyle: { type: String }, // glass | bordered | elevated | minimal
      sectionOrder: [String], // hero, about, products, poojas, reviews
      fonts: { heading: String, body: String },
      rationale: String,
    },
    generatedByMock: { type: Boolean, default: false },
  },
  { timestamps: true }
);

storefrontLayoutSchema.index({ astrologer: 1, createdAt: -1 });

module.exports = mongoose.model('StorefrontLayout', storefrontLayoutSchema);
