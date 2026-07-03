const asyncHandler = require('../utils/asyncHandler');

/** Submit feedback (drawer form). */
exports.submitFeedback = asyncHandler(async (req, res) => {
  const Feedback = req.model('Feedback');
  const doc = await Feedback.create({
    user: req.user?._id,
    fullName: req.body.fullName,
    email: req.body.email,
    phone: req.body.phone,
    message: req.body.message,
  });
  res.status(201).json({ success: true, data: doc, message: 'Thanks for your feedback!' });
});

/** Rate the app (one per user, upserts). */
exports.rateApp = asyncHandler(async (req, res) => {
  const AppRating = req.model('AppRating');
  const doc = await AppRating.findOneAndUpdate(
    { user: req.user._id },
    { $set: { rating: req.body.rating, review: req.body.review || '' } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  res.status(201).json({ success: true, data: doc, message: 'Thanks for rating us!' });
});

// ── Admin: list feedback (filter by status) + app ratings (+ avg) ──
exports.adminListFeedback = asyncHandler(async (req, res) => {
  const Feedback = req.model('Feedback');
  const q = req.query.status ? { status: req.query.status } : {};
  const page = parseInt(req.query.page || '1', 10);
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);
  const [items, total] = await Promise.all([
    Feedback.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('user', 'name phone'),
    Feedback.countDocuments(q),
  ]);
  res.json({ success: true, data: { items, total, page, limit } });
});

exports.adminUpdateFeedback = asyncHandler(async (req, res) => {
  const Feedback = req.model('Feedback');
  const doc = await Feedback.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true });
  res.json({ success: true, data: doc });
});

exports.adminListRatings = asyncHandler(async (req, res) => {
  const AppRating = req.model('AppRating');
  const page = parseInt(req.query.page || '1', 10);
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);
  const [items, total, agg] = await Promise.all([
    AppRating.find().sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('user', 'name phone'),
    AppRating.countDocuments(),
    AppRating.aggregate([{ $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } }]),
  ]);
  const summary = agg[0] || { avg: 0, count: 0 };
  res.json({ success: true, data: { items, total, page, limit, avg: Math.round((summary.avg || 0) * 10) / 10, count: summary.count } });
});
