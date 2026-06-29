const mongoose = require('mongoose');

/**
 * AI-generated recap of a finished 1:1 CHAT consultation (Feature 1).
 *
 * Produced by the `chat_recap` background job after a chat session ends, BEFORE
 * the 7-day ChatMessage TTL wipes the transcript (see ChatMessage TTL index).
 * The astrologer reviews/edits it and approves; on approval the user sees the
 * summary + approved product suggestions in their chat history.
 *
 * Lifecycle:
 *   pending  → generated, awaiting astrologer review
 *   approved → astrologer accepted (intermediate; we move straight to 'sent')
 *   rejected → astrologer discarded it (never shown to the user)
 *   sent     → published to the user (visible in their chat history)
 */

const suggestionSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    title: { type: String, required: true },
    reason: { type: String },                       // why the AI tied it to this chat
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  },
  { _id: true }
);

// AI-extracted reminders the astrologer set in the chat (review/edit/confirm,
// then scheduled on approval — see reminderService). 'mantra' = recurring daily
// (notify 5 min before timeOfDay, fixed 14-day course); 'event' = one-off on date.
const reminderSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['mantra', 'event'], required: true },
    title: { type: String, required: true },
    reason: { type: String },
    timeOfDay: { type: String },   // "HH:MM" for a recurring mantra
    date: { type: String },        // "YYYY-MM-DD" for a one-off event
    notifyText: { type: String },  // push text in the seeker's chatting language
    keep: { type: Boolean, default: true }, // astrologer toggle to drop one
  },
  { _id: true }
);

const sessionRecapSchema = new mongoose.Schema(
  {
    // One recap per session. `session` is the Session _id; `sessionId` is the
    // string UUID, kept for cheap lookups alongside ChatMessage.sessionId.
    session: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true, unique: true, index: true },
    sessionId: { type: String, required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    astrologer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // When the CONSULTATION ended — binds the recap to that chat's timeline so the
    // app/admin can show "recap of your chat at <time>" rather than the row's
    // createdAt (which lags behind the async generation).
    sessionEndedAt: { type: Date, index: true },

    // ── AI output ──
    summary: { type: String },
    language: { type: String }, // detected seeker language: en|bn|bn-rom|hi|hi-rom
    keyTopics: [{ type: String }],
    sentiment: { type: String },
    suggestions: [suggestionSchema],
    reminders: [reminderSchema], // AI-extracted, astrologer-confirmed, then scheduled

    status: { type: String, enum: ['pending', 'approved', 'rejected', 'sent'], default: 'pending', index: true },
    approvedAt: { type: Date },
    sentToUserAt: { type: Date },
    // True when the recap came from the deterministic fallback (LLM unavailable),
    // so the UI / analytics can distinguish a real summary from a stub.
    generatedByMock: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Astrologer's review queue: their pending recaps, newest first.
sessionRecapSchema.index({ astrologer: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('SessionRecap', sessionRecapSchema);
