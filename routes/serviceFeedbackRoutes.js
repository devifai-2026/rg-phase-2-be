const express = require('express');
const ctrl = require('../controllers/serviceFeedbackController');
const { protect } = require('../middlewares/auth');
const { astrologerOnly } = require('../middlewares/role');

const router = express.Router();

// Astrologer-authored feedback after a delivered service/live ends.
router.post('/', protect, astrologerOnly, ctrl.submit);

module.exports = router;
