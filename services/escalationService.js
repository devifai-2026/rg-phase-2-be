const AstrologerProfile = require('../models/AstrologerProfile');
const Escalation = require('../models/Escalation');
const AdminSettings = require('../models/AdminSettings');
const User = require('../models/User');
const emit = require('../websockets/emit');
const logger = require('../utils/logger');

/**
 * Records a missed/rejected request against an astrologer and raises an
 * Escalation to admins if the count within the rolling window crosses the
 * configured threshold. The astrologer stays online (per business rule).
 */
async function recordMiss({ astrologerUserId, sessionId, kind }) {
  const settings = await AdminSettings.get();
  const windowMs = settings.escalationWindowMinutes * 60 * 1000;
  const now = Date.now();
  const cutoff = new Date(now - windowMs);

  // Push this miss, prune old ones, bump counters atomically-ish.
  const profile = await AstrologerProfile.findOneAndUpdate(
    { user: astrologerUserId },
    {
      $push: { recentMisses: new Date() },
      $inc: kind === 'rejected' ? { totalRejected: 1 } : { totalMissed: 1 },
    },
    { new: true }
  );
  if (!profile) return;

  // Prune misses outside the window.
  const fresh = (profile.recentMisses || []).filter((d) => new Date(d).getTime() >= cutoff.getTime());
  if (fresh.length !== (profile.recentMisses || []).length) {
    await AstrologerProfile.updateOne({ _id: profile._id }, { $set: { recentMisses: fresh } });
  }

  if (fresh.length >= settings.escalationMissThreshold) {
    // Avoid spamming: only one OPEN escalation at a time per astrologer.
    const existingOpen = await Escalation.findOne({ astrologer: astrologerUserId, status: 'open' });
    if (!existingOpen) {
      const esc = await Escalation.create({
        astrologer: astrologerUserId,
        astrologerProfile: profile._id,
        type: kind === 'rejected' ? 'frequent_rejects' : 'frequent_misses',
        reason: `${fresh.length} missed/rejected requests within ${settings.escalationWindowMinutes} min`,
        missCount: fresh.length,
        windowMinutes: settings.escalationWindowMinutes,
        relatedSessions: sessionId ? [sessionId] : [],
      });

      const astro = await User.findById(astrologerUserId).select('name phone');
      logger.warn('Astrologer escalation raised', { astrologer: String(astrologerUserId), count: fresh.length });
      emit.toAdmins('escalation-raised', {
        id: String(esc._id),
        astrologer: { id: String(astrologerUserId), name: astro && astro.name, phone: astro && astro.phone },
        missCount: fresh.length,
        reason: esc.reason,
      });
      // Live admin-console badge + bell.
      emit.adminActivity('escalation', { id: esc._id, title: `Escalation: ${astro && astro.name ? astro.name : 'astrologer'}` });
    }
    // Reset the window counter so we don't re-fire on every subsequent miss.
    await AstrologerProfile.updateOne({ _id: profile._id }, { $set: { recentMisses: [] } });
  }
}

async function list({ status = 'open', page = 1, limit = 20 } = {}) {
  const q = status ? { status } : {};
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    Escalation.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('astrologer', 'name phone'),
    Escalation.countDocuments(q),
  ]);
  return { items, total, page, limit };
}

async function resolve(id, adminId, note) {
  await Escalation.updateOne(
    { _id: id },
    { $set: { status: 'resolved', resolvedBy: adminId, resolvedAt: new Date(), adminNote: note } }
  );
}

module.exports = { recordMiss, list, resolve };
