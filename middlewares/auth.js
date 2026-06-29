const { verifyAccess } = require('../utils/token');
const AppError = require('../utils/AppError');
const User = require('../models/User');

/** Require a valid access token; attaches req.user (lean) and req.auth (claims). */
async function protect(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new AppError('Authentication required', 401);

    let claims;
    try {
      claims = verifyAccess(token);
    } catch (e) {
      throw new AppError('Invalid or expired token', 401);
    }

    const user = await User.findById(claims.id);
    if (!user) throw new AppError('User no longer exists', 401);
    if (user.isBlocked) throw new AppError('Your account has been blocked by the admin. Please contact support for assistance.', 403);

    req.user = user;
    req.auth = claims;
    next();
  } catch (err) {
    next(err);
  }
}

/** Require the authenticated user to have a verified phone. */
function verifiedOnly(req, res, next) {
  if (!req.user || !req.user.isPhoneVerified) {
    return next(new AppError('Phone verification required', 403));
  }
  next();
}

module.exports = { protect, verifiedOnly };
