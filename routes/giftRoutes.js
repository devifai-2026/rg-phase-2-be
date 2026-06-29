const express = require('express');
const ctrl = require('../controllers/giftController');
const validate = require('../middlewares/validate');
const v = require('../utils/validators');
const { protect, verifiedOnly } = require('../middlewares/auth');

const router = express.Router();

router.get('/', ctrl.list);
router.post('/send', protect, verifiedOnly, validate(v.sendGift), ctrl.send);
// Public: gifts an astrologer has received (aggregated by type).
router.get('/received/:id', ctrl.receivedForAstrologer);

module.exports = router;
