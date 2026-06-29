const express = require('express');
const ctrl = require('../controllers/supportController');
const validate = require('../middlewares/validate');
const v = require('../utils/validators');
const { protect } = require('../middlewares/auth');

const router = express.Router();

// Users AND astrologers submit and view their own tickets.
router.post('/tickets', protect, validate(v.supportTicket), ctrl.create);
router.get('/tickets', protect, ctrl.listMine);
router.get('/tickets/:id', protect, ctrl.getMine);
router.post('/tickets/:id/reply', protect, validate(v.supportReply), ctrl.reply);

module.exports = router;
