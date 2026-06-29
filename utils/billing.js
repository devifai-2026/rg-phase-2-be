const { billedMinutes } = require('./money');

/**
 * Split math for a per-minute session.
 *
 * Per the business rule: admin commission is an ABSOLUTE per-minute amount,
 * not a percentage. For each charged minute:
 *   userPays        = ratePerMin
 *   adminEarning    = adminCutPerMin
 *   astrologerShare = ratePerMin - adminCutPerMin
 *
 * All values are paise on whole-rupee boundaries.
 *
 * @param {number} ratePerMin     paise/min the user pays
 * @param {number} adminCutPerMin paise/min that goes to the admin/platform
 * @param {number} minutes        number of charged minutes
 */
function splitForMinutes(ratePerMin, adminCutPerMin, minutes) {
  const safeMinutes = Math.max(0, Math.floor(minutes));
  const total = ratePerMin * safeMinutes;
  const admin = adminCutPerMin * safeMinutes;
  const astrologer = (ratePerMin - adminCutPerMin) * safeMinutes;
  return { minutes: safeMinutes, total, admin, astrologer };
}

/** Same split but for a single minute (used by the per-minute billing tick). */
function splitForOneMinute(ratePerMin, adminCutPerMin) {
  return {
    total: ratePerMin,
    admin: adminCutPerMin,
    astrologer: ratePerMin - adminCutPerMin,
  };
}

/** Final settlement from elapsed seconds — ceiling minutes are authoritative. */
function settle(ratePerMin, adminCutPerMin, durationSec) {
  return splitForMinutes(ratePerMin, adminCutPerMin, billedMinutes(durationSec));
}

module.exports = { splitForMinutes, splitForOneMinute, settle };
