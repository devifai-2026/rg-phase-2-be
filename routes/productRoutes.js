const express = require('express');
const ctrl = require('../controllers/productController');
const validate = require('../middlewares/validate');
const v = require('../utils/validators');
const { protect } = require('../middlewares/auth');
const { adminOnly } = require('../middlewares/role');

const router = express.Router();

router.get('/', ctrl.list);
router.get('/:id', ctrl.get);
router.post('/', protect, adminOnly, validate(v.product), ctrl.create);
router.put('/:id', protect, adminOnly, ctrl.update);
router.delete('/:id', protect, adminOnly, ctrl.remove);
router.post('/:id/reviews', protect, validate(v.review), ctrl.addReview);

module.exports = router;
