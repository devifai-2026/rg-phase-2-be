const multer = require('multer');
const AppError = require('../utils/AppError');

// Files are kept in memory and forwarded to ImageBB (see uploadService).
const storage = multer.memoryStorage();

function imageFilter(req, file, cb) {
  if (/^image\/(jpe?g|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
  else cb(new AppError('Only image files are allowed', 400));
}

const upload = multer({
  storage,
  fileFilter: imageFilter,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
});

module.exports = { upload };
