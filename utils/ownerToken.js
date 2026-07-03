const jwt = require('jsonwebtoken');
const env = require('../config/env');

/**
 * Platform-owner tokens. Signed with saas.ownerJwtSecret (separate from the
 * tenant JWT secret) so a leaked tenant secret can never mint an owner token,
 * and vice-versa. Owner accounts live in the control plane (OwnerUser).
 */
function signOwner(owner) {
  return jwt.sign(
    { id: String(owner._id), role: owner.role, kind: 'owner' },
    env.saas.ownerJwtSecret,
    { expiresIn: '12h' }
  );
}

function verifyOwner(token) {
  const claims = jwt.verify(token, env.saas.ownerJwtSecret);
  if (claims.kind !== 'owner') throw new Error('Not an owner token');
  return claims;
}

module.exports = { signOwner, verifyOwner };
