const mongoose = require('mongoose');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { reqLang, localizeEach } = require('../utils/i18nReq');

/**
 * App Configuration: promo banners, Home videos/lessons (YouTube), and the
 * section-visibility toggles. Admin endpoints manage them; public endpoints
 * feed the Flutter app's Home.
 */

// ── YouTube id extraction (watch, youtu.be, shorts, embed) ──
function youtubeId(url = '') {
  const s = String(url).trim();
  const m =
    s.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/) ||
    s.match(/^([A-Za-z0-9_-]{11})$/); // already a bare id
  return m ? m[1] : null;
}
function thumbFor(id) {
  // hqdefault always exists (maxresdefault doesn't for every video).
  return `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
}

// ─────────────────────────── Banners ───────────────────────────
exports.listBanners = asyncHandler(async (req, res) => {
  const Banner = req.model('Banner');
  const q = req.query.placement ? { placement: req.query.placement } : {};
  const items = await Banner.find(q).sort({ placement: 1, sortOrder: 1, createdAt: -1 });
  res.json({ success: true, data: items });
});

exports.createBanner = asyncHandler(async (req, res) => {
  const Banner = req.model('Banner');
  const { image } = req.body;
  if (!image) throw new AppError('A cropped banner image is required', 400);
  const item = await Banner.create(req.body);
  res.status(201).json({ success: true, data: item });
});

exports.updateBanner = asyncHandler(async (req, res) => {
  const Banner = req.model('Banner');
  const item = await Banner.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!item) throw new AppError('Banner not found', 404);
  res.json({ success: true, data: item });
});

exports.deleteBanner = asyncHandler(async (req, res) => {
  const Banner = req.model('Banner');
  await Banner.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

// Persist a drag-and-drop reorder: the admin sends the banner ids in their new
// display order (within one placement) and we assign sortOrder = 0,1,2,… so the
// order is distinct and deterministic (no more same-sortOrder ties). The app
// reads `sortOrder` ascending, so this is exactly the carousel order.
exports.reorderBanners = asyncHandler(async (req, res) => {
  const Banner = req.model('Banner');
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) throw new AppError('ids[] (ordered) is required', 400);
  const ops = ids
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id, index) => ({ updateOne: { filter: { _id: id }, update: { $set: { sortOrder: index } } } }));
  if (!ops.length) throw new AppError('No valid banner ids', 400);
  await Banner.bulkWrite(ops);
  res.json({ success: true, data: { reordered: ops.length } });
});

// ─────────────────────────── Videos / Lessons ───────────────────────────
exports.listVideos = asyncHandler(async (req, res) => {
  const Video = req.model('Video');
  const q = req.query.kind ? { kind: req.query.kind } : {};
  const items = await Video.find(q).sort({ kind: 1, sortOrder: 1, createdAt: -1 });
  res.json({ success: true, data: items });
});

exports.createVideo = asyncHandler(async (req, res) => {
  const Video = req.model('Video');
  const id = youtubeId(req.body.youtubeUrl);
  if (!id) throw new AppError('Enter a valid YouTube URL', 400);
  const item = await Video.create({
    kind: req.body.kind === 'lesson' ? 'lesson' : 'video',
    title: req.body.title,
    youtubeUrl: req.body.youtubeUrl,
    youtubeId: id,
    thumbnail: thumbFor(id),
    isActive: req.body.isActive !== false,
    sortOrder: req.body.sortOrder || 0,
  });
  res.status(201).json({ success: true, data: item });
});

exports.updateVideo = asyncHandler(async (req, res) => {
  const Video = req.model('Video');
  const patch = { ...req.body };
  if (req.body.youtubeUrl) {
    const id = youtubeId(req.body.youtubeUrl);
    if (!id) throw new AppError('Enter a valid YouTube URL', 400);
    patch.youtubeId = id;
    patch.thumbnail = thumbFor(id);
  }
  const item = await Video.findByIdAndUpdate(req.params.id, patch, { new: true, runValidators: true });
  if (!item) throw new AppError('Video not found', 404);
  res.json({ success: true, data: item });
});

exports.deleteVideo = asyncHandler(async (req, res) => {
  const Video = req.model('Video');
  await Video.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

// ─────────────────────────── Section toggles ───────────────────────────
exports.getConfig = asyncHandler(async (req, res) => {
  const AppConfig = req.model('AppConfig');
  const cfg = await AppConfig.get();
  res.json({ success: true, data: cfg });
});

exports.updateConfig = asyncHandler(async (req, res) => {
  const AppConfig = req.model('AppConfig');
  const cfg = await AppConfig.get();
  if (req.body.sections) {
    cfg.sections = { ...cfg.sections.toObject(), ...req.body.sections };
  }
  if (req.body.theme) {
    const t = cfg.theme.toObject();
    cfg.theme = {
      enabled: req.body.theme.enabled !== undefined ? !!req.body.theme.enabled : t.enabled,
      dark: { ...t.dark, ...(req.body.theme.dark || {}) },
      light: { ...t.light, ...(req.body.theme.light || {}) },
    };
  }
  if (req.body.splash) {
    cfg.splash = { ...cfg.splash.toObject(), ...req.body.splash };
  }
  await cfg.save();
  res.json({ success: true, data: cfg });
});

// ─────────────────────────── Public (app) ───────────────────────────
// One call the app makes on launch: active banners + visible videos/lessons +
// the section toggles, all respecting visibility and scheduling.
exports.publicConfig = asyncHandler(async (req, res) => {
  const AppConfig = req.model('AppConfig');
  const Banner = req.model('Banner');
  const Video = req.model('Video');
  const now = new Date();
  const cfg = await AppConfig.get();
  const sec = cfg.sections || {};

  // Active + in-schedule filter, reused for both placements.
  const scheduleMatch = {
    isActive: true,
    $and: [
      { $or: [{ scheduledFrom: null }, { scheduledFrom: { $lte: now } }, { scheduledFrom: { $exists: false } }] },
      { $or: [{ scheduledTo: null }, { scheduledTo: { $gte: now } }, { scheduledTo: { $exists: false } }] },
    ],
  };

  const [banners, poojaBanners, videos, lessons] = await Promise.all([
    sec.banners
      ? Banner.find({ ...scheduleMatch, placement: 'promo' }).sort({ sortOrder: 1, createdAt: -1 }).select('image link').lean()
      : [],
    sec.pooja
      ? Banner.find({ ...scheduleMatch, placement: 'pooja' }).sort({ sortOrder: 1, createdAt: -1 }).select('image link').lean()
      : [],
    sec.videos ? Video.find({ kind: 'video', isActive: true }).sort({ sortOrder: 1, createdAt: -1 }).select('title youtubeId youtubeUrl thumbnail').lean() : [],
    sec.lessons ? Video.find({ kind: 'lesson', isActive: true }).sort({ sortOrder: 1, createdAt: -1 }).select('title youtubeId youtubeUrl thumbnail').lean() : [],
  ]);

  // Theme: only ship token sets when the admin has enabled custom theming — the
  // app falls back to its compiled tokens otherwise (and per missing token).
  const themeObj = cfg.theme ? cfg.theme.toObject() : {};
  const theme = themeObj.enabled
    ? { enabled: true, dark: stripEmpty(themeObj.dark), light: stripEmpty(themeObj.light) }
    : { enabled: false };

  const splash = cfg.splash ? stripEmpty(cfg.splash.toObject()) : {};

  // Localize the Home rail video/lesson TITLES to the requester's language.
  const lang = reqLang(req);
  await Promise.all([
    localizeEach(videos, lang, ['title']),
    localizeEach(lessons, lang, ['title']),
  ]);

  res.json({ success: true, data: { appName: cfg.appName || '', sections: sec, banners, poojaBanners, videos, lessons, theme, splash } });
});

// Drop null/empty/undefined values so the app only overrides what's actually set.
function stripEmpty(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === '_id') continue;
    if (v === null || v === undefined || v === '') continue;
    out[k] = v;
  }
  return out;
}
