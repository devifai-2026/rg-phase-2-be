const asyncHandler = require('../utils/asyncHandler');
const enquiryService = require('../services/enquiryService');
const trackService = require('../services/trackService');

// ── public ──
exports.create = asyncHandler(async (req, res) => {
  const { name, email, phone, subject, message, anonId } = req.body;
  const data = await enquiryService.create({
    name,
    email,
    phone,
    subject,
    message,
    anonId,
    source: 'landing',
    ip: req.ip,
    userAgent: req.headers['user-agent'] || '',
  });
  // stitch this anonId's visits to an 'enquiry' conversion (fire-and-forget)
  if (anonId) trackService.attributeConversion(anonId, 'enquiry');
  res.status(201).json({ success: true, data, message: "Thanks — we'll get back to you soon." });
});

// ── admin ──
exports.list = asyncHandler(async (req, res) => {
  const data = await enquiryService.list({
    page: parseInt(req.query.page || '1', 10),
    limit: Math.min(parseInt(req.query.limit || '20', 10), 100),
    status: req.query.status,
  });
  res.json({ success: true, data });
});

exports.getOne = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await enquiryService.getOne(req.params.id) });
});

exports.update = asyncHandler(async (req, res) => {
  const data = await enquiryService.update(req.params.id, req.body, req.user._id);
  res.json({ success: true, data });
});
