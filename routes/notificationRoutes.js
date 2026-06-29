const express = require('express');
const ctrl = require('../controllers/notificationController');
const { protect } = require('../middlewares/auth');

const router = express.Router();

router.get('/', protect, ctrl.list);
router.post('/click', protect, ctrl.recordClick); // tap attribution for broadcasts
router.post('/delivered', protect, ctrl.recordDelivered); // device-confirmed delivery ACK
router.patch('/read-all', protect, ctrl.markAllRead);
router.patch('/:id/read', protect, ctrl.markRead);
router.delete('/', protect, ctrl.clearAll); // clear (delete) all
router.delete('/:id', protect, ctrl.remove); // delete one

module.exports = router;
