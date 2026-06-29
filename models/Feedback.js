const mongoose = require('mongoose');

/** User-submitted feedback (from the drawer "Feedback" form). */
const feedbackSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }, // may be null if not logged in
    fullName: { type: String, trim: true, maxlength: 100 },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    message: { type: String, required: true, maxlength: 2000 },
    status: { type: String, enum: ['new', 'reviewed', 'resolved'], default: 'new', index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Feedback', feedbackSchema);
