const ServiceFeedback = require('../models/ServiceFeedback');
const Session = require('../models/Session');
const LiveSession = require('../models/LiveSession');
const AstrologerProfile = require('../models/AstrologerProfile');
const AppError = require('../utils/AppError');

/**
 * Astrologer-authored feedback after a delivered service/live. Submit upserts
 * (one per source doc), and the admin list powers the "Admin Feedback" tab.
 */

const RATING_FIELDS = ['overall', 'connectionQuality', 'seekerBehaviour'];

function _clampRating(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 1 || n > 5) return undefined;
  return n;
}

/**
 * Submit (or overwrite) the astrologer's feedback for a session or live.
 * @param {{ astrologerUserId, kind:'session'|'live', sourceId, ratings, comment }}
 */
async function submit({ astrologerUserId, kind, sourceId, ratings = {}, comment = '' }) {
  if (!['session', 'live'].includes(kind)) throw new AppError('Invalid feedback kind', 400);
  if (!sourceId) throw new AppError('Source id required', 400);

  // Resolve + ownership-check the source doc, and derive serviceType.
  let serviceType;
  let session;
  let liveSession;
  if (kind === 'session') {
    const s = await Session.findById(sourceId).select('astrologer type').lean();
    if (!s) throw new AppError('Session not found', 404);
    if (String(s.astrologer) !== String(astrologerUserId)) throw new AppError('Not your session', 403);
    serviceType = s.type; // chat | call | video
    session = s._id || sourceId;
  } else {
    const ls = await LiveSession.findById(sourceId).select('astrologer').lean();
    if (!ls) throw new AppError('Live session not found', 404);
    if (String(ls.astrologer) !== String(astrologerUserId)) throw new AppError('Not your broadcast', 403);
    serviceType = 'live';
    liveSession = ls._id || sourceId;
  }

  const profile = await AstrologerProfile.findOne({ user: astrologerUserId }).select('_id').lean();

  const set = {
    astrologer: astrologerUserId,
    astrologerProfile: profile ? profile._id : undefined,
    kind,
    serviceType,
    comment: String(comment || '').slice(0, 1000),
  };
  if (session) set.session = session;
  if (liveSession) set.liveSession = liveSession;
  for (const f of RATING_FIELDS) {
    const r = _clampRating(ratings[f]);
    if (r !== undefined) set[f] = r;
  }

  // Upsert keyed on the source doc so re-submitting overwrites.
  const filter = kind === 'session'
    ? { astrologer: astrologerUserId, session }
    : { astrologer: astrologerUserId, liveSession };
  const doc = await ServiceFeedback.findOneAndUpdate(
    filter,
    { $set: set },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return doc;
}

/**
 * Admin list with filters + pagination + a small aggregate summary (averages per
 * dimension + per serviceType counts) for the Admin Feedback tab.
 * @param {{ page, limit, serviceType, kind, astrologerId, minRating, from, to, q }}
 */
async function adminList({ page = 1, limit = 20, serviceType, kind, astrologerId, minRating, from, to } = {}) {
  const q = {};
  if (kind && ['session', 'live'].includes(kind)) q.kind = kind;
  if (serviceType && ['chat', 'call', 'video', 'live'].includes(serviceType)) q.serviceType = serviceType;
  if (astrologerId) q.astrologer = astrologerId;
  const min = _clampRating(minRating);
  if (min) q.overall = { $gte: min };
  if (from || to) {
    q.createdAt = {};
    if (from) q.createdAt.$gte = new Date(from);
    if (to) q.createdAt.$lte = new Date(to);
  }

  const skip = (Math.max(1, page) - 1) * limit;
  const [items, total, agg] = await Promise.all([
    ServiceFeedback.find(q)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('astrologer', 'name phone')
      .populate('astrologerProfile', 'displayName avatar')
      .populate('session', 'type durationSec seekerAlias startedAt endedAt')
      .populate('liveSession', 'title topic peakViewers startedAt endedAt')
      .lean(),
    ServiceFeedback.countDocuments(q),
    ServiceFeedback.aggregate([
      { $match: q },
      {
        $group: {
          _id: null,
          avgOverall: { $avg: '$overall' },
          avgConnection: { $avg: '$connectionQuality' },
          avgSeeker: { $avg: '$seekerBehaviour' },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const summary = agg[0]
    ? {
        avgOverall: agg[0].avgOverall ? Math.round(agg[0].avgOverall * 10) / 10 : null,
        avgConnection: agg[0].avgConnection ? Math.round(agg[0].avgConnection * 10) / 10 : null,
        avgSeekerBehaviour: agg[0].avgSeeker ? Math.round(agg[0].avgSeeker * 10) / 10 : null,
        count: agg[0].count,
      }
    : { avgOverall: null, avgConnection: null, avgSeekerBehaviour: null, count: 0 };

  return { items, total, page: Math.max(1, page), limit, summary };
}

module.exports = { submit, adminList };
