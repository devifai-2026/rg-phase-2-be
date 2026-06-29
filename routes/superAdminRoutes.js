const express = require('express');
const track = require('../controllers/trackController');
const notif = require('../controllers/notificationAdminController');
const { protect } = require('../middlewares/auth');
const { superAdminOnly } = require('../middlewares/role');

const router = express.Router();

// All super-admin endpoints are super_admin only.
router.use(protect, superAdminOnly);

router.get('/heatmap', track.heatmap);
router.get('/funnel', track.funnel);
router.get('/signup-funnel', track.signupFunnel);
router.get('/visitor/:anonId', track.visitor);

// ── Notifications: templates, bulk broadcasts, logs ──
router.get('/notifications/templates', notif.listTemplates);
router.put('/notifications/templates/:event', notif.updateTemplate);
router.post('/notifications/estimate', notif.estimate);
router.post('/notifications/broadcast', notif.sendBroadcast);
router.post('/notifications/broadcast/:id/retry', notif.retryBroadcast);
router.get('/notifications/log', notif.listLog);
router.get('/notifications/log/stats', notif.logStats);
// Delete logs: a filtered/all clear, and a single row by id.
router.delete('/notifications/log', notif.deleteLog);
router.delete('/notifications/log/:id', notif.deleteBroadcast);

module.exports = router;
