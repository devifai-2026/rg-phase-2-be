const express = require('express');
const ctrl = require('../controllers/internalController');

const router = express.Router();

// Called by Cloud Scheduler (3am daily). Secret-protected in the controller.
router.post('/jobs/translate-backfill', ctrl.translateBackfill);
// Daily: deactivate poojas whose availability window has ended.
router.post('/jobs/deactivate-expired-poojas', ctrl.deactivateExpiredPoojas);

module.exports = router;
