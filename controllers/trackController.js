const asyncHandler = require('../utils/asyncHandler');
const trackService = require('../services/trackService');

// ── public ingestion ──
exports.recordClicks = asyncHandler(async (req, res) => {
  const n = await trackService.recordClicks({
    anonId: req.body.anonId,
    clicks: req.body.clicks,
    ua: req.headers['user-agent'] || '',
  });
  res.status(201).json({ success: true, data: { recorded: n } });
});

exports.recordVisit = asyncHandler(async (req, res) => {
  await trackService.recordVisit({ body: req.body || {}, ua: req.headers['user-agent'] || '', ip: req.ip });
  res.status(201).json({ success: true });
});

exports.recordDuration = asyncHandler(async (req, res) => {
  await trackService.recordDuration({ anonId: req.body.anonId, durationSec: req.body.durationSec });
  res.status(201).json({ success: true });
});

exports.recordSignupEvent = asyncHandler(async (req, res) => {
  const ok = await trackService.recordSignupEvent({
    anonId: req.body.anonId,
    form: req.body.form,
    step: req.body.step,
    detail: req.body.detail,
    ip: req.ip,
  });
  if (!ok) return res.status(400).json({ success: false, message: 'Invalid step' });
  res.status(201).json({ success: true });
});

// ── super_admin analytics ──
exports.heatmap = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await trackService.heatmap(req.query) });
});

exports.funnel = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await trackService.funnel(req.query) });
});

exports.signupFunnel = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await trackService.signupFunnel(req.query) });
});

exports.visitor = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await trackService.visitor(req.params.anonId) });
});
