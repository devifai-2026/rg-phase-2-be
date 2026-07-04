const asyncHandler = require('../utils/asyncHandler');
const supportService = require('../services/supportService');

// ── User / astrologer ──
exports.create = asyncHandler(async (req, res) => {
  const data = await supportService.createTicket(req.ctx, {
    userId: req.user._id,
    role: req.user.role,
    category: req.body.category,
    subject: req.body.subject,
    description: req.body.description,
    attachments: req.body.attachments,
  });
  res.status(201).json({ success: true, data });
});

exports.listMine = asyncHandler(async (req, res) => {
  const data = await supportService.listMine(req.ctx, req.user._id, {
    page: parseInt(req.query.page || '1', 10),
    limit: Math.min(parseInt(req.query.limit || '20', 10), 100),
  });
  res.json({ success: true, data });
});

exports.getMine = asyncHandler(async (req, res) => {
  const data = await supportService.getMine(req.ctx, req.user._id, req.params.id);
  res.json({ success: true, data });
});

exports.reply = asyncHandler(async (req, res) => {
  const data = await supportService.reply(req.ctx, {
    ticketId: req.params.id,
    senderId: req.user._id,
    fromRole: req.user.role,
    message: req.body.message,
    isAdmin: req.user.role === 'admin',
  });
  res.json({ success: true, data });
});

// ── Admin ──
exports.adminList = asyncHandler(async (req, res) => {
  const data = await supportService.adminList(req.ctx, {
    status: req.query.status,
    page: parseInt(req.query.page || '1', 10),
    limit: Math.min(parseInt(req.query.limit || '20', 10), 100),
  });
  res.json({ success: true, data });
});

exports.setStatus = asyncHandler(async (req, res) => {
  const data = await supportService.setStatus(req.ctx, { ticketId: req.params.id, status: req.body.status, adminId: req.user._id });
  res.json({ success: true, data });
});
