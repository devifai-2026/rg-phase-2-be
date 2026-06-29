/**
 * Wraps an async route handler so rejected promises flow to errorHandler.
 * Usage: router.get('/', asyncHandler(async (req, res) => { ... }))
 */
module.exports = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
