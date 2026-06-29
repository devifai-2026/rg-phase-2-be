const jwt = require('jsonwebtoken');
const env = require('../config/env');

/** Sign a stateless access token carrying id/role/verification claims. */
function signAccess(user) {
  return jwt.sign(
    { id: String(user._id), role: user.role, isPhoneVerified: !!user.isPhoneVerified },
    env.jwt.secret,
    { expiresIn: env.jwt.accessTtl }
  );
}

/** Verify an access token; throws on invalid/expired. */
function verifyAccess(token) {
  return jwt.verify(token, env.jwt.secret);
}

module.exports = { signAccess, verifyAccess };
