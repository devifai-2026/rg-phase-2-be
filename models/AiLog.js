const mongoose = require('mongoose');

/**
 * One LLM call, logged for admin oversight + debugging + rate-limiting.
 *
 * Captures the REAL inputs (the resolved system prompt with no placeholders, the
 * full user message that carried the actual data) and the output, plus token
 * usage and which astrologer/session it was for. Powers the admin "LLM Logs" tab
 * and the per-astrologer Profile-Optimizer monthly quota.
 *
 * TTL: 30 days (these can be large; we don't keep them forever).
 */
const aiLogSchema = new mongoose.Schema(
  {
    feature: { type: String, index: true },        // 'profileOptimizer' | 'chatRecap' | 'liveModeration' | ...
    model: { type: String },                        // e.g. gemini-2.5-flash
    astrologer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    sessionId: { type: String, index: true },

    system: { type: String },                       // resolved SYSTEM prompt (real)
    input: { type: String },                        // the user message (real data)
    output: { type: String },                       // raw model output

    promptTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },

    ok: { type: Boolean, default: true },
    error: { type: String },
    latencyMs: { type: Number },
  },
  { timestamps: true }
);

aiLogSchema.index({ feature: 1, astrologer: 1, createdAt: -1 });
// Auto-expire after 30 days.
aiLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('AiLog', aiLogSchema);
