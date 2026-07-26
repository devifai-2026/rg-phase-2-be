const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * A seeker's computed birth chart, cached ONCE per user.
 *
 * VedicAstroAPI is a paid, rate-limited, ~15s-timeout provider, and a birth chart
 * is immutable for a given set of birth details — so calling it per AI message
 * would be slow, expensive and pointless. This holds the normalised facts the
 * prompts consume plus the rendered D1 SVG, so a reading is one Mongo read.
 *
 * `AstroCache` already caches provider responses for 365 days keyed by request
 * params, but that is the wrong grain for this: it is keyed by params (so nothing
 * can find "this user's chart"), it stores the raw provider envelope rather than
 * the fact block, and it expires. This is a per-user projection that does not.
 *
 * INVALIDATION is by `birthHash`, not by hooking the profile-update path: on read
 * we recompute the hash of the user's current birth details and refetch on
 * mismatch. A user who corrects their birth time gets a fresh chart on their next
 * question, with no coupling to whichever endpoint edited the profile.
 */
const userChartSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },

    // The birth inputs this chart was computed FROM (not necessarily what is on
    // the User doc right now — compare via birthHash).
    dob: { type: String },   // YYYY-MM-DD
    tob: { type: String },   // HH:mm
    timeKnown: { type: Boolean, default: true },
    lat: { type: Number },
    lng: { type: Number },
    tz: { type: Number, default: 5.5 },

    /**
     * Normalised facts for the prompt — the ONLY thing the LLM is allowed to cite.
     * Kept Mixed because the provider's planet list shape varies across its
     * response formats; `userChartService` is responsible for flattening it.
     *   { moonSign, ascendant, sunSign?, nakshatra?, planets: [{name, sign, house, retro}], manglik? }
     */
    facts: { type: mongoose.Schema.Types.Mixed, default: null },

    /** Rendered D1 (Lagna) chart, north style — shown on the reading screen. */
    svg: { type: String },

    /**
     * hashObject() of the birth inputs. The invalidation key: a mismatch on read
     * means the user edited their birth details, so the chart is stale.
     */
    birthHash: { type: String, index: true },

    fetchedAt: { type: Date, default: Date.now },
    /** True when the provider failed and `facts` is a best-effort/empty block, so
     *  a later read can retry instead of caching a failure forever. */
    partial: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = defineModel('UserChart', userChartSchema);
