const express = require('express');
const ctrl = require('../controllers/feedbackController');
const validate = require('../middlewares/validate');
const v = require('../utils/validators');
const { protect } = require('../middlewares/auth');

const router = express.Router();

router.post('/', protect, validate(v.feedback), ctrl.submitFeedback);
router.post('/rate', protect, validate(v.appRating), ctrl.rateApp);

module.exports = router;
