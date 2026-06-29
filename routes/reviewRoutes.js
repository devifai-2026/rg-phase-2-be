const express = require('express');
const ctrl = require('../controllers/reviewController');
const validate = require('../middlewares/validate');
const v = require('../utils/validators');
const { protect } = require('../middlewares/auth');

const router = express.Router();

// Platform / app reviews.
router.get('/platform', ctrl.listPlatformReviews);
router.post('/platform', protect, validate(v.platformReview), ctrl.submitPlatformReview);

module.exports = router;
