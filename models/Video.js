const mongoose = require('mongoose');

/**
 * Admin-managed YouTube content shown on the app's Home in two horizontal rows:
 *  - kind 'video'  → the "Astrology Videos" strip
 *  - kind 'lesson' → the "Astrology Lessons" strip
 * Admin pastes a YouTube URL; we derive `youtubeId` and serve the auto thumbnail
 * (img.youtube.com) so there's no per-item upload. Each row can be hidden wholesale
 * via the section toggles in AppConfig.
 */
const videoSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['video', 'lesson'], default: 'video', index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    youtubeUrl: { type: String, required: true, trim: true },
    youtubeId: { type: String, required: true, index: true }, // 11-char video id
    thumbnail: { type: String }, // resolved auto thumbnail (img.youtube.com/...)
    isActive: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 }, // lower shows first
  },
  { timestamps: true }
);

videoSchema.index({ kind: 1, isActive: 1, sortOrder: 1 });

module.exports = mongoose.model('Video', videoSchema);
