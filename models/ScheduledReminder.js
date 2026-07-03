const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * A reminder the astrologer set during a chat consultation, extracted by the AI
 * recap and CONFIRMED by the astrologer. Two kinds:
 *
 *   • type 'mantra' — RECURRING: notify the seeker DAILY, 5 minutes before
 *     `timeOfDay`, for a fixed 14-day course (occurrences 0..13). `nextRunAt`
 *     is the next fire time (already offset by -5 min); `firedCount` tracks how
 *     many of the 14 have fired; status flips to 'completed' after the 14th.
 *
 *   • type 'event' — ONE-OFF: a single notification on `date` ("how did X go?"
 *     / "do this puja today"), then 'completed'.
 *
 * Every reminder carries a `reason` (why the astrologer set it) and is fully
 * admin-visible. Created only after the astrologer approves the recap.
 */
const COURSE_DAYS = 14; // fixed mantra course length
const LEAD_MIN = 5;     // notify this many minutes BEFORE the mantra time

const scheduledReminderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    astrologer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    session: { type: mongoose.Schema.Types.ObjectId, ref: 'Session' },
    sessionId: { type: String, index: true },
    recap: { type: mongoose.Schema.Types.ObjectId, ref: 'SessionRecap', index: true },

    type: { type: String, enum: ['mantra', 'event'], required: true },
    title: { type: String, required: true },     // e.g. "Chant Hanuman Chalisa"
    reason: { type: String },                    // why — tied to the chat (admin-visible)
    notifyText: { type: String },                // push text in the seeker's chatting language

    // Recurring (mantra): the daily clock time the seeker should perform it.
    timeOfDay: { type: String },                 // "HH:MM" (24h, server local)
    totalOccurrences: { type: Number, default: COURSE_DAYS },
    firedCount: { type: Number, default: 0 },

    // One-off (event): the date it lands on.
    date: { type: Date },

    // Scheduling cursor — the next time the worker should fire (mantra times are
    // already offset by -5 min). Indexed for the due-scan.
    nextRunAt: { type: Date, index: true },

    status: { type: String, enum: ['active', 'completed', 'cancelled'], default: 'active', index: true },
    lastFiredAt: { type: Date },
  },
  { timestamps: true }
);

scheduledReminderSchema.index({ status: 1, nextRunAt: 1 });

scheduledReminderSchema.statics.COURSE_DAYS = COURSE_DAYS;
scheduledReminderSchema.statics.LEAD_MIN = LEAD_MIN;

module.exports = defineModel('ScheduledReminder', scheduledReminderSchema);