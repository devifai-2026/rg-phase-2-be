const AppError = require('../utils/AppError');

/**
 * Validate a request part against a Joi schema.
 * validate(schema)              -> validates req.body
 * validate(schema, 'query')     -> validates req.query
 * validate(schema, 'params')    -> validates req.params
 */
function validate(schema, property = 'body') {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[property], {
      abortEarly: false,
      stripUnknown: true,
      convert: true,
    });
    if (error) {
      const details = error.details.map((d) => d.message.replace(/"/g, ''));
      return next(new AppError('Validation failed', 422, details));
    }
    req[property] = value;
    next();
  };
}

module.exports = validate;
