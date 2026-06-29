const AppError = require('../utils/AppError');

/** Restrict a route to one or more roles. Use after protect. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new AppError('Insufficient permissions', 403));
    }
    next();
  };
}

// super_admin implicitly has all admin powers.
const adminOnly = requireRole('admin', 'super_admin');
const superAdminOnly = requireRole('super_admin');
const astrologerOnly = requireRole('astrologer');

module.exports = { requireRole, adminOnly, superAdminOnly, astrologerOnly };
