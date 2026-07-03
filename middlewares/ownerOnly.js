const { verifyOwner } = require('../utils/ownerToken');
const AppError = require('../utils/AppError');

/**
 * Guards the platform-owner control-plane routes (/platform/*). Completely
 * separate from tenant auth (protect/role.js): owner accounts live in the
 * control-plane OwnerUser collection and use owner-signed tokens. This
 * middleware never touches a tenant DB.
 */
async function ownerProtect(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new AppError('Owner authentication required', 401);

    let claims;
    try {
      claims = verifyOwner(token);
    } catch (e) {
      throw new AppError('Invalid or expired owner token', 401);
    }

    const { OwnerUser } = require('../models/control');
    const owner = await OwnerUser.findById(claims.id);
    if (!owner || !owner.isActive) throw new AppError('Owner account unavailable', 401);

    req.owner = owner;
    next();
  } catch (err) {
    next(err);
  }
}

/** Require the top-level 'owner' role (vs 'staff') for destructive actions. */
function ownerRoleOnly(req, res, next) {
  if (!req.owner || req.owner.role !== 'owner') {
    return next(new AppError('Owner role required', 403));
  }
  next();
}

module.exports = { ownerProtect, ownerRoleOnly };
