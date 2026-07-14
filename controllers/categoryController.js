const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { reqLang, localizeEach } = require('../utils/i18nReq');

exports.list = asyncHandler(async (req, res) => {
  const Category = req.model('Category');
  const q = req.query.all === 'true' ? {} : { isActive: true };
  // .lean() so names can be localized in place for the requester's language.
  const items = await Category.find(q).sort({ name: 1 }).lean();
  await localizeEach(items, reqLang(req), ['name'], req.ctx);
  res.json({ success: true, data: items });
});

exports.create = asyncHandler(async (req, res) => {
  const Category = req.model('Category');
  const cat = await Category.create(req.body);
  res.status(201).json({ success: true, data: cat });
});

exports.update = asyncHandler(async (req, res) => {
  const Category = req.model('Category');
  const cat = await Category.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!cat) throw new AppError('Category not found', 404);
  res.json({ success: true, data: cat });
});

exports.remove = asyncHandler(async (req, res) => {
  const Category = req.model('Category');
  await Category.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});
