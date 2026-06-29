const express = require('express');
const ctrl = require('../controllers/cartController');
const { protect } = require('../middlewares/auth');

const router = express.Router();

// All cart routes require a logged-in user.
router.get('/', protect, ctrl.get);
router.post('/items', protect, ctrl.addItem);
router.patch('/items/:productId', protect, ctrl.updateItem);
router.delete('/items/:productId', protect, ctrl.removeItem);
router.delete('/', protect, ctrl.clear);

module.exports = router;
