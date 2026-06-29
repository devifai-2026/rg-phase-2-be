const express = require('express');
const ctrl = require('../controllers/aiController');
const astrology = require('../controllers/astrologyController');
const validate = require('../middlewares/validate');
const v = require('../utils/validators');
const { protect } = require('../middlewares/auth');
const { astrologerOnly } = require('../middlewares/role');

const router = express.Router();

// AI astrologer chat
router.post('/chat', protect, validate(v.aiChat), ctrl.chat);
router.get('/conversations', protect, ctrl.listConversations);
router.get('/conversations/:id', protect, ctrl.getConversation);

// Vedic readings (uses user's birthDetails, or pass body override)
router.post('/chart', protect, astrology.chart);
router.post('/kundli', protect, astrology.kundli);
router.post('/lal-kitab', protect, astrology.lalKitab);

// ── Chat-end recaps (Feature 1) ──
// Astrologer review/approval queue.
router.get('/recaps', protect, astrologerOnly, ctrl.listRecaps);
router.get('/recaps/:id', protect, astrologerOnly, ctrl.getRecap);
router.patch('/recaps/:id', protect, astrologerOnly, ctrl.editRecap);
router.post('/recaps/:id/approve', protect, astrologerOnly, ctrl.approveRecap);
router.post('/recaps/:id/reject', protect, astrologerOnly, ctrl.rejectRecap);
// User: published recap for one of their sessions (shown in chat history).
router.get('/sessions/:sessionId/recap', protect, ctrl.userRecap);

// ── Profile Optimizer (Feature 3) ──
router.post('/optimize-profile', protect, astrologerOnly, ctrl.optimizeProfile);
router.get('/optimize-profile/usage', protect, astrologerOnly, ctrl.optimizerUsage);

module.exports = router;
