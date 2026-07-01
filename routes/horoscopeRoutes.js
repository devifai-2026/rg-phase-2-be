const express = require('express');
const ctrl = require('../controllers/horoscopeController');

const router = express.Router();

// Public: daily horoscope by zodiac sign. Generic per-sign content (not
// user-specific), so no auth — mirrors appConfigRoutes.
router.get('/', ctrl.getAll);          // all 12 signs
router.get('/:zodiac', ctrl.getDaily); // one sign

module.exports = router;
