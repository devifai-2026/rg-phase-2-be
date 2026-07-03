const { defaultContext } = require('../utils/tenantContext');
const vedicAstroService = require('./vedicAstroService');
const AppError = require('../utils/AppError');

function birthFromProfile(p) {
  return {
    dob: p.dob,
    tob: p.birthTime,
    lat: p.birthPlace && p.birthPlace.lat,
    lon: p.birthPlace && p.birthPlace.lng,
    tz: p.birthPlace && p.birthPlace.tz,
  };
}

async function match(ctx, profile1Id, profile2Id) {
  ctx = ctx || defaultContext();
  const KundliMatch = ctx.model('KundliMatch');
  const MatrimonyProfile = ctx.model('MatrimonyProfile');

  const [p1, p2] = await Promise.all([MatrimonyProfile.findById(profile1Id), MatrimonyProfile.findById(profile2Id)]);
  if (!p1 || !p2) throw new AppError('One or both profiles not found', 404);

  const record = await KundliMatch.create({ profile1: p1._id, profile2: p2._id, status: 'pending' });
  try {
    const result = await vedicAstroService.matchAshtakoot(ctx, birthFromProfile(p1), birthFromProfile(p2));
    const score = result.compatibilityScore;
    const verdict = score >= 28 ? 'Excellent' : score >= 18 ? 'Good' : score >= 12 ? 'Average' : 'Challenging';
    await KundliMatch.updateOne(
      { _id: record._id },
      { $set: { compatibilityScore: score, ashtakootDetails: result.ashtakootDetails, verdict, status: 'computed', computedAt: new Date() } }
    );
    return KundliMatch.findById(record._id);
  } catch (e) {
    await KundliMatch.updateOne({ _id: record._id }, { $set: { status: 'failed' } });
    throw e;
  }
}

module.exports = { match };
