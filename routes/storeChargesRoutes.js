const express = require('express');
const ctrl = require('../controllers/storeChargesController');

const router = express.Router();

// Public — the app reads this to render the checkout bill.
router.get('/', ctrl.get);

module.exports = router;
