const mongoose = require('mongoose');

/**
 * A client-reported "I had to fall back to the sslip.io host" beacon — fired
 * ONCE per app session when the primary domain (api.devifai.in) failed to
 * resolve/connect and the app self-healed onto the deterministic fallback host.
 *
 * Control-plane (cross-tenant) so the PO console can graph how many real users
 * across all tenants + both apps hit the network/DNS issue, with timestamps.
 */
const netFallbackEventSchema = new mongoose.Schema(
  {
    tenantSlug: { type: String, default: '', index: true }, // '' = single-tenant/dev build
    app: { type: String, enum: ['user', 'astrologer', 'unknown'], default: 'unknown', index: true },
    primaryHost: { type: String, default: '' }, // the host that failed to resolve
    at: { type: Date, default: Date.now, index: true }, // event timestamp
    ip: { type: String, default: '' }, // best-effort, for rough distinct-client counting
  },
  { timestamps: false }
);

// Common query: recent events by time, filterable by tenant/app.
netFallbackEventSchema.index({ at: -1, tenantSlug: 1, app: 1 });

module.exports = netFallbackEventSchema;
