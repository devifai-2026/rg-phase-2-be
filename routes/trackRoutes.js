const express = require('express');
const ctrl = require('../controllers/trackController');
const { trackLimiter } = require('../middlewares/rateLimit');

const router = express.Router();

// Public first-party tracking ingestion — no auth, rate-limited.
router.post('/click', trackLimiter, ctrl.recordClicks);
router.post('/visit', trackLimiter, ctrl.recordVisit);
router.post('/duration', trackLimiter, ctrl.recordDuration);
router.post('/signup-event', trackLimiter, ctrl.recordSignupEvent);

module.exports = router;
