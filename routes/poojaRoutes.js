const express = require('express');
const ctrl = require('../controllers/poojaController');
const validate = require('../middlewares/validate');
const v = require('../utils/validators');
const { protect, verifiedOnly } = require('../middlewares/auth');

const router = express.Router();

// Catalog (app): browse poojas + categories. Auth so only app users hit it.
router.get('/categories', protect, ctrl.listCategories);
router.get('/all', protect, ctrl.listAll); // every available pooja (default "All" tab)
router.get('/types', protect, ctrl.listTypes);
router.get('/types/:id', protect, ctrl.getType);

router.post('/bookings', protect, verifiedOnly, validate(v.poojaBooking), ctrl.create);
router.get('/bookings', protect, ctrl.listMine);
router.get('/bookings/:id', protect, ctrl.get);
router.patch('/bookings/:id/status', protect, ctrl.updateStatus);

module.exports = router;
