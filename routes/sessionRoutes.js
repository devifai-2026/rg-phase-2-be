const express = require('express');
const ctrl = require('../controllers/sessionController');
const validate = require('../middlewares/validate');
const v = require('../utils/validators');
const reviewCtrl = require('../controllers/reviewController');
const { protect, verifiedOnly } = require('../middlewares/auth');
const { astrologerOnly } = require('../middlewares/role');

const router = express.Router();

/**
 * @openapi
 * /api/sessions/start:
 *   post:
 *     tags: [Sessions]
 *     summary: Start a call/chat/video session (rings astrologer for 60s)
 */
router.post('/start', protect, verifiedOnly, validate(v.startSession), ctrl.start);

router.post('/:sessionId/accept', protect, astrologerOnly, ctrl.accept);
router.post('/:sessionId/reject', protect, astrologerOnly, ctrl.reject);
// User cancels their own still-ringing request (HTTP fallback for the socket).
router.post('/:sessionId/cancel', protect, ctrl.cancel);
router.post('/:sessionId/end', protect, ctrl.end);
// Currently-live session to RESUME after an app kill (must precede '/:sessionId'
// so 'me' isn't captured as a sessionId).
router.get('/me/active', protect, ctrl.active);
router.get('/:sessionId/token', protect, ctrl.token);
// Paginated chat history for a session (loads prior messages on open).
router.get('/:sessionId/messages', protect, ctrl.messages);
// What the post-session dialog should ask (astrologer review hidden once already
// reviewed; call-quality for audio/video). Must precede the '/:sessionId' route.
router.get('/:sessionId/reviewable', protect, reviewCtrl.reviewableState);
// User reviews the astrologer (one per user+astrologer) + per-session call quality.
router.post('/:sessionId/review', protect, validate(v.review), reviewCtrl.reviewSession);
router.get('/:sessionId', protect, ctrl.detail);
router.get('/', protect, ctrl.history);

module.exports = router;
