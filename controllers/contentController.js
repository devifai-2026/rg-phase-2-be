const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { reqLang, localizeEach } = require('../utils/i18nReq');

// ── Public: paginated + searchable videos/lessons for the "See all" screen ──
// Same active/sort rules as the Home rail (GET /app-config), but paged + search.
// Respects the section visibility toggle: a disabled section returns nothing.
exports.listVideosPublic = asyncHandler(async (req, res) => {
  const AppConfig = req.model('AppConfig');
  const Video = req.model('Video');
  const kind = req.query.kind === 'lesson' ? 'lesson' : 'video';
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 30);

  // Honour the admin section toggle (sections.videos / sections.lessons).
  const cfg = await AppConfig.findOne({ key: 'global' }).lean();
  const sectionOn = !cfg || !cfg.sections || cfg.sections[`${kind}s`] !== false;
  if (!sectionOn) return res.json({ success: true, data: { items: [], total: 0, page, limit } });

  const q = { kind, isActive: true };
  const term = (req.query.q || '').trim();
  if (term) q.title = { $regex: term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };

  const [items, total] = await Promise.all([
    Video.find(q).sort({ sortOrder: 1, createdAt: -1 }).skip((page - 1) * limit).limit(limit)
      .select('title youtubeId youtubeUrl thumbnail').lean(),
    Video.countDocuments(q),
  ]);
  await localizeEach(items, reqLang(req), ['title']);
  res.json({ success: true, data: { items, total, page, limit } });
});

// ── Public: fetch CMS content the app displays (Contact Us, About, Terms...) ──
exports.get = asyncHandler(async (req, res) => {
  const SiteContent = req.model('SiteContent');
  const content = await SiteContent.findOne({ key: req.params.key, isPublished: true });
  if (!content) throw new AppError('Content not found', 404);
  res.json({ success: true, data: content });
});

exports.list = asyncHandler(async (req, res) => {
  const SiteContent = req.model('SiteContent');
  const items = await SiteContent.find({ isPublished: true }).select('key title updatedAt');
  res.json({ success: true, data: items });
});

// ── Admin: upsert content by key ──
exports.upsert = asyncHandler(async (req, res) => {
  const SiteContent = req.model('SiteContent');
  const { key } = req.params;
  const content = await SiteContent.findOneAndUpdate(
    { key },
    { $set: { title: req.body.title, body: req.body.body, data: req.body.data, isPublished: req.body.isPublished !== false } },
    { upsert: true, new: true }
  );
  res.json({ success: true, data: content });
});

exports.adminList = asyncHandler(async (req, res) => {
  const SiteContent = req.model('SiteContent');
  const items = await SiteContent.find().sort({ key: 1 });
  res.json({ success: true, data: items });
});
