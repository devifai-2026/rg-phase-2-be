const crypto = require('crypto');

/** SHA-256 hex digest of a string (used for refresh tokens, cache keys). */
function sha256(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

/** SHA-512 hex digest (PayU hashing). */
function sha512(input) {
  return crypto.createHash('sha512').update(String(input)).digest('hex');
}

/** Cryptographically strong random hex string. */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** Random integer in [min, max] inclusive — used for OTP and Agora UID. */
function randomInt(min, max) {
  return crypto.randomInt(min, max + 1);
}

/** Stable hash for a normalized object (sorted keys) — astro cache keys. */
function hashObject(obj) {
  const normalized = JSON.stringify(obj, Object.keys(obj).sort());
  return sha256(normalized);
}

module.exports = { sha256, sha512, randomToken, randomInt, hashObject };
