const express = require('express');
const ctrl = require('../controllers/panchangController');

const router = express.Router();

// Public: daily panchang by date + device location. Generic per day+place (not
// user-specific), so no auth — mirrors horoscopeRoutes / appConfigRoutes.
router.get('/', ctrl.getPanchang);

module.exports = router;
