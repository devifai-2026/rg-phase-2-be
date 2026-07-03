const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * Anonymous landing-page visit — funnel attribution. Flow:
 *   Landing page POSTs a visit (with UTM params + device/OS) →
 *   when that anonId later signs up (or applies as astrologer), the visit is
 *   stitched to a user via convertedUserId + conversionType.
 */
const visitSchema = new mongoose.Schema(
  {
    anonId: { type: String, required: true, index: true }, // same id as Click.anonId

    // Ad attribution from URL query params
    utmSource: { type: String, default: '' },
    utmMedium: { type: String, default: '' },
    utmCampaign: { type: String, default: '' },
    utmContent: { type: String, default: '' },
    utmTerm: { type: String, default: '' },

    // Context
    landingPath: { type: String, default: '/' },
    referrer: { type: String, default: '' },
    durationSec: { type: Number, default: 0 }, // time-on-page (sent on leave)
    userAgent: { type: String, default: '' },
    device: { type: String, default: '' }, // 'mobile' | 'tablet' | 'desktop'
    os: { type: String, default: '' },
    ip: { type: String, default: '' },

    // Geo, resolved asynchronously from IP (best-effort, non-blocking).
    city: { type: String, default: '' },
    region: { type: String, default: '' },
    country: { type: String, default: '' },
    lat: { type: Number, default: null },
    lon: { type: Number, default: null },
    isp: { type: String, default: '' },

    // Conversion stitching (set when this visitor later converts)
    convertedUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    convertedAt: { type: Date, default: null },
    conversionType: { type: String, default: '' }, // 'signup' | 'astrologer_apply' | 'enquiry'
  },
  { timestamps: true }
);

visitSchema.index({ utmCampaign: 1, createdAt: -1 });
visitSchema.index({ createdAt: -1 });

module.exports = defineModel('Visit', visitSchema);