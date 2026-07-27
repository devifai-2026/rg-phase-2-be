const express = require('express');
const ctrl = require('../controllers/aiController');
const astrology = require('../controllers/astrologyController');
const validate = require('../middlewares/validate');
const v = require('../utils/validators');
const { protect } = require('../middlewares/auth');
const { astrologerOnly } = require('../middlewares/role');
const { aiLimiter } = require('../middlewares/rateLimit');

const router = express.Router();

// ── AI astrologer (chart-grounded, billed per minute, chat only) ──────────
// Personas the seeker can pick in the AI Astro tab. systemPrompt is never sent.
router.get('/personas', protect, ctrl.listPersonas);
// Opening a chat is FREE; the first message starts the meter (aiChatService).
router.post('/chat/sessions', protect, ctrl.startChat);
router.post('/chat/sessions/:id/messages', protect, aiLimiter, ctrl.sendChatMessage);
router.post('/chat/sessions/:id/end', protect, ctrl.endChat);
// Resume: the in-progress consultation, so backgrounding the app never strands
// a session the seeker is still paying for. Must precede /chat/sessions/:id.
router.get('/chat/sessions/me/active', protect, ctrl.activeChatSession);
router.get('/chat/sessions', protect, ctrl.listChatSessions);
router.get('/chat/sessions/:id', protect, ctrl.getChatSession);
// One-shot life-area reading behind the home icons (Career, Marriage, ...).
// Not billed: a single generation, not a metered conversation.
router.post('/reading', protect, aiLimiter, ctrl.topicReading);

// Legacy single-shot AI chat (kept for the older app build; unbilled).
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
