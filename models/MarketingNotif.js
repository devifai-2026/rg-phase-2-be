const mongoose = require('mongoose');

/**
 * One AI-generated marketing/engagement push line (Zomato-style nudge).
 *
 * Lifecycle:
 *   pending  → freshly generated, awaiting admin review
 *   active   → admin SAVED it; it's in the rotation, sent on cycles
 *   rejected → admin discarded it (kept briefly for the "fed to next gen" memory,
 *              then ignored; not sent)
 *
 * `audience` decides who it targets ('users' = seekers, 'astrologers' = astros) —
 * the two have different intents. `lang` is the language the copy is written in.
 */
const marketingNotifSchema = new mongoose.Schema(
  {
    audience: { type: String, enum: ['users', 'astrologers'], required: true, index: true },
    lang: { type: String, default: 'en' },           // en | bn | bn-rom | hi | hi-rom
    title: { type: String, required: true },
    body: { type: String, required: true },

    status: { type: String, enum: ['pending', 'active', 'rejected'], default: 'pending', index: true },
    batch: { type: String, index: true },             // generation batch id (groups a review set)
    sentCount: { type: Number, default: 0 },          // how many cycles it's been used
    lastSentAt: { type: Date },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

marketingNotifSchema.index({ status: 1, audience: 1 });

module.exports = mongoose.model('MarketingNotif', marketingNotifSchema);
