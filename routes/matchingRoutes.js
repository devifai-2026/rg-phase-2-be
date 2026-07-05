const express = require('express');
const ctrl = require('../controllers/matchingController');
const { protect } = require('../middlewares/auth');

const router = express.Router();

// Aggregate marriage matching — instant, no cron. Protected (both apps).
router.post('/', protect, ctrl.aggregateMatch);

module.exports = router;
