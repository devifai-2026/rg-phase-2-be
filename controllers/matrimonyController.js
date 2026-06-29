const asyncHandler = require('../utils/asyncHandler');
const MatrimonyProfile = require('../models/MatrimonyProfile');
const kundliMatchService = require('../services/kundliMatchService');
const AppError = require('../utils/AppError');

exports.create = asyncHandler(async (req, res) => {
  const profile = await MatrimonyProfile.create({ ...req.body, user: req.user._id });
  res.status(201).json({ success: true, data: profile });
});

exports.listMine = asyncHandler(async (req, res) => {
  const items = await MatrimonyProfile.find({ user: req.user._id }).sort({ createdAt: -1 });
  res.json({ success: true, data: items });
});

exports.get = asyncHandler(async (req, res) => {
  const p = await MatrimonyProfile.findById(req.params.id);
  if (!p) throw new AppError('Profile not found', 404);
  res.json({ success: true, data: p });
});

exports.update = asyncHandler(async (req, res) => {
  const p = await MatrimonyProfile.findOneAndUpdate({ _id: req.params.id, user: req.user._id }, req.body, { new: true });
  if (!p) throw new AppError('Profile not found', 404);
  res.json({ success: true, data: p });
});

exports.remove = asyncHandler(async (req, res) => {
  await MatrimonyProfile.findOneAndDelete({ _id: req.params.id, user: req.user._id });
  res.json({ success: true });
});

exports.search = asyncHandler(async (req, res) => {
  const { gender, maritalStatus, religion, page = '1', limit = '20' } = req.query;
  const q = { isActive: true };
  if (gender) q.gender = gender;
  if (maritalStatus) q.maritalStatus = maritalStatus;
  if (religion) q.religion = religion;
  const p = parseInt(page, 10);
  const l = Math.min(parseInt(limit, 10), 100);
  const [items, total] = await Promise.all([
    MatrimonyProfile.find(q).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l),
    MatrimonyProfile.countDocuments(q),
  ]);
  res.json({ success: true, data: { items, total, page: p, limit: l } });
});

exports.match = asyncHandler(async (req, res) => {
  const data = await kundliMatchService.match(req.body.profile1, req.body.profile2);
  res.json({ success: true, data });
});
