/**
 * Money helpers. RULE (per product owner): all money is stored and handled as
 * WHOLE RUPEES. No paise, no decimals, no other currency. ₹10 is stored as 10.
 *
 * Rates (call/chat/video) and every transaction amount are integer rupees/min
 * or integer rupees. The only place a sub-rupee representation appears is at the
 * PayU gateway boundary, which requires an "amount.00" string (see payuService).
 *
 * Duration billing rounds UP to the next whole minute (ceiling):
 *   30s -> 1 min, 60s -> 1 min, 63s -> 2 min.
 */

/** Coerce any incoming rupee value to a whole-rupee integer. */
function toRupees(value) {
  return Math.round(Number(value) || 0);
}

/** Ceiling minutes from elapsed seconds. 0s -> 0, 1s -> 1, 60s -> 1, 61s -> 2. */
function billedMinutes(durationSec) {
  return Math.ceil(Math.max(0, Number(durationSec)) / 60);
}

/** Display string, e.g. "₹120". Values are already whole rupees. */
function format(rupees) {
  return `₹${toRupees(rupees)}`;
}

module.exports = { toRupees, billedMinutes, format };
