/**
 * Canonical phone format across the platform: 91 + 10 digits (e.g. 919876543210).
 * Accepts any input (10-digit, +91-prefixed, spaces/dashes) and normalizes.
 */
function normalizePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  const last10 = digits.slice(-10); // strip any country code / leading zeros
  if (last10.length !== 10) return null; // invalid
  return `91${last10}`;
}

/** The bare 10-digit subscriber number (for display / WABridge). */
function last10(input) {
  const digits = String(input || '').replace(/\D/g, '');
  return digits.slice(-10);
}

/** Validate that an input yields a proper 10-digit Indian number. */
function isValidPhone(input) {
  return /^\d{10}$/.test(last10(input));
}

module.exports = { normalizePhone, last10, isValidPhone };
