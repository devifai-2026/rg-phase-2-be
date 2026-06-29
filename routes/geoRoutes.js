const express = require('express');
const ctrl = require('../controllers/geoController');
const { protect } = require('../middlewares/auth');

const router = express.Router();

// Place-of-birth autocomplete (auth'd; used during onboarding).
router.get('/places', protect, ctrl.searchPlaces);
// Reverse-geocode device lat/lng → city (used after location permission).
router.get('/reverse', protect, ctrl.reverseGeocode);

module.exports = router;
