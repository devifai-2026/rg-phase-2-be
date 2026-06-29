const express = require('express');
const ctrl = require('../controllers/liveController');
const { protect, verifiedOnly } = require('../middlewares/auth');
const { astrologerOnly } = require('../middlewares/role');

const router = express.Router();

// ── Public discovery (user app Live tab) ──
router.get('/', ctrl.list);

// ── Astrologer: their own broadcast history (declare before '/:id' paths) ──
router.get('/mine', protect, astrologerOnly, ctrl.mine);

// ── Astrologer: start / stop a broadcast + auto AI poll ──
router.post('/go-live', protect, astrologerOnly, ctrl.goLive);
router.post('/:id/end', protect, astrologerOnly, ctrl.endLive);
router.post('/:id/poll', protect, astrologerOnly, ctrl.createPoll);

// AI recap of a past broadcast (generated once, cached in DB).
router.get('/:id/summary', protect, ctrl.summary);

// Full recap analytics for the astrologer (moderation scorecard + polls/tallies).
router.get('/:id/detail', protect, astrologerOnly, ctrl.detail);

// ── User: join as audience, leave, comment, vote ──
router.post('/:id/join', protect, ctrl.join);
router.post('/:id/leave', protect, ctrl.leave);
router.post('/:id/comment', protect, verifiedOnly, ctrl.comment);
router.post('/:id/poll/:pollId/vote', protect, verifiedOnly, ctrl.votePoll);

module.exports = router;
