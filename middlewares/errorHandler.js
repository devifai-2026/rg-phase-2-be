const AppError = require('../utils/AppError');
const logger = require('../utils/logger');
const env = require('../config/env');

/** Convert known Mongoose/Mongo errors to AppError-shaped responses. */
function normalize(err) {
  if (err instanceof AppError) return err;

  if (err.name === 'ValidationError') {
    const details = Object.values(err.errors).map((e) => e.message);
    return new AppError('Validation failed', 422, details);
  }
  if (err.name === 'CastError') {
    return new AppError(`Invalid ${err.path}: ${err.value}`, 400);
  }
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    return new AppError(`Duplicate value for ${field}`, 409);
  }
  return new AppError(err.message || 'Internal server error', err.statusCode || 500);
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const e = normalize(err);
  if (e.statusCode >= 500) {
    logger.error('Request failed', { path: req.originalUrl, method: req.method, msg: err.message, stack: env.isDev ? err.stack : undefined });
  }
  res.status(e.statusCode).json({
    success: false,
    message: e.message,
    ...(e.details ? { details: e.details } : {}),
  });
}

/** 404 fallthrough. */
function notFound(req, res, next) {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404));
}

module.exports = { errorHandler, notFound };
