const express = require('express');
const ctrl = require('../controllers/numerologyController');
const { protect } = require('../middlewares/auth');

const router = express.Router();

// Numerology for a name — instant, no cron. Protected (name is user-supplied and
// the app prefills the logged-in user's name), but not user-record-specific.
router.post('/', protect, ctrl.getNumerology);

module.exports = router;
