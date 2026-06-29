const express = require('express');
const ctrl = require('../controllers/withdrawalController');
const validate = require('../middlewares/validate');
const v = require('../utils/validators');
const { protect } = require('../middlewares/auth');
const { astrologerOnly } = require('../middlewares/role');

const router = express.Router();

router.post('/', protect, astrologerOnly, validate(v.withdrawal), ctrl.request);
router.get('/', protect, astrologerOnly, ctrl.listMine);

module.exports = router;
