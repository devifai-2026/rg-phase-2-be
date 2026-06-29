const express = require('express');
const ctrl = require('../controllers/categoryController');
const validate = require('../middlewares/validate');
const v = require('../utils/validators');
const { protect } = require('../middlewares/auth');
const { adminOnly } = require('../middlewares/role');

const router = express.Router();

router.get('/', ctrl.list);
router.post('/', protect, adminOnly, validate(v.category), ctrl.create);
router.put('/:id', protect, adminOnly, validate(v.category), ctrl.update);
router.delete('/:id', protect, adminOnly, ctrl.remove);

module.exports = router;
