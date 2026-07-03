const jwt = require('jsonwebtoken');
const env = require('../config/env');

/**
 * Sign a stateless access token carrying id/role/verification claims.
 * In multi-tenant mode the caller passes the tenant slug so the token itself
 * identifies the tenant (the 3rd tenantResolver fallback, after header/subdomain).
 * Omitting `tenantSlug` keeps the legacy single-tenant token shape.
 */
function signAccess(user, tenantSlug) {
  const claims = { id: String(user._id), role: user.role, isPhoneVerified: !!user.isPhoneVerified };
  if (tenantSlug) claims.tenantSlug = tenantSlug;
  return jwt.sign(claims, env.jwt.secret, { expiresIn: env.jwt.accessTtl });
}

/** Verify an access token; throws on invalid/expired. */
function verifyAccess(token) {
  return jwt.verify(token, env.jwt.secret);
}

module.exports = { signAccess, verifyAccess };
